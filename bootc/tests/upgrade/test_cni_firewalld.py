"""firewalld and the CNI (issue #63): the ports of the CNI that runs on the
node, not the CNI an installer guessed.

The functions of k4all-utils and k4all-cni-firewalld run for real in bash,
on a fake root, with fake `systemctl` and `firewall-cmd` that keep the
firewall in files.
"""

import json
import os
import re
import subprocess
import textwrap

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")
UTILS = os.path.join(BIN, "k4all-utils")
SCRIPT = os.path.join(BIN, "k4all-cni-firewalld")
PH2 = os.path.join(BIN, "setup-k8s-ph2.sh")
SYSTEMD = os.path.join(BOOTC, "systemd")


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


# What the CNIs write in /etc/cni/net.d (trimmed).
CILIUM = {"cniVersion": "0.3.1", "name": "cilium",
          "plugins": [{"type": "cilium-cni", "enable-debug": False}]}
CALICO = {"name": "k8s-pod-network", "cniVersion": "0.3.1",
          "plugins": [{"type": "calico", "datastore_type": "kubernetes"},
                      {"type": "bandwidth"}, {"type": "portmap"}]}
FLANNEL = {"name": "cbr0", "cniVersion": "0.3.1",
           "plugins": [{"type": "flannel"}, {"type": "portmap"}]}
MULTUS_ON_CILIUM = {"cniVersion": "0.3.1", "name": "multus-cni-network",
                    "plugins": [{"type": "multus", "delegates": [CILIUM]}]}
CRIO_BRIDGE = {"cniVersion": "1.0.0", "name": "crio",
               "plugins": [{"type": "bridge", "bridge": "cni0"}]}

FAKE_SYSTEMCTL = """\
    [ "$*" = "is-active --quiet firewalld" ] || { echo "unexpected: $*" >&2; exit 1; }
    [ -f "$FW/running" ]
    """

# Ports in $FW/permanent and $FW/runtime, one per line; calls in $FW/calls.
FAKE_FIREWALL_CMD = """\
    echo "firewall-cmd $*" >> "$FW/calls"
    store="$FW/runtime"
    [ "$1" = --permanent ] && { store="$FW/permanent"; shift; }
    touch "$store"
    case "$1" in
      --query-port=*) grep -qx "${1#--query-port=}" "$store" ;;
      --add-port=*) echo "${1#--add-port=}" >> "$store" ;;
      *) echo "unexpected: $*" >&2; exit 2 ;;
    esac
    """


class Node:
    def __init__(self, tmp):
        self.root = tmp / "root"
        self.fw = tmp / "fw"
        self.bin = tmp / "bin"
        self.net_d = self.root / "etc" / "cni" / "net.d"
        self.share = self.root / "usr" / "local" / "share" / "k4all-cni"
        for d in (self.fw, self.bin, self.net_d, self.share,
                  self.root / "usr" / "local" / "bin"):
            d.mkdir(parents=True)
        os.symlink(UTILS, self.root / "usr" / "local" / "bin" / "k4all-utils")
        (self.share / "100-crio-bridge.conflist").write_text(json.dumps(CRIO_BRIDGE))
        for name, body in (("systemctl", FAKE_SYSTEMCTL),
                           ("firewall-cmd", FAKE_FIREWALL_CMD)):
            path = self.bin / name
            path.write_text("#!/bin/bash\n" + textwrap.dedent(body))
            path.chmod(0o755)

    def cni(self, name, conf):
        (self.net_d / name).write_text(json.dumps(conf, indent=2))

    def firewalld(self, running=True, permanent=(), runtime=()):
        if running:
            (self.fw / "running").write_text("")
        (self.fw / "permanent").write_text("".join(p + "\n" for p in permanent))
        (self.fw / "runtime").write_text("".join(p + "\n" for p in runtime))

    def env(self):
        return dict(os.environ, K4ALL_ROOT=str(self.root), FW=str(self.fw),
                    CNI_NET_DIR=str(self.net_d), K4ALL_CNI_SHARE=str(self.share),
                    PATH="%s:%s" % (self.bin, os.environ["PATH"]))

    def utils(self, function):
        return subprocess.run(["bash", "-c", 'source "$1"; %s' % function, "bash", UTILS],
                              env=self.env(), capture_output=True, text=True, check=False)

    def script(self):
        return subprocess.run(["bash", SCRIPT], env=self.env(), capture_output=True,
                              text=True, check=False)

    def ports(self, store):
        path = self.fw / store
        return path.read_text().split() if path.exists() else []

    def calls(self):
        path = self.fw / "calls"
        return path.read_text().splitlines() if path.exists() else []


@pytest.fixture
def node(tmp_path):
    return Node(tmp_path)


