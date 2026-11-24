"""The node side of the node-settings rollout (k4all v2.7.0, #60).

The k4all-operator writes the kubelet fields of ClusterConfig spec.nodes into
kube-system/kubelet-config, with the whole node-level desired state (hash,
hugepages, IOMMU) in its annotation k4all.magesgate.com/node-settings. It
drains the node when the change needs it, then writes
node-settings-target: <hash> on the Node. `k4all-upgrade agent` pulls the
kubelet config with kubeadm, resets the CPU manager state when its policy or
reserved CPUs change, sets the kernel arguments k4all owns, restarts kubelet
or reboots, and answers with node-settings-applied once kubelet is Ready.
"""

import json

import pytest
import yaml

from conftest import FakeHost, Proc, ku, run_cli

TARGET = ku.ANNOTATION_NS_TARGET
APPLIED = ku.ANNOTATION_NS_APPLIED
MESSAGE = ku.ANNOTATION_NS_MESSAGE

BASE_KUBELET = {"apiVersion": "kubelet.config.k8s.io/v1beta1",
                "kind": "KubeletConfiguration", "maxPods": 250,
                "cgroupDriver": "systemd"}
BOOT_KARGS = ["BOOT_IMAGE=(hd0,gpt3)/boot/ostree/default-1/vmlinuz",
              "rw", "ostree=/ostree/boot.1/default/1/0", "root=UUID=abcd",
              "console=ttyS0"]
CPU_STATE = "/var/lib/kubelet/cpu_manager_state"
MEMORY_STATE = "/var/lib/kubelet/memory_manager_state"


