"""reinstall.sh: which first-boot steps it makes run again.

The script runs for real in bash against a fake root, with a fake
`systemctl` that records the reboot.
"""

import os
import subprocess

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
REINSTALL = os.path.join(BOOTC, "overlay", "usr", "local", "bin", "reinstall.sh")

# The done files of a 2.x bootstrap node after its install.
DONE = [
    "first-boot.done", "restore.done", "role-dispatcher.done",
    "setup-hostname.done", "setup-proxy.done", "setup-ph2.done",
    "setup-ph3-reset-kube.done", "setup-ph3.done", "k8s-setup-init.done",
    "setup-taint-master-schedulable.done", "operator-deployed.done",
]


@pytest.fixture
def node(tmp_path):
    done = tmp_path / "root" / "opt" / "k4all"
    done.mkdir(parents=True)
    for name in DONE:
        (done / name).write_text("")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls"
    systemctl = bin_dir / "systemctl"
    systemctl.write_text('#!/bin/bash\necho "systemctl $*" >> "%s"\n' % calls)
    systemctl.chmod(0o755)

    def run(*args):
        env = dict(os.environ, K4ALL_ROOT=str(tmp_path / "root"),
                   PATH="%s:%s" % (bin_dir, os.environ["PATH"]))
        proc = subprocess.run(["bash", REINSTALL, *args], env=env,
                              capture_output=True, text=True, check=False)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert calls.read_text().splitlines() == ["systemctl reboot"]
        return sorted(os.listdir(done))

    return run


def test_a_reinstall_never_restores_a_backup(node):
    # fck8s-restore.service runs at every boot without restore.done, and
    # restores the newest backup in /var/opt/k4all/backups, where
    # k4all-backup.sh writes by default.
    left = node("--yes")
    assert "restore.done" in left


def test_the_base_reinstall_runs_the_other_steps_again(node):
    left = node("--yes")
    assert left == sorted([
        "restore.done", "setup-hostname.done", "setup-proxy.done",
        "setup-ph2.done", "setup-ph3-reset-kube.done", "setup-ph3.done",
        "k8s-setup-init.done"])


def test_the_flags_remove_their_own_steps(node):
    left = node("--yes", "--no-base", "--kubernetes", "--network")
    assert left == sorted([
        "first-boot.done", "restore.done", "role-dispatcher.done",
        "setup-hostname.done", "setup-taint-master-schedulable.done",
        "operator-deployed.done"])


def test_restore_runs_whenever_its_done_file_is_missing():
    with open(os.path.join(BOOTC, "systemd", "fck8s-restore.service"),
              encoding="utf-8") as fh:
        assert "ConditionPathExists=!/opt/k4all/restore.done" in fh.read()
