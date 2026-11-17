"""End-to-end behaviour of the phase driver against a simulated node."""

import datetime
import json

import pytest
import yaml

from conftest import READYZ_NOT_READY, Proc, ku, release, run_cli, write_graph

STREAM_23 = [
    release("v2.2.4", "patch", "v2.0.0-beta1", "1.35.6", "1.32", 43),
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 43),
    release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
            syncManifest=True),
]

TO_136 = [
    release("v2.6.0", "minor", "v2.5.0", "1.35.10", "1.35", 45),
    release("v2.7.0", "minor", "v2.6.0", "1.36.6", "1.36", 45),
]

TO_137 = [
    release("v2.8.0", "minor", "v2.7.0", "1.36.6", "1.36", 45),
    release("v2.9.0", "minor", "v2.8.0", "1.37.2", "1.37", 45),
]


def state(host):
    return ku.load_state(host)


def commands(host, prefix):
    return [c for c in host.calls if c[:len(prefix)] == prefix]


def index_of(host, predicate):
    for i, call in enumerate(host.calls):
        if predicate(call):
            return i
    raise AssertionError("command not run")


def finish(host, limit=10):
    """Boot-time resumes until the plan settles."""
    for _ in range(limit):
        st = state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


# --- hops without a Kubernetes change ------------------------------------------
def test_patch_hop_stages_reboots_and_commits(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert commands(host, ["bootc", "switch", "--download-only"])[0][-1] == \
        "ghcr.io/gpillon/k4all-bootc:v2.3.1"
    assert commands(host, ["bootc", "upgrade", "--from-downloaded", "--apply"])
    assert not [c for c in host.calls if "apply" in c and "upgrade" in c
                and c[0].endswith("kubeadm-1.35.10")]
    assert state(host)["phase"] == "REBOOT"
    assert host.annotations[ku.ANNOTATION_IN_PROGRESS] == "v2.3.0->v2.3.1"
    assert host.operator_scale_history == [], "no Kubernetes change, no pause"

    st = finish(host)
    assert st["phase"] == "DONE"
    assert st["current"] == "v2.3.1"
    assert st["history"][-1]["result"] == "ok"
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations


def test_backup_runs_before_staging(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    backup = index_of(host, lambda c: c[0].endswith("k4all-backup.sh"))
    stage = index_of(host, lambda c: c[:3] == ["bootc", "switch", "--download-only"])
    assert backup < stage
    assert host.exists("%s/backup/v2.3.0-v2.3.1/files/var/lib/kubelet/config.yaml"
                       % ku.STATE_DIR)


# --- Kubernetes changes -------------------------------------------------------
def test_control_plane_is_upgraded_before_the_reboot(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)

    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    apply_at = index_of(host, lambda c: c[1:3] == ["upgrade", "apply"])
    reboot_at = index_of(host, lambda c: c[:3] == ["bootc", "upgrade",
                                                   "--from-downloaded"])
    assert apply_at < reboot_at
    kubeadm = host.calls[apply_at][0]
    assert kubeadm.endswith("/var/lib/k4all/upgrade/bin/kubeadm-1.35.10"), \
        "kubeadm must come from the staged image"
    assert host.calls[apply_at][3] == "v1.35.10"
    assert host.apiserver == "1.35.10"
    assert host.operator_replicas == 0, "old operators are paused for the hop"

    st = finish(host)
    assert st["current"] == "v2.3.0"
    assert host.booted["kubernetes"] == "1.35.10"
    assert host.operator_scale_history == [0, 1]


def test_kubeadm_is_read_from_the_staged_commit(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.0", "--yes")
    cat = [c for c in host.calls if c[:1] == ["ostree"]]
    assert cat and cat[0][2:] == ["cat", "c-v2.3.0", "/usr/bin/kubeadm"]


V1BETA3_CONFIG = """apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
networking:
  podSubnet: "10.100.0.1/18"
controllerManager:
  extraArgs:
    flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
nodeRegistration:
  kubeletExtraArgs:
    volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
"""


def test_136_hop_drops_the_flexvolume_flag_before_kubeadm(make_host):
    host = make_host(version="v2.6.0", kubernetes="1.35.10")
    write_graph(host, TO_136)
    host.write(ku.KUBEADM_CONFIG_FILE, V1BETA3_CONFIG)

    assert run_cli(host, "run", "--yes") == 0
    replace_at = index_of(host, lambda c: "replace" in c)
    apply_at = index_of(host, lambda c: c[1:3] == ["upgrade", "apply"])
    assert replace_at < apply_at
    names = [a["name"] for a in host.cluster_config["controllerManager"]["extraArgs"]]
    assert "flex-volume-plugin-dir" not in names
    assert host.read(ku.KUBEADM_CONFIG_FILE) == V1BETA3_CONFIG, \
        "v1beta3 still works on 1.36: the file is converted on the 1.37 hop"


def test_137_hop_converts_the_kubeadm_config_file_first(make_host):
    host = make_host(version="v2.8.0", kubernetes="1.36.6")
    host.cluster_config["controllerManager"] = {}
    write_graph(host, TO_137)
    host.write(ku.KUBEADM_CONFIG_FILE, V1BETA3_CONFIG)

    assert run_cli(host, "run", "--yes") == 0
    assert not [c for c in host.calls if c[:3] == ["kubeadm", "config", "migrate"]], \
        "kubeadm config migrate would inject defaults (token, address, socket)"
    docs = list(yaml.safe_load_all(host.read(ku.KUBEADM_CONFIG_FILE)))
    assert [d["apiVersion"] for d in docs] == ["kubeadm.k8s.io/v1beta4"] * 2
    assert docs[0]["controllerManager"]["extraArgs"] == [
        {"name": "flex-volume-plugin-dir",
         "value": "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"}]
    assert docs[1]["nodeRegistration"]["kubeletExtraArgs"] == [
        {"name": "volume-plugin-dir",
         "value": "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"}]
    assert "bootstrapTokens" not in docs[1] and "localAPIEndpoint" not in docs[1]
    assert host.read(ku.KUBEADM_CONFIG_FILE + ".v1beta3.bak") == V1BETA3_CONFIG
    assert finish(host)["current"] == "v2.9.0"


def test_v1beta4_conversion_moves_timeouts():
    join = {"apiVersion": "kubeadm.k8s.io/v1beta3", "kind": "JoinConfiguration",
            "discovery": {"timeout": "5m0s"}}
    doc, changed = ku.kubeadm_doc_to_v1beta4(join)
    assert changed and doc["timeouts"] == {"discovery": "5m0s"}
    same, changed = ku.kubeadm_doc_to_v1beta4({"apiVersion": "kubeadm.k8s.io/v1beta4"})
    assert not changed


def test_worker_waits_for_the_control_plane(make_host):
    host = make_host(version="v2.6.0", kubernetes="1.35.10", role="worker")
    write_graph(host, TO_136)
    host.apiserver = "1.35.10"

    assert run_cli(host, "run", "--yes") == 1
    st = state(host)
    assert "upgrade the control plane" in st["hold"]["reason"]
    assert not commands(host, ["bootc", "switch"])


def test_worker_upgrades_once_the_control_plane_is_ahead(make_host):
    host = make_host(version="v2.6.0", kubernetes="1.35.10", role="worker")
    write_graph(host, TO_136)
    host.apiserver = "1.36.6"

    assert run_cli(host, "run", "--yes") == 0
    node_at = index_of(host, lambda c: c[1:3] == ["upgrade", "node"])
    reboot_at = index_of(host, lambda c: c[:3] == ["bootc", "upgrade",
                                                   "--from-downloaded"])
    assert node_at < reboot_at
    assert finish(host)["current"] == "v2.7.0"


# --- failures ---------------------------------------------------------------
def test_unhealthy_node_rolls_back_once_then_holds(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.healthy_after_boot = False

    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    run_cli(host, "resume")             # post-boot check times out
    assert commands(host, ["bootc", "rollback"])
    assert state(host)["phase"] == "ROLLBACK_REBOOT"
    assert host.booted["version"] == "v2.3.0"

    host.healthy_after_boot = True
    run_cli(host, "resume")
    st = state(host)
    assert st["hold"] and "rolled back to v2.3.0" in st["hold"]["reason"]
    assert ku.ANNOTATION_IN_PROGRESS in host.annotations, \
        "the operator stays paused while the node needs a human"


def test_node_still_on_the_old_image_holds_without_rollback(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    # simulate a boot back into the old deployment
    host.booted = {"version": "v2.3.0", "kubernetes": "1.35.10"}
    host.write(ku.VERSION_FILE, "v2.3.0\n")

    run_cli(host, "resume")
    st = state(host)
    assert "still on v2.3.0" in st["hold"]["reason"]
    assert not commands(host, ["bootc", "rollback"])


def test_failed_kubeadm_apply_holds_and_resumes_the_operator(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    original = host._kubeadm

    def failing(cmd, args):
        if args[:2] == ["upgrade", "apply"]:
            from conftest import Proc
            return Proc(returncode=1, stderr="etcd unhealthy")
        return original(cmd, args)
    host._kubeadm = failing

    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PRE_REBOOT" and "etcd unhealthy" in st["hold"]["reason"]
    assert host.operator_scale_history == [0, 1]
    assert not commands(host, ["bootc", "upgrade", "--from-downloaded"])


def test_foreign_staged_deployment_blocks_the_hop(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "already staged" in state(host)["hold"]["reason"]
    assert not commands(host, ["bootc", "switch"])


def test_run_refuses_while_an_upgrade_is_in_progress(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 2


def test_clear_hold_abandon_forgets_the_plan(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}
    run_cli(host, "run", "--to", "v2.3.1", "--yes")

    assert run_cli(host, "clear-hold", "--abandon") == 0
    st = state(host)
    assert st["phase"] == "DONE" and st["hold"] is None
    assert st["history"][-1]["result"] == "abandoned"


def test_run_without_yes_needs_a_terminal(make_host, monkeypatch):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False, raising=False)
    assert run_cli(host, "run", "--to", "v2.3.1") == 2
    assert state(host) is None


# --- preflight right after a boot --------------------------------------------
# Lab, right after the reboot into the bridge: `k4all-upgrade run` went to
# HOLD in PREFLIGHT because /readyz failed on
# poststarthook/apiservice-discovery-controller while metrics-server and
# calico-apiserver came up; a minute later /readyz was ok.
def test_preflight_waits_until_readyz_is_ok(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.readyz_failures = 2

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.readyz_calls == 3, "ok on the third try"
    assert host.sleeps == [ku.READY_POLL_SECONDS] * 2
    st = state(host)
    assert not st.get("hold") and st["phase"] == "REBOOT"
    assert commands(host, ["bootc", "switch", "--download-only"])


def test_preflight_holds_once_readyz_stays_failed_past_the_timeout(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.readyz_failures = 10 ** 6
    start = host.clock

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PREFLIGHT"
    reason = st["hold"]["reason"]
    assert reason == ("the apiserver is not ready: failed checks: "
                      "poststarthook/apiservice-discovery-controller "
                      "(still after 5 minutes)")
    waited = host.clock - start
    assert datetime.timedelta(minutes=5) <= waited < datetime.timedelta(minutes=6)
    assert set(host.sleeps) == {ku.READY_POLL_SECONDS}
    assert host.readyz_calls == len(host.sleeps) + 1
    assert not commands(host, ["bootc", "switch"])


def test_preflight_wait_follows_the_policy_file(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.CONFIG_FILE, "mode: manual\napiserverReadyTimeoutMinutes: 1\n")
    host.readyz_failures = 10 ** 6
    start = host.clock

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "(still after 1 minutes)" in state(host)["hold"]["reason"]
    assert host.clock - start < datetime.timedelta(minutes=2)


def test_preflight_waits_for_the_node_to_turn_ready(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.nodes_not_ready = 3

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.sleeps == [ku.READY_POLL_SECONDS] * 3
    assert state(host)["phase"] == "REBOOT"


def test_preflight_holds_on_a_node_that_stays_not_ready(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.nodes_not_ready = 10 ** 6

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert state(host)["hold"]["reason"] == \
        "nodes not Ready: k4all-node-1 (still after 5 minutes)"


def test_worker_preflight_does_not_wait_on_readyz(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.readyz_failures = 10 ** 6

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.readyz_calls == 0 and host.sleeps == []


@pytest.mark.parametrize("proc, problem", [
    (Proc("ok"), None),
    (Proc(returncode=1, stderr=READYZ_NOT_READY),
     "failed checks: poststarthook/apiservice-discovery-controller"),
    # a real newline between the checks, two failures
    (Proc(returncode=1, stdout="[+]ping ok\n[-]etcd failed: reason withheld\n"
          "[-]poststarthook/apiservice-discovery-controller failed: reason "
          "withheld\nreadyz check failed\n"),
     "failed checks: etcd, poststarthook/apiservice-discovery-controller"),
    (Proc(returncode=1, stderr="The connection to the server 10.0.0.1:6443 "
          "was refused - did you specify the right host or port?\n"),
     "The connection to the server 10.0.0.1:6443 was refused - did you "
     "specify the right host or port?"),
    (Proc(returncode=1), "no answer (rc=1)"),
])
def test_readyz_problem_is_one_short_line(proc, problem):
    assert ku.readyz_problem(proc) == problem


def test_readyz_problem_keeps_the_end_of_a_long_answer():
    got = ku.readyz_problem(Proc(returncode=1, stderr="x" * 1000 + " the end"))
    assert len(got) == 300 and got.startswith("...") and got.endswith("the end")


# --- automatic mode --------------------------------------------------------
def test_timer_does_nothing_outside_the_window(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.clock = datetime.datetime(2026, 11, 17, 10, 0)   # Tuesday
    assert run_cli(host, "auto") == 0
    assert state(host) is None


def test_timer_runs_patches_but_not_minors(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)

    assert run_cli(host, "auto") == 0
    assert state(host)["hop"]["to"] == "v2.3.1"
    st = finish(host)
    assert st["current"] == "v2.3.1" and st["phase"] == "DONE"
    assert not [c for c in host.calls if c[-1:] == ["ghcr.io/gpillon/k4all-bootc:v2.4.0"]]


def test_timer_runs_minors_when_allowed(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23[:2])
    host.write(ku.CONFIG_FILE, "mode: auto\nautoAllow: minor\n")
    run_cli(host, "auto")
    assert finish(host)["current"] == "v2.3.0"


def test_manual_mode_ignores_the_timer(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.CONFIG_FILE, "mode: manual\n")
    run_cli(host, "auto")
    assert state(host) is None


# --- several hops and the manifest sync ---------------------------------------
NEW_MANIFEST = {
    "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
    "metadata": {"name": "k4all"},
    "spec": {"components": {
        "k4all-operator": {"type": "manifest", "version": "v0.2.0",
                           "source": "https://example/{{ version }}/install.yaml"},
        "cert-manager": {"type": "helm", "version": "v1.21.3"},
        "calico": {"type": "manifest", "version": "v3.33.1"},
    }},
}


def test_run_walks_every_hop_and_syncs_the_manifest_in_two_steps(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = {
        "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
        "metadata": {"name": "k4all", "resourceVersion": "7"},
        "spec": {"components": {
            "k4all-operator": {"version": "v0.1.5", "source": "old"},
            "cert-manager": {"version": "v1.14.5", "custom": {"replicas": "2"}},
            "calico": {"version": "v3.27.3", "management": "Unmanaged"},
            "my-extra": {"version": "v1"},
        }}}

    assert run_cli(host, "run", "--to", "v2.4.0", "--yes") == 0
    st = finish(host)
    assert st["current"] == "v2.4.0" and st["phase"] == "DONE"
    # v2.3.1 is visited: a stream is always finished before crossing a minor
    assert [h["to"] for h in st["history"]] == ["v2.3.0", "v2.3.1", "v2.4.0"]
    assert host.reboots == 3

    first, second = host.applied_manifests
    assert list(first["spec"]["components"]) == ["k4all-operator"]
    assert first["spec"]["components"]["k4all-operator"]["version"] == "v0.2.0"
    comps = second["spec"]["components"]
    assert comps["cert-manager"]["version"] == "v1.21.3"
    assert comps["cert-manager"]["custom"] == {"replicas": "2"}
    assert comps["calico"]["management"] == "Unmanaged"
    assert comps["my-extra"] == {"version": "v1"}
    assert "resourceVersion" not in second["metadata"]


def test_second_sync_step_waits_for_the_new_operator_to_adopt(make_host):
    host = make_host(version="v2.3.1", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = {"metadata": {"name": "k4all"}, "spec": {
        "components": {"k4all-operator": {"version": "v0.1.5"}}}}
    host.operator_adopts = False        # an operator without appliedHash

    run_cli(host, "run", "--to", "v2.4.0", "--yes")
    st = finish(host)
    assert "k4all-operator v0.2.0 not running" in st["hold"]["reason"]
    assert len(host.applied_manifests) == 1, "step 2 must not be applied"


def test_failed_component_after_sync_holds_without_rollback(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    # the operator is already the new one: only the components step runs
    host.release_manifest = {"metadata": {"name": "k4all"}, "spec": {"components": {
        "k4all-operator": dict(NEW_MANIFEST["spec"]["components"]["k4all-operator"])}}}
    host.components_after_sync = "Failed"

    run_cli(host, "run", "--to", "v2.4.0", "--yes")
    started = host.clock
    st = finish(host)
    assert "components failed after the sync" in st["hold"]["reason"]
    assert len(host.applied_manifests) == 1
    assert st["phase"] == "SYNC"
    assert not commands(host, ["bootc", "rollback"])
    # a Failed component is retried by the operator: HOLD only at the deadline
    assert host.clock - started >= datetime.timedelta(minutes=45)


# --- pure helpers -------------------------------------------------------------
def test_operator_only_step_is_skipped_when_the_operator_does_not_change():
    cluster = {"spec": {"components": {"k4all-operator": {"version": "v0.2.0",
                                                          "source": "s"}}}}
    merged = {"apiVersion": "a", "kind": "k", "spec": {"components": {
        "k4all-operator": {"version": "v0.2.0", "source": "s"}}}}
    assert ku.operator_only_manifest(cluster, merged) is None


@pytest.mark.parametrize("status,settled,failed", [
    ({"components": {"a": {"state": "Installed", "installedVersion": "v1.0"}}},
     True, []),
    ({"components": {"a": {"state": "Installed", "installedVersion": "v0.9"}}},
     False, []),
    ({"components": {"a": {"state": "Upgrading"}}}, False, []),
    ({"components": {"a": {"state": "Failed"}}}, False, ["a"]),
    ({"components": {"a": {"state": "Installed", "installedVersion": "1.0"}},
      "conditions": [{"type": "Ready", "status": "False",
                      "reason": "UpgradeInProgress", "message": "node x"}]},
     False, []),
])
def test_components_settled(status, settled, failed):
    cr = {"spec": {"components": {"a": {"version": "v1.0"},
                                  "b": {"version": "latest", "management":
                                        "Unmanaged"}}},
          "status": status}
    got = ku.components_settled(cr)
    assert (got[0], got[1]) == (settled, failed)


def test_drop_flexvolume_handles_both_kubeadm_api_shapes():
    v1beta4 = {"controllerManager": {"extraArgs": [
        {"name": "flex-volume-plugin-dir", "value": "/x"},
        {"name": "bind-address", "value": "0.0.0.0"}]}}
    assert ku.drop_flexvolume(v1beta4)
    assert v1beta4["controllerManager"]["extraArgs"] == [
        {"name": "bind-address", "value": "0.0.0.0"}]
    v1beta3 = {"controllerManager": {"extraArgs": {"flex-volume-plugin-dir": "/x"}}}
    assert ku.drop_flexvolume(v1beta3)
    assert v1beta3["controllerManager"]["extraArgs"] == {}
    assert not ku.drop_flexvolume({"controllerManager": {}})


def test_status_reports_hold(make_host, capsys):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    out = capsys.readouterr().out
    assert "Release:   v2.3.0" in out and "HOLD:" in out


# --- bootc under systemd ------------------------------------------------------
def test_deployment_changes_run_bootc_as_a_transient_unit():
    # Started from this tool bootc would stay in unconfined_service_t, which
    # cannot set labels a newer SELinux policy brings (F43 -> F45 failed so).
    argv = ku.via_systemd(["bootc", "switch", "--download-only", "img:v1"], 3600)
    assert argv[0] == "systemd-run"
    assert {"--wait", "--collect"} <= set(argv)
    assert "--pipe" not in argv     # refused by systemd from a service
    assert "RuntimeMaxSec=3600" in argv
    assert argv[argv.index("--"):] == ["--", "/usr/bin/bootc", "switch",
                                       "--download-only", "img:v1"]
    for sub in (["upgrade", "--from-downloaded", "--apply"], ["rollback"]):
        wrapped = ku.via_systemd(["bootc"] + sub)
        assert wrapped[0] == "systemd-run"
        assert wrapped[-len(sub):] == sub
        assert not any(a.startswith("RuntimeMaxSec") for a in wrapped)


def test_read_only_and_other_commands_run_directly():
    for argv in (["bootc", "status", "--json"], ["kubectl", "get", "nodes"],
                 ["bootc"], []):
        assert ku.via_systemd(argv) == argv


def test_a_failed_bootc_unit_reports_its_journal(monkeypatch):
    calls = []

    class Proc:
        def __init__(self, rc, out=""):
            self.returncode, self.stdout, self.stderr = rc, out, ""

    def fake_run(argv, **kwargs):
        calls.append(argv)
        if argv[0] == "journalctl":
            return Proc(0, "error: Switching: fsetxattr: Invalid argument\n")
        return Proc(1)

    monkeypatch.setattr(ku.subprocess, "run", fake_run)
    with pytest.raises(ku.UpgradeError, match="fsetxattr: Invalid argument"):
        ku.Host().run(["bootc", "switch", "--download-only", "img:v1"])
    unit = calls[0][calls[0].index("--unit") + 1]
    assert calls[1][:3] == ["journalctl", "-u", unit]