class SettingsHost(FakeHost):
    """A k4all node with kubeadm's kubelet-config, rpm-ostree kargs and the
    kubelet's CPU/memory manager state files."""

    def __init__(self, root, **kwargs):
        kwargs.setdefault("version", "v2.7.0")
        kwargs.setdefault("kubernetes", "1.36.6")
        kwargs.setdefault("role", "worker")
        super().__init__(root, **kwargs)
        self.kubelet_cm = {"data": {"kubelet": yaml.safe_dump(BASE_KUBELET)},
                           "annotations": {}}
        self.booted_kargs = list(BOOT_KARGS)
        self.pending_kargs = None   # the deployment rpm-ostree kargs made
        self.vendor = "GenuineIntel"
        self.boot = 1
        self.boot_drops_pending = False   # the bootloader boots the old one
        self.ready_after_restart = True
        self.restarts = 0
        self.after_pull = None      # callable run after kubeadm wrote config.yaml
        self.on_kargs = None        # callable run when rpm-ostree changes kargs
        self.cm_reads = 0
        self.write("/var/lib/kubelet/config.yaml", yaml.safe_dump(BASE_KUBELET))
        self._write_proc()

    def _write_proc(self):
        self.write(ku.PROC_CMDLINE, " ".join(self.booted_kargs) + "\n")
        self.write(ku.BOOT_ID_FILE, "boot-%d\n" % self.boot)
        self.write(ku.PROC_CPUINFO, "processor\t: 0\nvendor_id\t: %s\n"
                   "model name\t: a CPU\n\nprocessor\t: 1\nvendor_id\t: %s\n"
                   % (self.vendor, self.vendor))

    def set_vendor(self, vendor):
        self.vendor = vendor
        self._write_proc()

    def next_kargs(self):
        """What the next boot gets: rpm-ostree kargs shows the pending
        deployment when there is one, else the booted one."""
        return list(self.pending_kargs if self.pending_kargs is not None
                    else self.booted_kargs)

    def reboot_now(self):
        super().reboot_now()
        if self.pending_kargs is not None and not self.boot_drops_pending:
            self.booted_kargs = self.pending_kargs
        self.pending_kargs = None
        self.boot += 1
        self._write_proc()

    def _dispatch(self, argv, input_text):
        if argv[:2] == ["rpm-ostree", "kargs"]:
            return self._rpm_ostree_kargs(argv[2:])
        if argv[:3] == ["systemctl", "restart", "kubelet"]:
            self.restarts += 1
            self.kubelet_running = True
            self.node_is_ready = self.ready_after_restart
            return Proc()
        return super()._dispatch(argv, input_text)

    def _rpm_ostree_kargs(self, args):
        if not args:
            return Proc(" ".join(self.next_kargs()) + "\n")
        existing = self.next_kargs()
        kargs = list(existing)
        opts = {"--delete": [], "--append": [], "--append-if-missing": [],
                "--delete-if-present": []}
        for arg in args:
            name, _, value = arg.partition("=")
            assert name in opts, "unexpected rpm-ostree kargs option %s" % arg
            opts[name].append(value)
        # the order of rpm-ostree's kernel_arg_apply_patching
        for value in opts["--delete"]:
            if value not in kargs:
                return Proc(returncode=1, stderr="error: No karg '%s' found" % value)
            kargs.remove(value)
        kargs += opts["--append"]
        for value in opts["--append-if-missing"]:
            if value not in kargs:
                kargs.append(value)
        for value in opts["--delete-if-present"]:
            if value in existing:
                kargs.remove(value)
        if self.on_kargs:
            self.on_kargs(kargs)
        self.pending_kargs = kargs
        return Proc()

    def _kubeadm(self, cmd, args):
        if args == ["upgrade", "node", "phase", "kubelet-config"]:
            self.write("/var/lib/kubelet/config.yaml", self.kubelet_cm["data"]["kubelet"])
            if self.after_pull:
                self.after_pull()
            return Proc("[upgrade/kubelet-config] The kubelet configuration for "
                        "this node was successfully upgraded!\n")
        return super()._kubeadm(cmd, args)

    def _kubectl(self, args, input_text, kubeconfig=""):
        if args[:5] == ["-n", "kube-system", "get", "configmap", "kubelet-config"]:
            self.cm_reads += 1
            return Proc(json.dumps({
                "apiVersion": "v1", "kind": "ConfigMap",
                "metadata": {"name": "kubelet-config", "namespace": "kube-system",
                             "annotations": dict(self.kubelet_cm["annotations"])},
                "data": dict(self.kubelet_cm["data"])}))
        return super()._kubectl(args, input_text, kubeconfig)

    # --- what the operator writes --------------------------------------
    def operator_sets(self, hash_, kubelet=None, hugepages=None, iommu=False,
                      target=True):
        """kubelet-config as the operator writes it for hash_, and the
        node-settings-target on this Node."""
        config = dict(BASE_KUBELET)
        config.update(kubelet or {})
        self.kubelet_cm["data"]["kubelet"] = yaml.safe_dump(config)
        record = {"hash": hash_, "kubelet": kubelet or {},
                  "history": {}, "lastDone": "2026-11-24T10:00:00Z"}
        if hugepages:
            record["hugepages"] = hugepages
        if iommu:
            record["iommu"] = True
        self.kubelet_cm["annotations"][ku.NODE_SETTINGS_ANNOTATION] = json.dumps(record)
        if target:
            self.annotations[TARGET] = hash_

    def record(self):
        if not self.exists(ku.NODE_SETTINGS_FILE):
            return None
        return json.loads(self.read(ku.NODE_SETTINGS_FILE))

    def kubelet_config(self):
        return yaml.safe_load(self.read("/var/lib/kubelet/config.yaml"))


@pytest.fixture
def host(tmp_path):
    return SettingsHost(tmp_path / "root")


def agent(host):
    return run_cli(host, "agent")


def calls(host, prefix):
    return [c for c in host.calls if c[:len(prefix)] == prefix]


def karg_edits(host):
    """rpm-ostree kargs calls that change something (not the listing)."""
    return [c for c in calls(host, ["rpm-ostree", "kargs"]) if len(c) > 2]


def pulls(host):
    return calls(host, ["kubeadm", "upgrade", "node", "phase", "kubelet-config"])


def ns_patches(host):
    return [p for p in host.patches if set(p) & {APPLIED, MESSAGE, TARGET}]


