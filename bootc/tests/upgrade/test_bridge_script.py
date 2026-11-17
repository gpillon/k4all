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
              admin=True, free_kib=50 * 1024 * 1024):
        status = {"status": {"booted": {"image": {"image": {"image": booted}}},
                             "staged": ({"image": {"image": {"image": staged}}}
                                        if staged else None)}}
        (tmp_path / "status.json").write_text(json.dumps(status))
        _fake(bin_dir, "bootc", 'if [ "$1" = status ]; then cat %s; else echo "bootc $*" >> %s; fi\n'
              % (tmp_path / "status.json", log))
        _fake(bin_dir, "systemctl", 'echo "systemctl $*" >> %s\n' % log)
        _fake(bin_dir, "kubectl", "cat <<'EOF'\n%sEOF\n" % nodes)
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

    def run(*args):
        env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
                   K4ALL_ROOT=str(root))
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


def test_now_reboots_into_the_bridge(node):
    setup, run = node
    setup()
    proc, calls = run("--now")
    assert proc.returncode == 0, proc.stderr
    assert calls[-1] == "bootc switch --apply ghcr.io/gpillon/k4all-bootc:v2.2.4"


def test_dry_run_changes_nothing(node):
    setup, run = node
    setup()
    proc, calls = run("--dry-run")
    assert proc.returncode == 0, proc.stderr
    assert calls == []
    assert "would run: bootc switch" in proc.stdout


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
