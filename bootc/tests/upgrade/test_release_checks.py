"""bootc/upgrade/release-checks.py: the guards of the release workflow."""

import json
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


# --- published ----------------------------------------------------------------
RELEASES = json.dumps([
    {"tagName": "v2.6.1", "isDraft": False},
    {"tagName": "v2.6.2", "isDraft": True},
    {"tagName": "v2.3.0", "isDraft": False},
])


def test_a_published_release_is_reported_as_published():
    proc = run("published", "v2.3.0", stdin=RELEASES)
    assert proc.returncode == 0 and proc.stdout.strip() == "true"


def test_a_draft_or_a_missing_release_is_not_published():
    for version in ("v2.6.2", "v2.7.0"):
        proc = run("published", version, stdin=RELEASES)
        assert proc.returncode == 0 and proc.stdout.strip() == "false"


def test_an_unreadable_release_list_fails():
    # never "false": the job would then write a published release's graph
    for listing in ("", "gh: HTTP 502", '{"tagName": "v2.3.0"}'):
        proc = run("published", "v2.3.0", stdin=listing)
        assert proc.returncode == 1 and proc.stdout == ""