# --- pure helpers ----------------------------------------------------------
@pytest.mark.parametrize("settings,vendor,want", [
    ({}, "GenuineIntel", []),
    ({"hugepages": {"1Gi": 4}}, "GenuineIntel", ["hugepagesz=1G", "hugepages=4"]),
    ({"hugepages": {"2Mi": 512, "1Gi": 4}}, "GenuineIntel",
     ["hugepagesz=1G", "hugepages=4", "hugepagesz=2M", "hugepages=512"]),
    ({"hugepages": {"1Gi": 0, "2Mi": 8}}, "GenuineIntel", ["hugepagesz=2M", "hugepages=8"]),
    ({"iommu": True}, "GenuineIntel", ["intel_iommu=on", "iommu=pt"]),
    ({"iommu": True}, "AuthenticAMD", ["amd_iommu=on", "iommu=pt"]),
    ({"iommu": False}, "Unknown", []),
])
def test_desired_kargs(settings, vendor, want):
    assert ku.desired_kargs(settings, vendor) == (want, None)


def test_desired_kargs_refuses_iommu_on_an_unknown_cpu_vendor():
    kargs, problem = ku.desired_kargs({"iommu": True}, "ARM")
    assert kargs is None and "CPU vendor" in problem


def test_desired_kargs_refuses_an_unknown_page_size():
    kargs, problem = ku.desired_kargs({"hugepages": {"16Gi": 1}}, "GenuineIntel")
    assert kargs is None and "16Gi" in problem


def test_karg_plan_rewrites_k4all_hugepages_and_keeps_the_rest():
    current = ["rw", "hugepagesz=1G", "hugepages=4", "quiet"]
    plan = ku.karg_plan(current, ["hugepagesz=1G", "hugepages=4"],
                        ["hugepagesz=1G", "hugepages=8"])
    assert plan["problem"] is None
    assert plan["delete"] == ["hugepagesz=1G", "hugepages=4"]
    assert plan["append"] == ["hugepagesz=1G", "hugepages=8"]
    assert plan["final"] == ["rw", "quiet", "hugepagesz=1G", "hugepages=8"]
    assert plan["record"] == ["hugepagesz=1G", "hugepages=8"]


def test_karg_plan_without_change_does_nothing():
    current = ["rw", "hugepagesz=1G", "hugepages=4", "intel_iommu=on", "iommu=pt"]
    recorded = ["hugepagesz=1G", "hugepages=4", "intel_iommu=on", "iommu=pt"]
    plan = ku.karg_plan(current, recorded, list(recorded))
    assert plan["problem"] is None
    assert not plan["delete"] and not plan["append"] and not plan["append_if_missing"]
    assert plan["final"] == current


def test_karg_plan_does_not_record_a_karg_set_by_hand():
    plan = ku.karg_plan(["rw", "iommu=pt"], [], ["intel_iommu=on", "iommu=pt"])
    assert plan["problem"] is None
    assert plan["append_if_missing"] == ["intel_iommu=on"]
    assert plan["record"] == ["intel_iommu=on"]


def test_karg_plan_refuses_hugepages_set_by_hand():
    plan = ku.karg_plan(["rw", "hugepagesz=2M", "hugepages=100"], [],
                        ["hugepagesz=1G", "hugepages=4"])
    assert "by hand" in plan["problem"] and "hugepages=100" in plan["problem"]


def test_karg_plan_refuses_a_conflicting_iommu_set_by_hand():
    plan = ku.karg_plan(["rw", "intel_iommu=off"], [], ["intel_iommu=on", "iommu=pt"])
    assert "intel_iommu=off" in plan["problem"]


# --- the agent pass --------------------------------------------------------
def test_nothing_to_do_without_a_target(host):
    assert agent(host) == 0
    assert not pulls(host) and not karg_edits(host)
    assert not ns_patches(host)


def test_target_already_applied_clears_a_left_message(host):
    host.annotations.update({TARGET: "h1", APPLIED: "h1", MESSAGE: "waiting: x"})
    agent(host)
    assert MESSAGE not in host.annotations
    assert not pulls(host)


