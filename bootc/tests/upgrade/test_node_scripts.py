"""Node scripts that run outside k4all-upgrade: CRI-O's example CNI networks.

The functions of k4all-utils run for real in bash, on temporary directories
and with a fake kubectl.
"""

import base64
import json
import os
import stat
import subprocess

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")
UTILS = os.path.join(BIN, "k4all-utils")
MIGRATE = os.path.join(BIN, "k4all-migrate-config.sh")

BRIDGE = "100-crio-bridge.conflist"
LOOPBACK = "200-loopback.conflist"
CALICO = "10-calico.conflist"


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


@pytest.fixture
def cni(tmp_path):
    """/etc/cni/net.d and the image's copy of CRI-O's networks."""
    net = tmp_path / "net.d"
    share = tmp_path / "k4all-cni"
    net.mkdir()
    share.mkdir()
    for name in (BRIDGE, LOOPBACK):
        (share / name).write_text('{"name": "%s"}\n' % name)

    def call(function):
        env = dict(os.environ, CNI_NET_DIR=str(net), K4ALL_CNI_SHARE=str(share),
                   K4ALL_CNI_MARKER=str(tmp_path / "marker"))
        return subprocess.run(["bash", "-c", 'source "$1"; %s' % function,
                               "bash", UTILS], env=env, capture_output=True,
                              text=True, check=False)

    return net, call


def names(directory):
    return sorted(os.listdir(directory))


def test_a_new_bootstrap_node_borrows_the_bridge(cni):
    net, call = cni
    assert call("cluster_cni_present").returncode == 1
    assert call("lend_crio_bridge_cni").returncode == 0
    assert names(net) == [BRIDGE], "the bridge only, not the loopback network"
    assert call("cluster_cni_present").returncode == 1, "CRI-O's own does not count"
    assert (net.parent / "marker").exists(), "the node remembers it lent it"


def test_nothing_is_lent_once_the_cluster_has_its_cni(cni):
    net, call = cni
    (net / CALICO).write_text("{}")
    assert call("cluster_cni_present").returncode == 0
    call("lend_crio_bridge_cni")
    assert names(net) == [CALICO]


def test_crio_networks_go_once_the_cluster_cni_is_there(cni):
    net, call = cni
    (net / BRIDGE).write_text("{}")
    (net / LOOPBACK).write_text("{}")
    call("drop_crio_cni")
    assert names(net) == [BRIDGE, LOOPBACK], "no cluster CNI yet: kept"
    (net.parent / "marker").write_text("")
    (net / CALICO).write_text("{}")
    proc = call("drop_crio_cni")
    assert proc.returncode == 0
    assert names(net) == [CALICO]
    assert "Removed" in proc.stdout
    assert not (net.parent / "marker").exists()


def test_without_the_cni_the_handover_keeps_the_bridge(cni):
    net, call = cni
    call("lend_crio_bridge_cni")
    proc = call("handover_crio_bridge 0")
    assert proc.returncode == 0, "nothing to try again: it gives up"
    assert names(net) == [BRIDGE] and (net.parent / "marker").exists()


@pytest.fixture
def bridge_pods(tmp_path):
    """recreate_crio_bridge_pods and handover_crio_bridge with a fake kubectl."""
    pods = {"items": [
        {"metadata": {"namespace": "kube-system", "name": "coredns-a"},
         "spec": {}, "status": {"podIP": "10.85.0.2"}},
        {"metadata": {"namespace": "kube-system", "name": "coredns-c"},
         "spec": {}, "status": {"podIP": "10.85.0.3"}},
        {"metadata": {"namespace": "cert-manager", "name": "cm-1"},
         "spec": {}, "status": {"podIP": "10.85.0.4"}},
        {"metadata": {"namespace": "kube-system", "name": "coredns-b"},
         "spec": {}, "status": {"podIP": "10.100.12.4"}},
        {"metadata": {"namespace": "kube-system", "name": "kube-proxy-x"},
         "spec": {"hostNetwork": True}, "status": {"podIP": "10.85.0.9"}},
        {"metadata": {"namespace": "x", "name": "pending"},
         "spec": {}, "status": {}},
    ]}
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "kubectl.log"
    kubectl = bin_dir / "kubectl"
    kubectl.write_text("#!/bin/bash\necho \"$*\" >> %s\n"
                       'case " $* " in\n'
                       '  *" get pods "*) [ -e %s/fail-get ] && exit 1; cat %s ;;\n'
                       '  *" delete "*) [ -e %s/fail-delete ] && exit 1 ;;\n'
                       "esac\nexit 0\n"
                       % (log, tmp_path, tmp_path / "pods.json", tmp_path))
    kubectl.chmod(kubectl.stat().st_mode | stat.S_IEXEC)
    (tmp_path / "pods.json").write_text(json.dumps(pods))
    net = tmp_path / "net.d"
    net.mkdir()
    share = tmp_path / "share"
    share.mkdir()
    (share / BRIDGE).write_text("{}")
    marker = tmp_path / "marker"

    def call(function):
        env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
                   CNI_NET_DIR=str(net), K4ALL_CNI_SHARE=str(share),
                   K4ALL_CNI_MARKER=str(marker))
        proc = subprocess.run(["bash", "-c", 'source "$1"; %s' % function,
                               "bash", UTILS], env=env, capture_output=True,
                              text=True, check=False)
        calls = log.read_text().splitlines() if log.exists() else []
        return proc, calls

    return call, net, marker