def ports(node, cni):
    return node.utils("cni_firewalld_ports %s" % cni).stdout.split()


# --- the ports and the CNI on the node --------------------------------------

def test_the_cilium_ports_include_its_tunnel_and_health(node):
    cilium = ports(node, "cilium")
    for port in ("8472/udp", "4240/tcp", "4244/tcp"):
        assert port in cilium
    assert "179/tcp" in ports(node, "calico")
    assert ports(node, "flannel") == ["8472/udp"]
    assert ports(node, "weave") == []


def test_every_port_is_valid_firewalld_syntax(node):
    for cni in ("calico", "cilium", "flannel"):
        for port in ports(node, cni):
            assert re.fullmatch(r"\d+(-\d+)?/(tcp|udp)", port), port


@pytest.mark.parametrize("files,expected", [
    ({"05-cilium.conflist": CILIUM}, ["cilium"]),
    ({"10-calico.conflist": CALICO}, ["calico"]),
    ({"10-flannel.conflist": FLANNEL}, ["flannel"]),
    # Multus in front of Cilium (KubeVirt with ovs-cni)
    ({"00-multus.conflist": MULTUS_ON_CILIUM, "05-cilium.conflist": CILIUM}, ["cilium"]),
    # During a CNI switch both are there: both get their ports.
    ({"05-cilium.conflist": CILIUM, "10-calico.conflist": CALICO}, ["calico", "cilium"]),
    # CRI-O's bridge, lent to a new bootstrap node, is not the cluster's CNI.
    ({"100-crio-bridge.conflist": CRIO_BRIDGE}, []),
    ({}, []),
])
def test_running_cnis(node, files, expected):
    for name, conf in files.items():
        node.cni(name, conf)
    assert node.utils("running_cnis").stdout.split() == expected


# --- k4all-cni-firewalld -----------------------------------------------------

def test_a_cilium_worker_gets_the_cilium_ports(node):
    node.cni("05-cilium.conflist", CILIUM)
    node.firewalld(permanent=["22/tcp", "4240/tcp"], runtime=["22/tcp"])
    proc = node.script()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    want = ports(node, "cilium")
    assert set(want) <= set(node.ports("permanent"))
    assert set(want) <= set(node.ports("runtime"))
    assert node.ports("permanent").count("4240/tcp") == 1, "an open port is left as it is"
    assert "179/tcp" not in node.ports("permanent"), "no Calico port on a Cilium node"
    assert not [c for c in node.calls() if "--reload" in c], "no reload on a running node"


def test_a_second_run_changes_nothing(node):
    node.cni("10-calico.conflist", CALICO)
    node.firewalld()
    assert node.script().returncode == 0
    before = (node.ports("permanent"), node.ports("runtime"))
    (node.fw / "calls").unlink()
    assert node.script().returncode == 0
    assert (node.ports("permanent"), node.ports("runtime")) == before
    assert not [c for c in node.calls() if "--add-port" in c]


def test_without_firewalld_nothing_is_touched(node):
    node.cni("05-cilium.conflist", CILIUM)
    node.firewalld(running=False)
    proc = node.script()
    assert proc.returncode == 0, proc.stderr
    assert node.calls() == []
    assert "firewalld is not running" in proc.stdout


def test_before_the_cni_nothing_is_opened(node):
    node.cni("100-crio-bridge.conflist", CRIO_BRIDGE)
    node.firewalld()
    proc = node.script()
    assert proc.returncode == 0, proc.stderr
    assert node.calls() == []


# --- where it runs -----------------------------------------------------------

def test_the_path_unit_runs_it_when_the_cni_configuration_changes():
    path = read(SYSTEMD, "k4all-cni-firewalld.path")
    assert "PathChanged=/etc/cni/net.d" in path
    assert "Unit=k4all-cni-firewalld.service" in path
    service = read(SYSTEMD, "k4all-cni-firewalld.service")
    assert "ExecStart=/usr/local/bin/k4all-cni-firewalld" in service
    assert "After=firewalld.service" in service
    assert os.access(SCRIPT, os.X_OK)
    containerfile = read(BOOTC, "Containerfile")
    assert "COPY systemd/*.path /etc/systemd/system/" in containerfile
    assert "systemctl enable k4all-cni-firewalld.path" in containerfile


def test_phase_2_takes_the_cni_from_the_configuration_only_on_the_bootstrap_node():
    script = read(PH2)
    block = script[script.index("# The CNI's ports."):script.index("firewall-cmd --reload")]
    assert '= "bootstrap" ]' in block
    assert "cni_firewalld_ports \"$CNI_TYPE\"" in block
    assert "8472/udp" not in script, "the port lists live in k4all-utils"
