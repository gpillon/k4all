"""The kubelet's --node-ip: pin_kubelet_node_ip in k4all-utils.

The functions run for real in bash, with fake `ip` and `getent` commands that
print what a node's routing table and addresses would show.
"""

import os
import re
import subprocess
import textwrap

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")
UTILS = os.path.join(BIN, "k4all-utils")


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


FAKE_IP = textwrap.dedent("""\
    #!/bin/bash
    # Fake `ip`: answers from files in $FAKE_NET.
    args="$*"
    case "$args" in
      "-4 -o route get "*)
        dst=${args##* }
        f="$FAKE_NET/route-$dst"
        [ -f "$f" ] || f="$FAKE_NET/route-default"
        [ -f "$f" ] && cat "$f" && exit 0
        echo "RTNETLINK answers: Network is unreachable" >&2; exit 2 ;;
      "-4 route show default")
        cat "$FAKE_NET/default" 2>/dev/null; exit 0 ;;
      "-4 -o addr show scope global")
        cat "$FAKE_NET/addrs" 2>/dev/null; exit 0 ;;
    esac
    echo "fake ip: unexpected: $args" >&2; exit 1
""")

FAKE_GETENT = textwrap.dedent("""\
    #!/bin/bash
    # Fake `getent ahostsv4 NAME`: from $FAKE_NET/hosts ("NAME IP" lines).
    awk -v n="$2" '$1 == n {print $2 "   STREAM " n}' "$FAKE_NET/hosts" 2>/dev/null
""")


class Node:
    """A node's network (fake `ip`) and the files the kubelet reads."""

    def __init__(self, tmp):
        self.tmp = tmp
        self.net = tmp / "net"
        self.net.mkdir()
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        for name, text in (("ip", FAKE_IP), ("getent", FAKE_GETENT)):
            path = bin_dir / name
            path.write_text(text)
            path.chmod(0o755)
        self.path = "%s:%s" % (bin_dir, os.environ["PATH"])
        self.sysconfig = tmp / "sysconfig-kubelet"
        self.flags = tmp / "kubeadm-flags.env"
        self.kubeconfig = tmp / "kubelet.conf"
        self.state = tmp / "state" / "kubelet-node-ip"

    def addrs(self, *pairs):
        """pairs of (dev, ip)."""
        lines = ["%d: %s    inet %s/24 brd x scope global %s" % (i + 2, dev, ip, dev)
                 for i, (dev, ip) in enumerate(pairs)]
        (self.net / "addrs").write_text("\n".join(lines) + "\n")

    def default(self, dev, src, gw="192.168.6.1"):
        (self.net / "default").write_text("default via %s dev %s proto dhcp\n" % (gw, dev))
        (self.net / "route-default").write_text(
            "192.0.2.1 via %s dev %s src %s uid 0 \\    cache\n" % (gw, dev, src))

    def route(self, dst, dev, src, local=False):
        text = ("local %s dev lo table local src %s uid 0 \\    cache <local>\n" % (dst, src)
                if local else "%s dev %s src %s uid 0 \\    cache\n" % (dst, dev, src))
        (self.net / ("route-" + dst)).write_text(text)

    def joined(self, server):
        self.kubeconfig.write_text(textwrap.dedent("""\
            apiVersion: v1
            clusters:
            - cluster:
                certificate-authority: /etc/kubernetes/pki/ca.crt
                server: https://%s:6443
              name: default-cluster
            """ % server))

    def run(self):
        env = dict(os.environ, PATH=self.path, FAKE_NET=str(self.net),
                   KUBELET_SYSCONFIG=str(self.sysconfig), KUBEADM_FLAGS_FILE=str(self.flags),
                   KUBELET_KUBECONFIG_FILE=str(self.kubeconfig),
                   K4ALL_NODE_IP_STATE=str(self.state))
        proc = subprocess.run(["bash", "-c", 'set -euo pipefail; source "$1"; pin_kubelet_node_ip',
                               "bash", UTILS], env=env, capture_output=True, text=True,
                              check=False)
        assert proc.returncode == 0, proc.stderr
        return proc.stdout

    def extra_args(self):
        text = self.sysconfig.read_text() if self.sysconfig.exists() else ""
        m = re.search(r'^KUBELET_EXTRA_ARGS="?([^"\n]*)"?$', text, re.M)
        return m.group(1) if m else None


