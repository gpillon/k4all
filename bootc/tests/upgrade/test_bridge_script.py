"""k4all-bridge.sh against fake bootc/systemctl/kubectl commands."""

import json
import os
import stat
import subprocess

import pytest

from conftest import REPO

SCRIPT = os.path.join(REPO, "bootc", "scripts", "k4all-bridge.sh")


def _fake(bin_dir, name, body):
    path = bin_dir / name
    path.write_text("#!/bin/bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@pytest.fixture
def node(tmp_path):
    root = tmp_path / "root"
    (root / "sysroot").mkdir(parents=True)
    (root / "usr/local/share").mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"

    def setup(booted="ghcr.io/gpillon/k4all-bootc:v2.2.3-amd64", staged=None,
              image_tag=None, nodes="k4all-1   Ready   control-plane   1d   v1.35.6\n",
              admin=True, free_kib=50 * 1024 * 1024, node_type=None,
              release_manifest=None, kube_vip_manifest=None, vip_up=True,
              graces=(("pod-a", "30"), ("pod-b", "30")), ps_fails=False):
        status = {"status": {"booted": {"image": {"image": {"image": booted}}},
                             "staged": ({"image": {"image": {"image": staged}}}
                                        if staged else None)}}
        (tmp_path / "status.json").write_text(json.dumps(status))
        _fake(bin_dir, "bootc", 'if [ "$1" = status ]; then cat %s; else echo "bootc $*" >> %s; fi\n'
              % (tmp_path / "status.json", log))
        _fake(bin_dir, "systemctl", 'echo "systemctl $*" >> %s\n' % log)
        # systemd-run: record the wrapper, then run the command after "--"
        _fake(bin_dir, "systemd-run",
              'echo "$*" >> %s\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'
              % (tmp_path / "systemd-run.log"))
        (tmp_path / "nodes.txt").write_text(nodes)
        if release_manifest == "none":          # --ignore-not-found: nothing
            (tmp_path / "rm.json").write_text("")
        elif release_manifest is not None:
            (tmp_path / "rm.json").write_text(json.dumps(release_manifest))
        if kube_vip_manifest is not None:
            (root / "etc/kubernetes/manifests").mkdir(parents=True, exist_ok=True)
            (root / "etc/kubernetes/manifests/kube-vip.yaml").write_text(
                kube_vip_manifest)
        # kubectl: reads are not logged, a patch is a change
        _fake(bin_dir, "kubectl",
              'case " $* " in\n'
              '  *" get --raw /readyz "*) exit %d ;;\n'
              '  *" get nodes "*) %s ;;\n'
              '  *" get releasemanifest "*) cat %s ;;\n'
              '  *" patch "*) echo "kubectl $*" >> %s ;;\n'
              "esac\n" % (0 if vip_up else 1,
                           ("cat %s" % (tmp_path / "nodes.txt")) if vip_up
                           else "exit 1", tmp_path / "rm.json", log))
        if node_type:
            (root / "etc").mkdir(exist_ok=True)
            (root / "etc/node-type").write_text(node_type + "\n")
        # crictl: listing is read-only (not logged), stopping a pod is a change.
        # `ps -o json`: the running containers, with kubelet's annotation of
        # their pod's grace period
        (tmp_path / "ps.json").write_text(json.dumps({"containers": [
            {"id": "c%d" % i, "podSandboxId": pod, "annotations": {
                "io.kubernetes.pod.terminationGracePeriod": grace}}
            for i, (pod, grace) in enumerate(graces)]}))
        _fake(bin_dir, "crictl",
              'case " $* " in\n'
              '  *" pods -q --state ready "*) printf "pod-a\\npod-b\\n" ;;\n'
              '  *" ps -o json "*) %s ;;\n'
              '  *" stopp "*) echo "crictl $*" >> %s ;;\n'
              "esac\n" % ("exit 1" if ps_fails else "cat %s" % (tmp_path / "ps.json"),
                          log))
        _fake(bin_dir, "df", 'echo Avail; echo %d\n' % free_kib)
        _fake(bin_dir, "id", 'echo 0\n')
        # the node ships mikefarah yq; mimic the one expression the script uses
        _fake(bin_dir, "yq", 'awk \'/imageTag:/ {print $2}\' "${@: -1}"\n')
        if image_tag:
            (root / "usr/local/share/k4all-release.yaml").write_text(
                "spec:\n  osImage:\n    imageTag: %s\n" % image_tag)
        if admin:
            (root / "etc/kubernetes").mkdir(parents=True, exist_ok=True)
            (root / "etc/kubernetes/admin.conf").write_text("x")

    def run(*args, path=None, env_extra=None):
        env = dict(os.environ, PATH="%s:%s" % (bin_dir, path or os.environ["PATH"]),
                   K4ALL_ROOT=str(root), **(env_extra or {}))
        proc = subprocess.run(["bash", SCRIPT] + list(args), env=env,
                              capture_output=True, text=True)
        calls = log.read_text().splitlines() if log.exists() else []
        return proc, calls

    return setup, run


def test_masks_the_timer_before_staging_the_bridge(node):
    setup, run = node
    setup()
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert calls == ["systemctl mask --now bootc-fetch-apply-updates.timer",
                     "bootc switch ghcr.io/gpillon/k4all-bootc:v2.2.4"]
    assert "Reboot when convenient" in proc.stdout


def test_bootc_runs_as_a_transient_unit(node, tmp_path):
    # As a systemd unit, /usr/bin/bootc enters install_t, which may set file
    # labels the running SELinux policy does not know yet.
    setup, run = node
    setup()
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    wrapper = (tmp_path / "systemd-run.log").read_text().splitlines()
    assert len(wrapper) == 1
    assert "--wait" in wrapper[0] and "--collect" in wrapper[0]
    assert wrapper[0].endswith("-- bootc switch ghcr.io/gpillon/k4all-bootc:v2.2.4")


def test_now_reboots_into_the_bridge(node):
    setup, run = node
    setup()
    proc, calls = run("--now")
    assert proc.returncode == 0, proc.stderr
    assert calls[:2] == ["systemctl mask --now bootc-fetch-apply-updates.timer",
                         "bootc switch ghcr.io/gpillon/k4all-bootc:v2.2.4"]
    assert calls[-1] == "systemctl reboot"


# Multi-node lab: reboots of nodes still running ingress-nginx v2.2.x (300 s
# grace, a preStop hook) took 4 minutes; the bridge reboots such nodes.
def test_now_stops_the_pods_with_a_deadline_before_the_reboot(node):
    setup, run = node
    setup()
    proc, calls = run("--now")
    assert proc.returncode == 0, proc.stderr
    stop = calls.index("systemctl stop kubelet")
    assert calls.index("bootc switch ghcr.io/gpillon/k4all-bootc:v2.2.4") < stop
    stopp = sorted(c for c in calls if " stopp " in c)
    # 30 s and 2 s more: CRI-O keeps them for the call and the infra container
    assert stopp == [
        "crictl --runtime-endpoint unix:///run/crio/crio.sock --timeout=32s "
        "stopp pod-a",
        "crictl --runtime-endpoint unix:///run/crio/crio.sock --timeout=32s "
        "stopp pod-b"]
    assert stop < min(calls.index(c) for c in stopp)
    assert calls[-1] == "systemctl reboot"


def stop_deadlines(calls):
    """{pod: crictl's --timeout} of the stops."""
    out = {}
    for c in calls:
        if " stopp " in c:
            words = c.split()
            out[words[-1]] = words[-3]
    return out


# k4all#98: a VM's virt-launcher pod has its VMI's grace period plus 30 s;
# with 30 s its guest lost QEMU halfway through its shutdown.
def test_now_gives_each_pod_its_own_grace_period(node):
    setup, run = node
    setup(graces=(("pod-a", "210"), ("pod-a", "30"), ("pod-b", "1"),
                  ("gone", "999")))
    proc, calls = run("--now")
    assert proc.returncode == 0, proc.stderr
    assert stop_deadlines(calls) == {"pod-a": "--timeout=212s",
                                     "pod-b": "--timeout=32s"}


@pytest.mark.parametrize("env,deadline", [
    ({}, "--timeout=302s"),
    ({"K4ALL_POD_STOP_MAX_SECONDS": "900"}, "--timeout=902s"),
    ({"K4ALL_POD_STOP_MAX_SECONDS": "10"}, "--timeout=32s"),
])
def test_a_grace_period_above_the_most_is_cut_to_it(node, env, deadline):
    setup, run = node
    setup(graces=(("pod-a", "3630"), ("pod-b", "30")))
    proc, calls = run("--now", env_extra=env)
    assert proc.returncode == 0, proc.stderr
    assert stop_deadlines(calls)["pod-a"] == deadline


def test_a_most_that_is_not_a_number_stops_before_anything_changes(node):
    setup, run = node
    setup()
    proc, calls = run("--now", env_extra={"K4ALL_POD_STOP_MAX_SECONDS": "soon"})
    assert proc.returncode == 1
    assert "K4ALL_POD_STOP_MAX_SECONDS must be a number of seconds" in proc.stderr
    assert calls == []


def test_grace_periods_that_cannot_be_read_give_every_pod_the_most(node):
    setup, run = node
    setup(ps_fails=True)
    proc, calls = run("--now")
    assert proc.returncode == 0, proc.stderr
    assert stop_deadlines(calls) == {"pod-a": "--timeout=302s",
                                     "pod-b": "--timeout=302s"}


def test_staging_without_now_leaves_the_pods_alone(node):
    setup, run = node
    setup()
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert not [c for c in calls if "kubelet" in c or "crictl" in c]


def test_dry_run_changes_nothing(node):
    setup, run = node
    setup()
    proc, calls = run("--dry-run")
    assert proc.returncode == 0, proc.stderr
    assert calls == []
    assert "would run: systemd-run" in proc.stdout
    assert "-- bootc switch ghcr.io/gpillon/k4all-bootc:v2.2.4" in proc.stdout


def would_run(stdout):
    """The commands a dry run prints, as the fakes log them when they run:
    the command a systemd-run wraps, without the wrapper."""
    out = []
    for line in stdout.splitlines():
        if "would run: " not in line:
            continue
        cmd = line.split("would run: ", 1)[1]
        if cmd.startswith("systemd-run ") and " -- " in cmd:
            cmd = cmd.split(" -- ", 1)[1]
        out.append(cmd)
    return out


# Lab (VM 953): `--dry-run` showed `bootc switch` (staging for the next
# reboot), then the real run used --now, which switches and reboots.
@pytest.mark.parametrize("options", [[], ["--now"]])
def test_dry_run_shows_what_the_same_options_run(node, options):
    setup, run = node
    setup()
    dry, calls = run("--dry-run", *options)
    assert dry.returncode == 0, dry.stderr
    assert calls == []
    real, calls = run(*options)
    assert real.returncode == 0, real.stderr
    shown = would_run(dry.stdout)

    def in_order(cmds):     # the pods stop in parallel, in any order
        return ([c for c in cmds if " stopp " not in c],
                sorted(c for c in cmds if " stopp " in c))
    assert in_order(shown) == in_order(calls)
    if "--now" in options:
        assert shown[-1] == "systemctl reboot"
    assert "Reboot when convenient" not in dry.stdout
    assert "dry run: nothing changed" in dry.stdout


def test_dry_run_without_now_says_how_to_see_the_reboot(node):
    setup, run = node
    setup()
    proc, _ = run("--dry-run")
    assert "add --now to see the switch and the reboot" in proc.stdout
    assert "--apply" not in proc.stdout


def test_help_documents_the_dry_run(node):
    setup, run = node
    setup()
    proc, calls = run("--help")
    assert proc.returncode == 0 and calls == []
    assert "`--dry-run --now` shows the switch and the reboot" in proc.stdout
    assert "set -euo" not in proc.stdout


# --- kube-vip: the host's manifest, Unmanaged for the operator -------------------
def release_manifest(kube_vip):
    components = {"k4all-operator": {"type": "manifest", "version": "v0.1.4"}}
    if kube_vip is not None:
        components["kube-vip"] = dict({"type": "static-pod", "version": "latest"},
                                      **kube_vip)
    return {"metadata": {"name": "k4all"}, "spec": {"components": components}}


UNMANAGED_PATCH = ("kubectl --kubeconfig %s/etc/kubernetes/admin.conf patch "
                   "releasemanifest k4all --type merge -p "
                   '{"spec":{"components":{"kube-vip":{"management":"Unmanaged"}}}}')


# Multi-node lab: two minutes after kubeadm init, operator v0.1.4 rewrote
# kube-vip.yaml with an image-only Pod and the API VIP disappeared.
@pytest.mark.parametrize("kube_vip", [{}, {"management": "Managed"}])
def test_the_bootstrap_node_hands_kube_vip_to_the_host(node, tmp_path, kube_vip):
    setup, run = node
    setup(node_type="bootstrap", release_manifest=release_manifest(kube_vip))
    proc, calls = run("--now")
    assert proc.returncode == 0, proc.stderr
    assert calls[0] == UNMANAGED_PATCH % (tmp_path / "root")
    assert "kube-vip: management Unmanaged in the ReleaseManifest" in proc.stdout


@pytest.mark.parametrize("kube_vip,message", [
    (None, "kube-vip: not in the ReleaseManifest, nothing to change"),
    ({"management": "Unmanaged"}, "kube-vip: already Unmanaged"),
    ({"management": "Removed"}, "kube-vip: already Removed"),
])
def test_kube_vip_entry_left_alone(node, kube_vip, message):
    setup, run = node
    setup(node_type="bootstrap", release_manifest=release_manifest(kube_vip))
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert not [c for c in calls if c.startswith("kubectl")]
    assert message in proc.stdout


def test_kube_vip_only_from_the_bootstrap_node(node):
    setup, run = node
    setup(node_type="control", release_manifest=release_manifest({}))
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert not [c for c in calls if c.startswith("kubectl")]
    assert "kube-vip" not in proc.stdout


def test_an_unreadable_release_manifest_only_warns(node):
    setup, run = node
    setup(node_type="bootstrap")            # `get releasemanifest` fails
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert "set kube-vip Unmanaged by hand" in proc.stderr
    assert calls[-1].startswith("bootc switch ")


def test_dry_run_shows_the_kube_vip_patch(node, tmp_path):
    setup, run = node
    setup(node_type="bootstrap", release_manifest=release_manifest({}))
    proc, calls = run("--dry-run")
    assert calls == []
    assert "would run: " + UNMANAGED_PATCH % (tmp_path / "root") in proc.stdout


# Multi-node lab: the bridge rebooted each node with its pods, and left the
# default policy (mode: auto) on a cluster upgraded by hand.
def test_a_multi_node_cluster_is_told_to_drain_and_to_set_the_mode(node):
    setup, run = node
    setup(nodes="a Ready control-plane 1d v1\nb Ready <none> 1d v1\n")
    proc, _ = run("--dry-run")
    assert proc.returncode == 0, proc.stderr
    out = " ".join(proc.stdout.replace("[k4all-bridge]", "").split())
    assert "cluster with 2 nodes" in out
    assert "kubectl drain <node> --ignore-daemonsets --delete-emptydir-data" in out
    assert "'mode: manual'" in out and "/etc/k4all-upgrade.yaml" in out


def test_no_release_manifest_is_not_an_error(node):
    setup, run = node
    setup(node_type="bootstrap", release_manifest="none")
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert "kube-vip: not in the ReleaseManifest" in proc.stdout
    assert "WARNING" not in proc.stderr


# What k4all-operator v0.1.4 to v0.4.x write: the image alone.
OPERATOR_KUBE_VIP = ("apiVersion: v1\nkind: Pod\nmetadata:\n  name: kube-vip\n"
                     "spec:\n  containers:\n  - name: kube-vip\n"
                     "    image: ghcr.io/kube-vip/kube-vip:v1.0.2\n")


def test_a_rewritten_kube_vip_with_the_vip_down_stops_the_bridge(node):
    # Review: the bridge runs on the old system; it stops with the remedy
    # instead of rebuilding the manifest.
    setup, run = node
    setup(node_type="bootstrap", release_manifest=release_manifest({}),
          kube_vip_manifest=OPERATOR_KUBE_VIP, vip_up=False)
    proc, calls = run("--now", "--force")
    assert proc.returncode != 0
    assert "has no settings" in proc.stderr and "API VIP does not answer" in proc.stderr
    assert "docs/upgrades.md#kube-vip-on-ha-clusters" in proc.stderr
    assert calls == []


def test_a_rewritten_kube_vip_with_the_vip_up_only_warns(node):
    # Another control plane holds the VIP; v2.4.0 writes the manifest again.
    setup, run = node
    setup(node_type="control", kube_vip_manifest=OPERATOR_KUBE_VIP)
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert "has no settings" in proc.stdout
    assert calls[-1].startswith("bootc switch ")


def test_an_older_kube_vip_with_vip_address_is_left_alone(node):
    setup, run = node
    setup(node_type="control", vip_up=False,
          kube_vip_manifest="spec:\n  containers:\n  - env:\n"
                            "    - name: vip_address\n      value: 10.0.0.9\n")
    proc, _ = run()
    assert "has no settings" not in proc.stdout + proc.stderr


def test_without_kubectl_the_check_says_so(node, tmp_path):
    # Review 2: a missing kubectl was taken for "VIP down".
    setup, run = node
    setup(node_type="control", kube_vip_manifest=OPERATOR_KUBE_VIP)
    (tmp_path / "bin" / "kubectl").unlink()
    # A PATH with the system tools but no kubectl: CI runners ship one in
    # /usr/bin, so pointing PATH at /usr/bin is not enough.
    nokube = tmp_path / "nokube"
    nokube.mkdir()
    for directory in ("/usr/bin", "/bin"):
        for name in os.listdir(directory):
            if name == "kubectl" or os.path.lexists(nokube / name):
                continue
            (nokube / name).symlink_to(os.path.join(directory, name))
    proc, calls = run(path=str(nokube))
    assert proc.returncode != 0
    assert "kubectl is missing" in proc.stderr
    assert "VIP does not answer" not in proc.stderr
    assert calls == []


def test_a_k4all_kube_vip_is_left_alone(node):
    setup, run = node
    setup(node_type="bootstrap", release_manifest=release_manifest({}),
          kube_vip_manifest="spec:\n  containers:\n  - env:\n    - name: address\n"
                            "      value: 10.0.0.9\n", vip_up=True)
    proc, _ = run()
    assert proc.returncode == 0, proc.stderr
    assert "has no settings" not in proc.stdout + proc.stderr


def test_bridge_or_newer_exits_without_changes(node):
    setup, run = node
    setup(booted="ghcr.io/gpillon/k4all-bootc:v2.3.0")
    proc, calls = run()
    assert proc.returncode == 0
    assert calls == []
    assert "already on the bridge" in proc.stdout


def test_release_manifest_tag_wins_over_a_latest_ref(node):
    setup, run = node
    setup(booted="ghcr.io/gpillon/k4all-bootc:latest", image_tag="v2.2.1")
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert "runs v2.2.1" in proc.stdout


def test_beta_releases_are_accepted(node):
    setup, run = node
    setup(booted="ghcr.io/gpillon/k4all-bootc:v2.0.0-beta2-amd64", admin=False)
    proc, calls = run()
    assert proc.returncode == 0, proc.stderr
    assert calls[-1].startswith("bootc switch ")


@pytest.mark.parametrize("kwargs,message", [
    ({"staged": "ghcr.io/gpillon/k4all-bootc:v2.2.3"}, "already staged"),
    ({"free_kib": 1024}, "GiB free"),
    ({"nodes": "a Ready x 1d v1\nb NotReady x 1d v1\n"}, "nodes not Ready"),
    ({"booted": "quay.io/fedora/fedora-bootc:43"}, "not a k4all bootc image"),
])
def test_preflight_failures_stop_before_any_change(node, kwargs, message):
    setup, run = node
    setup(**kwargs)
    proc, calls = run()
    assert proc.returncode != 0
    assert message in proc.stderr
    assert calls == []


def test_digest_is_used_once_ci_stamps_it(node, tmp_path):
    setup, run = node
    setup()
    stamped = tmp_path / "stamped.sh"
    stamped.write_text(open(SCRIPT).read().replace("@@BRIDGE_DIGEST@@", "sha256:abc"))
    env = dict(os.environ, PATH="%s:%s" % (tmp_path / "bin", os.environ["PATH"]),
               K4ALL_ROOT=str(tmp_path / "root"))
    proc = subprocess.run(["bash", str(stamped), "--dry-run"], env=env,
                          capture_output=True, text=True)
    assert "ghcr.io/gpillon/k4all-bootc@sha256:abc" in proc.stdout