def test_waits_while_a_hop_runs_on_the_node(host):
    host.operator_sets("h1", kubelet={"maxPods": 300})
    host.annotations[ku.ANNOTATION_IN_PROGRESS] = "v2.7.0->v2.7.1"
    agent(host)
    assert host.annotations[MESSAGE].startswith("waiting: an upgrade hop runs")
    assert APPLIED not in host.annotations
    assert not pulls(host)


def test_waits_while_an_open_plan_runs(host):
    ku.save_state(host, {"phase": "STAGE", "current": "v2.7.0", "pending": [],
                         "hop": {"from": "v2.7.0", "to": "v2.7.1"}, "hold": None,
                         "mode": "manual", "history": []})
    host.operator_sets("h1", kubelet={"maxPods": 300})
    agent(host)
    assert host.annotations[MESSAGE].startswith("waiting: an upgrade hop runs")
    assert not pulls(host)


def test_waits_while_kubelet_config_carries_other_settings(host):
    host.operator_sets("h2", kubelet={"maxPods": 300}, target=False)
    host.annotations[TARGET] = "h1"
    agent(host)
    assert host.annotations[MESSAGE] == ("waiting: kube-system/kubelet-config "
                                         "carries the node settings h2, not h1")
    assert not pulls(host)


def test_refuses_a_kubelet_config_without_the_settings(host):
    host.annotations[TARGET] = "h1"
    agent(host)
    assert not host.annotations[MESSAGE].startswith("waiting")
    assert ku.NODE_SETTINGS_ANNOTATION in host.annotations[MESSAGE]
    assert APPLIED not in host.annotations


def test_max_pods_only_pulls_the_config_and_restarts_kubelet(host):
    host.operator_sets("h1", kubelet={"maxPods": 300})
    agent(host)
    assert len(pulls(host)) == 1
    assert host.kubelet_config()["maxPods"] == 300
    assert host.restarts == 1
    assert not karg_edits(host) and host.reboots == 0
    assert host.annotations[APPLIED] == "h1"
    assert MESSAGE not in host.annotations
    assert host.record()["applied"] == "h1"
    assert "inflight" not in host.record()


def test_an_unchanged_kubelet_config_needs_no_restart(host):
    host.operator_sets("h1", kubelet={"maxPods": 250})   # what it has already
    agent(host)
    assert len(pulls(host)) == 1
    assert host.restarts == 0
    assert host.annotations[APPLIED] == "h1"


def test_a_cpu_manager_change_resets_its_state_on_a_cordoned_node(host):
    host.unschedulable = True
    host.write(CPU_STATE, json.dumps({"policyName": "none", "defaultCpuSet": ""}))
    host.write(MEMORY_STATE, json.dumps({"policyName": "None"}))
    host.operator_sets("h1", kubelet={"cpuManagerPolicy": "static",
                                      "reservedSystemCPUs": "0-1"})
    stop_at = []
    real_dispatch = host._dispatch

    def watch(argv, input_text):
        if argv[:3] == ["systemctl", "stop", "kubelet"]:
            stop_at.append(host.exists(CPU_STATE))
        return real_dispatch(argv, input_text)
    host._dispatch = watch
    agent(host)
    assert stop_at == [True], "kubelet is stopped before the state files go"
    assert not host.exists(CPU_STATE) and not host.exists(MEMORY_STATE)
    assert host.kubelet_running
    assert host.annotations[APPLIED] == "h1"
    assert host.record()["kubeletCPU"] == {"cpuManagerPolicy": "static",
                                           "reservedSystemCPUs": "0-1"}


def test_a_reserved_cpus_change_resets_the_state_too(host):
    host.unschedulable = True
    host.write("/var/lib/kubelet/config.yaml", yaml.safe_dump(dict(
        BASE_KUBELET, cpuManagerPolicy="static", reservedSystemCPUs="0")))
    host.write(CPU_STATE, json.dumps({"policyName": "static", "defaultCpuSet": "1-7"}))
    host.operator_sets("h1", kubelet={"cpuManagerPolicy": "static",
                                      "reservedSystemCPUs": "0-1"})
    agent(host)
    assert not host.exists(CPU_STATE)
    assert host.annotations[APPLIED] == "h1"