# Review 2: a failed `kubectl get pods` still dropped the bridge.
@pytest.mark.parametrize("failure", ["fail-get", "fail-delete"])
def test_a_kubectl_failure_keeps_the_bridge_for_a_retry(bridge_pods, failure):
    call, net, marker = bridge_pods
    marker.write_text("")
    (net / BRIDGE).write_text("{}")
    (net / CALICO).write_text("{}")
    (marker.parent / failure).write_text("")
    proc, _ = call("handover_crio_bridge 0")
    assert proc.returncode == 1
    assert names(net) == sorted([BRIDGE, CALICO]) and marker.exists()
    (marker.parent / failure).unlink()
    proc, _ = call("handover_crio_bridge 0")
    assert proc.returncode == 0
    assert names(net) == [CALICO] and not marker.exists()


def test_only_pods_on_the_bridge_are_recreated(bridge_pods):
    call, _, marker = bridge_pods
    marker.write_text("")
    proc, calls = call("recreate_crio_bridge_pods")
    assert proc.returncode == 0, proc.stderr
    deletes = sorted(c for c in calls if " delete " in c)
    assert deletes == [
        "--kubeconfig /etc/kubernetes/admin.conf delete pod -n cert-manager "
        "cm-1 --wait=false",
        "--kubeconfig /etc/kubernetes/admin.conf delete pod -n kube-system "
        "coredns-a coredns-c --wait=false"], "one call per namespace"


def test_nothing_is_listed_unless_the_bridge_was_lent(bridge_pods):
    call, _, _ = bridge_pods
    proc, calls = call("recreate_crio_bridge_pods")
    assert proc.returncode == 0 and calls == []
    proc, calls = call("handover_crio_bridge 0")
    assert proc.returncode == 0 and calls == []


def test_the_handover_moves_the_pods_then_drops_the_bridge(bridge_pods):
    call, net, marker = bridge_pods
    marker.write_text("")
    (net / BRIDGE).write_text("{}")
    (net / CALICO).write_text("{}")
    proc, calls = call("handover_crio_bridge 0")
    assert proc.returncode == 0, proc.stderr
    assert len([c for c in calls if " delete " in c]) == 2
    assert names(net) == [CALICO] and not marker.exists()


def test_migrate_config_drops_the_borrowed_bridge_at_boot(tmp_path):
    root = tmp_path / "root"
    (root / "usr/local/bin").mkdir(parents=True)
    (root / "usr/local/share/k4all-cni").mkdir(parents=True)
    (root / "etc/cni/net.d").mkdir(parents=True)
    with open(UTILS, encoding="utf-8") as fh:
        (root / "usr/local/bin/k4all-utils").write_text(fh.read())
    (root / "usr/local/share/k4all-cni" / BRIDGE).write_text("{}")
    net = root / "etc/cni/net.d"
    (net / BRIDGE).write_text("{}")
    env = dict(os.environ, K4ALL_ROOT=str(root))

    def run():
        proc = subprocess.run(["bash", MIGRATE], env=env, capture_output=True,
                              text=True, check=False)
        assert proc.returncode == 0, proc.stdout + proc.stderr

    run()
    assert names(net) == [BRIDGE], "first boot of a new bootstrap: kept"
    (net / CALICO).write_text("{}")
    run()
    assert names(net) == [CALICO]


# --- where the scripts call them ------------------------------------------
def test_the_image_keeps_crio_networks_out_of_net_d():
    text = read(BOOTC, "Containerfile")
    assert "for f in 100-crio-bridge.conflist 200-loopback.conflist" in text
    assert 'mv "/etc/cni/net.d/$f" /usr/local/share/k4all-cni/' in text
    # a new bootstrap node cannot start the operator without it
    assert "test -s /usr/local/share/k4all-cni/100-crio-bridge.conflist" in text