@pytest.fixture
def node(tmp_path):
    return Node(tmp_path)


def test_a_new_node_is_pinned_to_its_default_route_address(node):
    node.addrs(("ens18", "192.168.6.142"))
    node.default("ens18", "192.168.6.142")
    node.sysconfig.write_text("KUBELET_EXTRA_ARGS=\n")
    assert "pinned to 192.168.6.142" in node.run()
    assert node.extra_args() == "--node-ip=192.168.6.142"
    assert node.state.read_text().strip() == "192.168.6.142"


def test_a_joined_worker_never_takes_the_cilium_address(node):
    # The IP moved to ovs-bridge; cilium_host carries a pod-network address.
    node.addrs(("cilium_host", "10.0.1.216"), ("ovs-bridge", "192.168.6.142"))
    node.default("ovs-bridge", "192.168.6.142")
    node.route("192.168.6.202", "ovs-bridge", "192.168.6.142")
    node.joined("192.168.6.202")
    node.run()
    assert node.extra_args() == "--node-ip=192.168.6.142"


def test_the_api_server_route_wins_over_the_default_route(node):
    # Cluster traffic on a second NIC, internet on the first.
    node.addrs(("ens18", "10.20.0.5"), ("ens19", "192.168.6.150"))
    node.default("ens18", "10.20.0.5", gw="10.20.0.1")
    node.route("192.168.6.202", "ens19", "192.168.6.150")
    node.joined("192.168.6.202")
    node.run()
    assert node.extra_args() == "--node-ip=192.168.6.150"


def test_a_control_plane_holding_the_vip_keeps_its_own_address(node):
    node.addrs(("ovs-bridge", "192.168.6.202"), ("ovs-bridge", "192.168.6.200"))
    node.default("ovs-bridge", "192.168.6.202")
    node.route("192.168.6.200", "lo", "192.168.6.200", local=True)
    node.joined("192.168.6.200")
    node.run()
    assert node.extra_args() == "--node-ip=192.168.6.202"


def test_an_api_server_name_is_resolved(node):
    node.addrs(("ens18", "192.168.6.142"))
    node.default("ens18", "192.168.6.142")
    node.route("192.168.6.202", "ens18", "192.168.6.142")
    (node.net / "hosts").write_text("api.kubone.lab 192.168.6.202\n")
    node.joined("api.kubone.lab")
    node.run()
    assert node.extra_args() == "--node-ip=192.168.6.142"


def test_a_node_ip_kubeadm_or_the_restore_set_stays(node):
    node.addrs(("ens18", "192.168.6.150"))
    node.default("ens18", "192.168.6.150")
    node.flags.write_text('KUBELET_KUBEADM_ARGS="--node-ip=192.168.6.202 --pod-infra-container-image=x"\n')
    node.sysconfig.write_text("KUBELET_EXTRA_ARGS=\n")
    assert "set in" in node.run()
    assert node.extra_args() == ""
    assert not node.state.exists()


def test_the_admins_own_node_ip_stays(node):
    node.addrs(("ens18", "192.168.6.150"))
    node.default("ens18", "192.168.6.150")
    node.sysconfig.write_text("KUBELET_EXTRA_ARGS=--node-ip=192.168.6.142\n")
    node.run()
    assert node.extra_args() == "--node-ip=192.168.6.142"
    assert not node.state.exists()