def test_a_cpu_manager_change_is_refused_on_a_node_not_drained(host):
    host.write(CPU_STATE, json.dumps({"policyName": "none"}))
    host.operator_sets("h1", kubelet={"cpuManagerPolicy": "static",
                                      "reservedSystemCPUs": "0-1"})
    agent(host)
    assert "drained" in host.annotations[MESSAGE]
    assert not host.annotations[MESSAGE].startswith("waiting")
    assert host.exists(CPU_STATE) and not pulls(host)
    assert APPLIED not in host.annotations


def test_hugepages_add_kernel_arguments_and_reboot_once(host):
    host.unschedulable = True
    seen = []
    host.on_kargs = lambda kargs: seen.append(host.record())
    host.operator_sets("h1", hugepages={"1Gi": 4})
    agent(host)
    assert karg_edits(host) == [["rpm-ostree", "kargs", "--append=hugepagesz=1G",
                                 "--append=hugepages=4"]]
    assert seen[0]["kargs"] == ["hugepagesz=1G", "hugepages=4"], \
        "the record is in /etc before the deployment is made"
    assert host.reboots == 1
    assert APPLIED not in host.annotations
    assert host.annotations[MESSAGE] == "waiting: rebooting for the kernel arguments"

    agent(host)        # after the reboot
    assert host.reboots == 1 and len(karg_edits(host)) == 1
    assert host.booted_kargs[-2:] == ["hugepagesz=1G", "hugepages=4"]
    assert host.restarts == 0, "kubelet started with the config at boot"
    assert host.annotations[APPLIED] == "h1"
    assert MESSAGE not in host.annotations


def test_a_hugepages_change_rewrites_only_k4all_kernel_arguments_in_order(host):
    host.unschedulable = True
    host.booted_kargs += ["hugepagesz=1G", "hugepages=4", "quiet"]
    host._write_proc()
    host.write(ku.NODE_SETTINGS_FILE, json.dumps(
        {"kargs": ["hugepagesz=1G", "hugepages=4"], "applied": "h0"}))
    host.annotations[APPLIED] = "h0"
    host.operator_sets("h1", hugepages={"1Gi": 8})
    agent(host)
    assert karg_edits(host) == [["rpm-ostree", "kargs", "--delete=hugepagesz=1G",
                                 "--delete=hugepages=4", "--append=hugepagesz=1G",
                                 "--append=hugepages=8"]]
    agent(host)
    assert host.booted_kargs == BOOT_KARGS + ["quiet", "hugepagesz=1G", "hugepages=8"]
    assert host.record()["kargs"] == ["hugepagesz=1G", "hugepages=8"]
    assert host.annotations[APPLIED] == "h1"


def test_both_page_sizes_with_the_same_count(host):
    host.unschedulable = True
    host.operator_sets("h1", hugepages={"1Gi": 4, "2Mi": 4})
    agent(host)
    agent(host)
    assert host.booted_kargs[-4:] == ["hugepagesz=1G", "hugepages=4",
                                      "hugepagesz=2M", "hugepages=4"]
    assert host.annotations[APPLIED] == "h1"
    host.operator_sets("h2", hugepages={"1Gi": 4})
    agent(host)
    agent(host)
    assert host.booted_kargs == BOOT_KARGS + ["hugepagesz=1G", "hugepages=4"]
    assert host.annotations[APPLIED] == "h2"


@pytest.mark.parametrize("vendor,arg", [("GenuineIntel", "intel_iommu=on"),
                                        ("AuthenticAMD", "amd_iommu=on")])
def test_iommu_by_cpu_vendor(host, vendor, arg):
    host.unschedulable = True
    host.set_vendor(vendor)
    host.operator_sets("h1", iommu=True)
    agent(host)
    assert karg_edits(host) == [["rpm-ostree", "kargs", "--append-if-missing=" + arg,
                                 "--append-if-missing=iommu=pt"]]
    agent(host)
    assert host.booted_kargs[-2:] == [arg, "iommu=pt"]
    assert host.annotations[APPLIED] == "h1"


