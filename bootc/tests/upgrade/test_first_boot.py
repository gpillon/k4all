"""A first boot without network (issue #62): set-hostname.sh and the steps
that wait for the network.

The scripts run for real in bash, against a fake root and with fake `ip`,
`hostnamectl`, `systemd-resolve`, `openssl` and `sleep` commands. The fake
`sleep` is the clock: the network comes up after a given number of sleeps.
"""

import os
import subprocess
import textwrap

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")
UTILS = os.path.join(BIN, "k4all-utils")
SET_HOSTNAME = os.path.join(BIN, "set-hostname.sh")
PH3 = os.path.join(BIN, "overrides", "bootstrap-control", "setup-k8s-ph3.sh")
SYSTEMD = os.path.join(BOOTC, "systemd")

NIC = "2: ens18    inet 192.168.6.144/24 brd 192.168.6.255 scope global dynamic ens18"
NIC6 = "2: ens18    inet6 2001:db8::5/64 scope global dynamic mngtmpaddr"
CILIUM = "5: cilium_host    inet 10.0.1.229/32 scope global cilium_host"
CNI0 = "6: cni0    inet 10.85.0.1/16 brd 10.85.255.255 scope global cni0"
ROUTE = "default via 192.168.6.1 dev ens18 proto dhcp src 192.168.6.144 metric 100"


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


FAKES = {
    # The network is up once the fake clock reached $NET/up-after sleeps
    # (no file: never). Then `ip` prints $NET/addrs, $NET/route4, $NET/route6.
    "ip": """\
        sleeps=$(cat "$NET/sleeps" 2>/dev/null || echo 0)
        up_after=$(cat "$NET/up-after" 2>/dev/null || echo never)
        up=no
        [ "$up_after" != never ] && [ "$sleeps" -ge "$up_after" ] && up=yes
        out() { [ "$up" = yes ] && cat "$NET/$1" 2>/dev/null; exit 0; }
        case "$*" in
          "-o addr show scope global") out addrs ;;
          "route show default") out route4 ;;
          "-6 route show default") out route6 ;;
        esac
        echo "fake ip: unexpected: $*" >&2; exit 1
        """,
    "sleep": """\
        echo $(( $(cat "$NET/sleeps" 2>/dev/null || echo 0) + 1 )) > "$NET/sleeps"
        """,
    "hostnamectl": """\
        echo "hostnamectl $*" >> "$NET/calls"
        [ "$1" = set-hostname ] && echo "$2" > "$NET/hostname"
        exit 0
        """,
    "hostname": """\
        cat "$NET/hostname" 2>/dev/null || echo localhost
        """,
    # The DHCP domain, once the network is up and the lease is there.
    "systemd-resolve": """\
        sleeps=$(cat "$NET/sleeps" 2>/dev/null || echo 0)
        at=$(cat "$NET/domain-after" 2>/dev/null || echo never)
        [ "$at" != never ] && [ "$sleeps" -ge "$at" ] || exit 0
        echo "Link 2 (ens18)"
        echo "    Current Scopes: DNS"
        echo "       DNS Servers: 192.168.6.1"
        echo "        DNS Domain: $(cat "$NET/domain")"
        """,
    "openssl": """\
        echo "Q7x9kZ+ab3/cd"
        """,
}


