"""bootc/upgrade/release-checks.py: the guards of the release workflow."""

import os
import subprocess
import sys

from conftest import REPO

SCRIPT = os.path.join(REPO, "bootc", "upgrade", "release-checks.py")

TAGS = ["v1.8.2", "v2.0.0-beta1", "v2.2.4", "v2.3.0", "v2.4.0", "v2.5.0",
        "v2.6.0", "v2.6.1", "image-based", "1.5.4"]


def run(*args, stdin=""):
    return subprocess.run([sys.executable, SCRIPT] + list(args), input=stdin,
                          capture_output=True, text=True, check=False)


def tag_list(tags=TAGS):
    """What `git tag -l` prints."""
    return "".join(tag + "\n" for tag in tags)


def ls_remote(tags=TAGS):
    """What `git ls-remote --tags origin` prints, peeled tags included."""
    lines = []
    for tag in tags:
        lines.append("%s\trefs/tags/%s" % ("1" * 40, tag))
        lines.append("%s\trefs/tags/%s^{}" % ("2" * 40, tag))
    return "\n".join(lines) + "\n"


# --- new-version --------------------------------------------------------------
def test_a_version_that_is_a_tag_is_refused():
    for listing in (tag_list(), ls_remote()):
        proc = run("new-version", "v2.6.0", stdin=listing)
        assert proc.returncode == 1
        assert "v2.6.0 is already a tag" in proc.stderr
        assert "nodes follow by tag" in proc.stderr


def test_a_new_version_or_a_branch_build_is_accepted():
    for version in ("v2.6.2", "v2.7.0-rc1", "main", "dev-bootc-anaconda-addon"):
        proc = run("new-version", version, stdin=ls_remote())
        assert proc.returncode == 0, proc.stderr


def test_only_the_exact_tag_is_refused():
    # image tags are literal: 2.6.1 and v2.6.1-rc1 push other images
    for version in ("2.6.1", "v2.6.1-rc1"):
        assert run("new-version", version, stdin=ls_remote()).returncode == 0