def test_iommu_on_an_unknown_cpu_vendor_is_refused(host):
    host.unschedulable = True
    host.set_vendor("SomethingElse")
    host.operator_sets("h1", iommu=True)
    agent(host)
    assert "CPU vendor" in host.annotations[MESSAGE]
    assert not karg_edits(host) and not pulls(host) and host.reboots == 0


def test_a_karg_set_by_hand_is_neither_recorded_nor_removed(host):
    host.unschedulable = True
    host.booted_kargs.append("iommu=pt")
    host._write_proc()
    host.operator_sets("h1", iommu=True)
    agent(host)
    agent(host)
    assert host.record()["kargs"] == ["intel_iommu=on"]
    assert host.annotations[APPLIED] == "h1"
    host.operator_sets("h2")            # iommu cleared
    agent(host)
    agent(host)
    assert "iommu=pt" in host.booted_kargs and "intel_iommu=on" not in host.booted_kargs
    assert host.record()["kargs"] == []
    assert host.annotations[APPLIED] == "h2"


def test_hugepages_set_by_hand_are_a_conflict(host):
    host.unschedulable = True
    host.booted_kargs += ["hugepagesz=2M", "hugepages=100"]
    host._write_proc()
    host.operator_sets("h1", hugepages={"1Gi": 4})
    agent(host)
    assert "by hand" in host.annotations[MESSAGE]
    assert not karg_edits(host) and not pulls(host) and host.reboots == 0
    assert APPLIED not in host.annotations


def test_a_conflicting_iommu_set_by_hand_is_refused(host):
    host.unschedulable = True
    host.booted_kargs.append("intel_iommu=off")
    host._write_proc()
    host.operator_sets("h1", iommu=True)
    agent(host)
    assert "intel_iommu=off" in host.annotations[MESSAGE]
    assert not karg_edits(host)


def test_clearing_everything_removes_only_what_k4all_added(host):
    host.unschedulable = True
    ours = ["hugepagesz=1G", "hugepages=4", "intel_iommu=on", "iommu=pt"]
    host.booted_kargs += ["mitigations=off"] + ours
    host._write_proc()
    host.write(ku.NODE_SETTINGS_FILE, json.dumps({"kargs": ours, "applied": "h1"}))
    host.annotations[APPLIED] = "h1"
    host.operator_sets("h0")
    agent(host)
    agent(host)
    assert host.booted_kargs == BOOT_KARGS + ["mitigations=off"]
    assert host.record()["kargs"] == []
    assert host.annotations[APPLIED] == "h0"


def test_a_failed_karg_change_leaves_kubelet_running_and_the_record_as_it_was(host):
    host.unschedulable = True
    host.write(CPU_STATE, json.dumps({"policyName": "none"}))
    host.operator_sets("h1", kubelet={"cpuManagerPolicy": "static",
                                      "reservedSystemCPUs": "0-1"},
                       hugepages={"1Gi": 4})
    before = host.read("/var/lib/kubelet/config.yaml")
    real = host._rpm_ostree_kargs
    host._rpm_ostree_kargs = lambda args: (
        Proc(returncode=1, stderr="error: Transaction in progress") if args else real(args))
    agent(host)
    assert "rpm-ostree kargs" in host.annotations[MESSAGE]
    assert host.kubelet_running and host.exists(CPU_STATE)
    assert host.read("/var/lib/kubelet/config.yaml") == before
    assert host.record()["kargs"] == []
    assert host.reboots == 0 and APPLIED not in host.annotations


def test_karg_changes_are_refused_on_a_node_not_drained(host):
    host.operator_sets("h1", hugepages={"1Gi": 4})
    agent(host)
    assert "drained" in host.annotations[MESSAGE]
    assert not karg_edits(host) and host.reboots == 0