class Node:
    """A node at its first boot: a fake root and a fake network."""

    def __init__(self, tmp):
        self.root = tmp / "root"
        self.net = tmp / "net"
        self.bin = tmp / "bin"
        for d in (self.net, self.bin, self.root / "opt" / "k4all",
                  self.root / "etc" / "kubernetes",
                  self.root / "usr" / "local" / "bin"):
            d.mkdir(parents=True)
        os.symlink(UTILS, self.root / "usr" / "local" / "bin" / "k4all-utils")
        (self.root / "etc" / "node-type").write_text("worker\n")
        for name, body in FAKES.items():
            path = self.bin / name
            path.write_text("#!/bin/bash\n" + textwrap.dedent(body))
            path.chmod(0o755)
        self.addrs([NIC])
        (self.net / "route4").write_text(ROUTE + "\n")

    def addrs(self, lines):
        (self.net / "addrs").write_text("".join(line + "\n" for line in lines))

    def network(self, up_after=0, domain=None, domain_after=None):
        """The network comes up after `up_after` sleeps (None: never), with
        the DHCP domain `domain` after `domain_after` sleeps (default: with
        the network)."""
        if up_after is not None:
            (self.net / "up-after").write_text(str(up_after))
        if domain:
            (self.net / "domain").write_text(domain)
            at = up_after if domain_after is None else domain_after
            (self.net / "domain-after").write_text(str(at))

    def env(self):
        return dict(os.environ, K4ALL_ROOT=str(self.root), NET=str(self.net),
                    PATH="%s:%s" % (self.bin, os.environ["PATH"]))

    def run(self, *args, timeout=30):
        return subprocess.run(list(args), env=self.env(), capture_output=True,
                              text=True, timeout=timeout, check=False)

    def set_hostname(self):
        return self.run("bash", SET_HOSTNAME)

    def utils(self, function):
        return self.run("bash", "-c", 'source "$1"; %s' % function, "bash", UTILS)

    def calls(self):
        path = self.net / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def sleeps(self):
        path = self.net / "sleeps"
        return int(path.read_text()) if path.exists() else 0

    def done(self):
        return (self.root / "opt" / "k4all" / "setup-hostname.done").exists()

    def base_file(self):
        return self.root / "opt" / "k4all" / "setup-hostname.base"


@pytest.fixture
def node(tmp_path):
    return Node(tmp_path)


# --- set-hostname.sh ---------------------------------------------------------

def test_a_node_with_its_network_is_named_with_the_dhcp_domain(node):
    node.network(up_after=0, domain="lab.example")
    proc = node.set_hostname()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert node.calls() == ["hostnamectl set-hostname kube-worker-7x9ka.lab.example"]
    assert node.done()
    assert not node.base_file().exists()


def test_a_network_without_domain_gives_a_name_without_domain(node):
    node.network(up_after=0)
    proc = node.set_hostname()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert node.calls() == ["hostnamectl set-hostname kube-worker-7x9ka"]
    assert node.done(), "a network that gives no domain is a final answer"
    assert node.sleeps() == 4, "5 tries for the domain, as before"


# Issue #62: 5 tries 5 s apart, then the name without the domain for good.
def test_a_first_boot_without_network_waits_for_it_and_takes_the_domain(node):
    node.network(up_after=40, domain="lab.example")
    proc = node.set_hostname()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert node.calls() == [
        "hostnamectl set-hostname kube-worker-7x9ka",
        "hostnamectl set-hostname kube-worker-7x9ka.lab.example",
    ], "the name without the domain meanwhile, the same random part after"
    assert node.sleeps() == 40
    assert node.done()
    assert "No network yet: naming the node waits for it." in proc.stdout
    assert "Still no network after 60s" in proc.stdout


def test_the_domain_lease_may_come_after_the_first_address(node):
    # IPv6 autoconfiguration first, the DHCPv4 lease with the domain after.
    node.addrs([NIC6])
    node.network(up_after=0, domain="lab.example", domain_after=2)
    proc = node.set_hostname()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert node.calls() == ["hostnamectl set-hostname kube-worker-7x9ka.lab.example"]


def test_without_done_file_the_wait_starts_again_with_the_same_name(node):
    # A reboot during the wait (or a manual restart of the unit).
    node.base_file().write_text("kube-worker-zz9q1\n")
    node.network(up_after=3, domain="lab.example")
    proc = node.set_hostname()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert node.calls()[-1] == "hostnamectl set-hostname kube-worker-zz9q1.lab.example"


