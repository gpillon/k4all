"""reinstall.sh on 2.x (#68): which first-boot steps it makes run again, and
why --kubernetes refuses.

The script runs for real in bash against a fake root, with a fake
`systemctl` that records the reboot.
"""

import os
import subprocess

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")
REINSTALL = os.path.join(BIN, "reinstall.sh")

# The done files of a 2.x node after its install (a bootstrap node has no
# auto-join.done; the union keeps one list).
DONE = [
    "first-boot.done", "restore.done", "role-dispatcher.done",
    "lvm-setup.done", "setup-hostname.done", "setup-proxy.done",
    "setup-ph2.done", "setup-ph3-reset-kube.done", "setup-ph3.done",
    "k8s-setup-init.done", "setup-taint-master-schedulable.done",
    "operator-deployed.done", "auto-join.done",
]


class Node:
    def __init__(self, tmp):
        self.done = tmp / "root" / "opt" / "k4all"
        self.done.mkdir(parents=True)
        for name in DONE:
            (self.done / name).write_text("")
        self.bin = tmp / "bin"
        self.bin.mkdir()
        self.calls = tmp / "calls"
        systemctl = self.bin / "systemctl"
        systemctl.write_text('#!/bin/bash\necho "systemctl $*" >> "%s"\n' % self.calls)
        systemctl.chmod(0o755)
        self.root = tmp / "root"

    def run(self, *args, stdin=""):
        env = dict(os.environ, K4ALL_ROOT=str(self.root),
                   PATH="%s:%s" % (self.bin, os.environ["PATH"]))
        return subprocess.run(["bash", REINSTALL, *args], env=env, input=stdin,
                              capture_output=True, text=True, check=False)

    def left(self):
        return sorted(os.listdir(self.done))

    def reboots(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def reinstall(self, *args):
        proc = self.run(*args)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert self.reboots() == ["systemctl reboot"]
        return self.left()


@pytest.fixture
def node(tmp_path):
    return Node(tmp_path)


# --- the base reinstall -------------------------------------------------------

def test_the_base_reinstall_repeats_only_the_safe_checks(node):
    left = node.reinstall("--yes")
    assert sorted(set(DONE) - set(left)) == [
        "auto-join.done", "first-boot.done", "lvm-setup.done"]


def test_a_reinstall_never_restores_a_backup(node):
    # fck8s-restore.service runs at every boot without restore.done, and
    # restores the newest backup in /var/opt/k4all/backups, where
    # k4all-backup.sh writes by default.
    assert "restore.done" in node.reinstall("--yes")


def test_a_reinstall_never_reapplies_the_nodes_files_over_the_cluster(node):
    # deploy-operator.sh `kubectl apply`s /etc/k4all-config.yaml and
    # /etc/k4all-release.yaml as the ClusterConfig and the ReleaseManifest.
    assert "operator-deployed.done" in node.reinstall("--yes")


def test_a_reinstall_keeps_the_nodes_kubeadm_config(node):
    # Without role-dispatcher.done the dispatcher copies the template over
    # /etc/k8s-config.yaml: no endpoint, certSANs or networks of the node.
    left = node.reinstall("--yes")
    assert "role-dispatcher.done" in left
    assert "setup-taint-master-schedulable.done" in left


def test_the_flags_remove_their_own_steps(node):
    left = node.reinstall("--yes", "--no-base", "--network", "--hostname")
    assert sorted(set(DONE) - set(left)) == [
        "setup-hostname.done", "setup-ph2.done", "setup-ph3.done",
        "setup-proxy.done"]


def test_an_answer_other_than_yes_changes_nothing(node):
    proc = node.run(stdin="no\n")
    assert proc.returncode == 0
    assert "Aborted by user." in proc.stdout
    assert node.left() == sorted(DONE)
    assert node.reboots() == []


# --- --kubernetes -------------------------------------------------------------

@pytest.mark.parametrize("args", [
    ("--kubernetes",),
    ("--yes", "--kubernetes"),
    ("--yes", "--network", "--kubernetes", "--hostname"),
    ("--yes", "--no-base", "--kubernetes"),
])
def test_kubernetes_refuses_and_changes_nothing(node, args):
    proc = node.run(*args, stdin="yes\n")
    assert proc.returncode != 0
    assert "does not work on k4all 2.x: nothing was changed" in proc.stderr
    assert "k4all-backup.sh" in proc.stderr and "Restore" in proc.stderr
    assert "https://github.com/gpillon/k4all/issues/68" in proc.stderr
    assert node.left() == sorted(DONE)
    assert node.reboots() == []


def test_the_refusal_matches_phase_3():
    # The reason for the refusal: phase 3 skips `kubeadm reset` whenever
    # restore.done exists, and fck8s-restore writes it on every install.
    ph3 = open(os.path.join(BIN, "overrides", "bootstrap-control",
                            "setup-k8s-ph3.sh"), encoding="utf-8").read()
    assert "|| [ -f /opt/k4all/restore.done ]; then" in ph3
    restore = open(os.path.join(BIN, "k4all-restore.sh"), encoding="utf-8").read()
    no_backup = restore[restore.index('log "No backup archive found'):]
    assert 'touch "$RESTORE_DONE"' in no_backup[:200]


def test_restore_runs_whenever_its_done_file_is_missing():
    with open(os.path.join(BOOTC, "systemd", "fck8s-restore.service"),
              encoding="utf-8") as fh:
        assert "ConditionPathExists=!/opt/k4all/restore.done" in fh.read()
