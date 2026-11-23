"""k4all-backup.sh's command line (#82).

`--help` used to be taken as the output path: `mkdir -p --help` printed
mkdir's help, and as root the script went on with a backup into "--help".
The script runs for real, with a fake `id` that says it is not root, so no
version of it can start a backup here.
"""

import os
import stat
import subprocess

from conftest import REPO

BACKUP = os.path.join(REPO, "bootc", "overlay", "usr", "local", "bin", "k4all-backup.sh")


def run_backup(tmp_path, *args):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake_id = bin_dir / "id"
    fake_id.write_text("#!/bin/sh\necho 1000\n")
    fake_id.chmod(fake_id.stat().st_mode | stat.S_IEXEC)
    env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]))
    return subprocess.run(["bash", BACKUP, *args], cwd=tmp_path, env=env,
                          capture_output=True, text=True, check=False, timeout=30)


def test_help_prints_the_usage(tmp_path):
    for flag in ("--help", "-h"):
        proc = run_backup(tmp_path, flag)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert "Usage: k4all-backup.sh [output-path]" in proc.stdout
        assert "/var/opt/k4all/backups" in proc.stdout
        assert "mkdir" not in proc.stdout + proc.stderr


def test_an_unknown_option_is_refused(tmp_path):
    proc = run_backup(tmp_path, "--bogus")
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "unknown option --bogus" in proc.stderr
    assert "Usage: k4all-backup.sh" in proc.stderr
    assert not (tmp_path / "--bogus").exists()


def test_more_than_one_path_is_refused(tmp_path):
    proc = run_backup(tmp_path, "/tmp/a", "/tmp/b")
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "one output path at most" in proc.stderr


def test_a_path_still_needs_root(tmp_path):
    proc = run_backup(tmp_path, str(tmp_path / "out"))
    assert proc.returncode == 1
    assert "must be run as root" in proc.stderr
    assert not (tmp_path / "out").exists()