def test_kubelet_not_ready_waits_then_applies_without_a_second_restart(host):
    host.operator_sets("h1", kubelet={"maxPods": 300})
    host.ready_after_restart = False
    agent(host)
    assert host.restarts == 1
    assert host.annotations[MESSAGE].startswith("waiting: kubelet is not Ready")
    assert APPLIED not in host.annotations
    host.node_is_ready = True
    agent(host)
    assert host.restarts == 1 and len(pulls(host)) == 1
    assert host.annotations[APPLIED] == "h1"
    assert MESSAGE not in host.annotations


def test_settings_changed_during_the_pull_put_the_old_config_back(host):
    host.operator_sets("h1", kubelet={"maxPods": 300})
    before = host.read("/var/lib/kubelet/config.yaml")

    def operator_moves_on():
        host.operator_sets("h2", kubelet={"maxPods": 400}, target=False)
    host.after_pull = operator_moves_on
    agent(host)
    assert host.read("/var/lib/kubelet/config.yaml") == before
    assert host.annotations[MESSAGE].startswith("waiting:")
    assert host.restarts == 0 and APPLIED not in host.annotations


def test_a_boot_without_the_kernel_arguments_is_refused_not_rebooted_again(host):
    host.unschedulable = True
    host.boot_drops_pending = True
    host.operator_sets("h1", hugepages={"1Gi": 4})
    agent(host)
    assert host.reboots == 1
    agent(host)
    assert host.reboots == 1
    assert "booted without" in host.annotations[MESSAGE]
    assert APPLIED not in host.annotations


def test_another_staged_deployment_blocks_kernel_argument_changes(host):
    host.unschedulable = True
    host.staged = {"version": "v2.7.1", "kubernetes": "1.36.6"}
    host.operator_sets("h1", hugepages={"1Gi": 4})
    agent(host)
    assert "staged" in host.annotations[MESSAGE]
    assert not karg_edits(host) and host.reboots == 0


# --- the hop's reboot ------------------------------------------------------
def hop_reboot(host):
    upgrader = ku.Upgrader(host, ku.load_config(host))
    state = {"phase": "DRAIN", "current": "v2.7.0", "pending": [], "hold": None,
             "hop": {"from": "v2.7.0", "to": "v2.8.0"}, "mode": "manual",
             "history": []}
    host.staged = {"version": "v2.8.0", "kubernetes": "1.36.6"}
    upgrader.reboot(state)


def test_a_hop_reboot_resets_the_cpu_state_kubeadm_left_behind(host):
    # kubeadm upgrade node wrote the static policy of a rollout this node
    # had not taken yet (paused): kubelet would refuse the old checkpoint
    host.write("/var/lib/kubelet/config.yaml", yaml.safe_dump(dict(
        BASE_KUBELET, cpuManagerPolicy="static", reservedSystemCPUs="0-1")))
    host.write(CPU_STATE, json.dumps({"policyName": "none"}))
    host.write(MEMORY_STATE, json.dumps({"policyName": "None"}))
    hop_reboot(host)
    assert not host.exists(CPU_STATE) and not host.exists(MEMORY_STATE)
    assert host.record()["kubeletCPU"] == {"cpuManagerPolicy": "static",
                                           "reservedSystemCPUs": "0-1"}
    assert host.reboots == 1


def test_a_hop_reboot_resets_the_cpu_state_on_new_reserved_cpus(host):
    host.write("/var/lib/kubelet/config.yaml", yaml.safe_dump(dict(
        BASE_KUBELET, cpuManagerPolicy="static", reservedSystemCPUs="0-1")))
    host.write(CPU_STATE, json.dumps({"policyName": "static"}))
    host.write(ku.NODE_SETTINGS_FILE, json.dumps({"kargs": [], "kubeletCPU": {
        "cpuManagerPolicy": "static", "reservedSystemCPUs": "0"}}))
    hop_reboot(host)
    assert not host.exists(CPU_STATE)


def test_a_hop_reboot_keeps_the_cpu_state_when_nothing_changed(host):
    host.write(CPU_STATE, json.dumps({"policyName": "none"}))
    hop_reboot(host)
    assert host.exists(CPU_STATE)
    assert host.reboots == 1