def test_the_pinned_address_follows_a_new_dhcp_lease(node):
    node.addrs(("ens18", "192.168.6.150"))
    node.default("ens18", "192.168.6.150")
    node.sysconfig.write_text('KUBELET_EXTRA_ARGS="--fail-swap-on=false --node-ip=192.168.6.142"\n')
    node.state.parent.mkdir()
    node.state.write_text("192.168.6.142\n")
    assert "192.168.6.142 left the node, pinned to 192.168.6.150" in node.run()
    assert node.extra_args() == "--fail-swap-on=false --node-ip=192.168.6.150"


def test_a_pin_still_on_the_node_is_left_alone(node):
    node.addrs(("ovs-bridge", "192.168.6.142"))
    node.default("ovs-bridge", "192.168.6.142")
    node.sysconfig.write_text('KUBELET_EXTRA_ARGS="--node-ip=192.168.6.142"\n')
    node.state.parent.mkdir()
    node.state.write_text("192.168.6.142\n")
    before = node.sysconfig.read_text()
    node.run()
    assert node.sysconfig.read_text() == before


def test_other_kubelet_flags_and_lines_are_kept(node):
    node.addrs(("ens18", "192.168.6.142"))
    node.default("ens18", "192.168.6.142")
    node.sysconfig.write_text("# local tuning\nKUBELET_EXTRA_ARGS=--fail-swap-on=false\nOTHER=1\n")
    node.run()
    text = node.sysconfig.read_text()
    assert text.startswith("# local tuning\n") and "OTHER=1\n" in text
    assert node.extra_args() == "--fail-swap-on=false --node-ip=192.168.6.142"


def test_a_missing_sysconfig_file_is_created(node):
    node.addrs(("ens18", "192.168.6.142"))
    node.default("ens18", "192.168.6.142")
    node.run()
    assert node.extra_args() == "--node-ip=192.168.6.142"


def test_without_routes_nothing_is_pinned(node):
    node.addrs(("ens18", "192.168.6.142"))
    node.sysconfig.write_text("KUBELET_EXTRA_ARGS=\n")
    assert "not pinned" in node.run()
    assert node.extra_args() == ""
    assert not node.state.exists()


def test_a_default_route_through_a_cni_interface_is_not_used(node):
    node.addrs(("cilium_host", "10.0.1.216"))
    node.default("cilium_host", "10.0.1.216")
    node.sysconfig.write_text("KUBELET_EXTRA_ARGS=\n")
    assert "not pinned" in node.run()


def test_the_pin_runs_before_the_kubelet_at_every_boot():
    unit = read(BOOTC, "systemd", "k4all-node-ip.service")
    assert re.search(r"^Before=.*\bkubelet\.service\b", unit, re.M)
    assert re.search(r"^After=.*\bnetwork-online\.target\b", unit, re.M)
    assert re.search(r"^After=.*\bfck8s-restore\.service\b", unit, re.M), \
        "after the restore, which pins its own address"
    assert "ExecStart=/usr/local/bin/k4all-node-ip" in unit
    assert "systemctl enable k4all-node-ip.service" in read(BOOTC, "Containerfile")
    dropin = read(BOOTC, "overlay", "etc", "systemd", "system", "kubelet.service.d",
                  "20-k4all-node-ip.conf")
    assert "After=k4all-node-ip.service" in dropin and "Wants=k4all-node-ip.service" in dropin
    assert os.access(os.path.join(BIN, "k4all-node-ip"), os.X_OK)


@pytest.mark.parametrize("script", ["overrides/worker/join_cluster.sh",
                                    "overrides/control/join_cluster.sh"])
def test_joins_pin_the_address_before_kubeadm(script):
    text = read(BIN, script)
    assert text.index("k4all-node-ip") < text.index('bash -c "$JOIN_COMMAND"')


def test_the_bootstrap_pins_the_address_before_kubeadm_init():
    text = read(BIN, "overrides", "bootstrap", "setup-k8s-init.sh")
    assert text.index("pin_kubelet_node_ip") < text.index("kubeadm init --config")