def test_only_a_new_cluster_borrows_the_bridge_before_kubeadm_init():
    script = read(BIN, "overrides", "bootstrap", "setup-k8s-init.sh")
    restore = script.index("restore-bootstrap-cluster.flag")
    lend = script.index("\nlend_crio_bridge_cni\n")
    init = script.index("\nkubeadm init --config")
    assert restore < lend < init
    for role in ("control", "worker"):
        for name in ("setup-k8s-init.sh", "join_cluster.sh"):
            assert "lend_crio_bridge_cni" not in read(BIN, "overrides", role, name)


def test_a_join_command_first_moves_pods_off_the_bridge():
    script = read(BIN, "overrides", "bootstrap-control", "generate_join.sh")
    handover = script.index("handover_crio_bridge >&2")
    token = script.index("kubeadm token create")
    assert handover < token


def test_the_first_boot_hands_the_bridge_over_once_the_cni_is_there():
    # Review: only generate_join.sh moved the pods; a cluster that never
    # printed a join command kept coredns on the bridge.
    script = read(BIN, "deploy-operator.sh")
    done = script.index('touch "$DONE_FILE"')
    handover = script.index("handover_crio_bridge 1800")
    assert done < handover, "the unit's own work is recorded first"
    assert "systemd-run --unit k4all-crio-bridge-handover" in script
    assert "--property=Restart=on-failure" in script, "a failed list is retried"


# --- worker join_cluster.sh ---------------------------------------------------
JOIN_WORKER = os.path.join(BIN, "overrides", "worker", "join_cluster.sh")


@pytest.fixture
def worker_join(tmp_path):
    """join_cluster.sh with fake sudo, kubectl, systemctl, hostname, sleep."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    kubelet_conf = tmp_path / "kubelet.conf"

    def fake(name, body):
        path = bin_dir / name
        path.write_text("#!/bin/bash\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def run(kubelet_active=True, joined=True, cert_name=None):
        fake("sudo", 'echo "sudo $*" >> %s\n' % log)
        fake("sleep", "exit 0\n")
        fake("hostname", "echo Kube-Worker-26BKN\n")
        fake("systemctl", "exit %d\n" % (0 if kubelet_active else 3))
        # the Node authorizer: only the kubelet's own Node
        fake("kubectl", 'echo "kubectl $*" >> %s\n'
             'case " $* " in\n'
             '  *" get nodes "*) echo "forbidden: only its own Node" >&2; exit 1 ;;\n'
             '  *" get node kube-worker-26bkn "*|*" get node w-07 "*)'
             ' echo node/x ;;\n'
             '  *" get node "*) echo "forbidden" >&2; exit 1 ;;\n'
             "esac\n" % log)
        fake("openssl", ('echo "subject="; echo "    commonName = system:node:%s"\n'
                         % cert_name) if cert_name else "exit 1\n")
        if joined:
            kubelet_conf.write_text("x")
        env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
                   KUBELET_CONF=str(kubelet_conf),
                   KUBELET_CLIENT_CERT=str(tmp_path / "cert.pem"))
        command = "kubeadm join 192.168.6.200:6443 --token x"
        code = base64.b64encode(command.encode()).decode()
        proc = subprocess.run(["bash", JOIN_WORKER, code], env=env,
                              capture_output=True, text=True, check=False)
        calls = log.read_text().splitlines() if log.exists() else []
        return proc, calls

    return run


# Multi-node lab: the worker joined ("This node has joined the cluster"),
# then the script failed: `kubectl get nodes` with kubelet.conf is forbidden.
def test_worker_join_is_verified_on_its_own_node(worker_join):
    proc, calls = worker_join()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "successfully joined" in proc.stdout
    assert calls[0] == "sudo bash -c kubeadm join 192.168.6.200:6443 --token x"
    gets = [c for c in calls if c.startswith("kubectl")]
    assert gets and all(" get node kube-worker-26bkn " in c + " " for c in gets)
    assert not [c for c in calls if " get nodes" in c]


def test_worker_join_uses_the_name_in_the_kubelet_certificate(worker_join):
    proc, calls = worker_join(cert_name="w-07")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [c for c in calls if " get node w-07" in c]


@pytest.mark.parametrize("kwargs", [{"kubelet_active": False}, {"joined": False}])
def test_worker_join_fails_when_the_node_did_not_join(worker_join, kwargs):
    proc, _ = worker_join(**kwargs)
    assert proc.returncode == 1
    assert "Verification failed" in proc.stdout