def test_a_node_already_in_a_cluster_keeps_its_name(node):
    (node.net / "hostname").write_text("kube-worker-old11\n")
    (node.root / "etc" / "kubernetes" / "kubelet.conf").write_text("x")
    node.network(up_after=None)
    proc = node.set_hostname()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert node.calls() == []
    assert node.done()
    assert "already in a cluster as kube-worker-old11" in proc.stdout


def test_a_named_node_is_left_alone(node):
    (node.root / "opt" / "k4all" / "setup-hostname.done").write_text("")
    node.network(up_after=None)
    proc = node.set_hostname()
    assert proc.returncode == 0
    assert node.calls() == []


def test_without_network_the_node_waits_and_writes_nothing(node):
    node.network(up_after=None)
    with pytest.raises(subprocess.TimeoutExpired):
        node.run("bash", SET_HOSTNAME, timeout=3)
    assert node.calls() == ["hostnamectl set-hostname kube-worker-7x9ka"]
    assert not node.done()
    assert node.base_file().read_text().strip() == "kube-worker-7x9ka"


# --- node_has_network --------------------------------------------------------

@pytest.mark.parametrize("addrs,route,expected", [
    ([NIC], True, True),
    ([NIC], False, True),          # a static address without a gateway
    ([NIC6], False, True),
    ([], True, True),
    ([CILIUM, CNI0], False, False),  # pod-network addresses are not a network
    ([], False, False),
])
def test_node_has_network(node, addrs, route, expected):
    node.addrs(addrs)
    if not route:
        (node.net / "route4").unlink()
    node.network(up_after=0)
    proc = node.utils("node_has_network")
    assert (proc.returncode == 0) is expected, proc.stderr


def test_wait_for_node_network_returns_once_the_network_is_up(node):
    node.network(up_after=2)
    proc = node.utils("set -x; wait_for_node_network test-step; echo after")
    assert proc.returncode == 0, proc.stderr
    assert node.sleeps() == 2
    assert "No network yet: test-step waits for it." in proc.stdout
    assert proc.stdout.rstrip().endswith("after")
    assert proc.stderr.count("+ node_has_network") == 1, \
        "the first check is traced, not every poll"


def test_wait_for_node_network_does_not_wait_with_a_network(node):
    node.network(up_after=0)
    proc = node.utils("wait_for_node_network test-step")
    assert proc.returncode == 0
    assert node.sleeps() == 0
    assert proc.stdout == ""


# --- the units and the steps after the name ---------------------------------

def unit(name):
    return read(SYSTEMD, name)


def test_the_name_has_no_start_timeout():
    assert "TimeoutStartSec=infinity" in unit("fck8s-set-hostname.service")


def test_the_network_steps_of_the_first_boot_come_after_the_name():
    ph2 = unit("fck8s-k8s-setup-ph2.service")
    assert "Requires=fck8s-set-hostname.service" in ph2
    assert "After=fck8s-set-hostname.service" in ph2
    ph3 = unit("fck8s-k8s-setup-ph3.service")
    assert "After=fck8s-k8s-setup-ph2.service" in ph3


def test_the_units_after_kubeadm_init_wait_across_its_retries():
    init = unit("fck8s-k8s-setup-init.service")
    assert "Restart=on-failure" in init
    assert "RestartMode=direct" in init
    for name in ("fck8s-node-ready-and-schedulable.service",
                 "fck8s-taint-master-schedulable.service"):
        assert "Requires=fck8s-k8s-setup-init.service" in unit(name)


def test_phase_3_waits_for_the_network_before_reading_the_address():
    script = read(PH3)
    done_check = script.index('if [ -f "/opt/k4all/setup-ph3.done" ]')
    wait = script.index('wait_for_node_network "Kubernetes setup phase 3"')
    cp_utils = script.index("source /var/opt/k4all/bin/control-plane-utils")
    assert done_check < wait < cp_utils, \
        "only on the first pass, and before CURRENT_IP is read"
