"""bootc/upgrade/release-checks.py: the guards of the release workflow."""

import importlib.machinery
import importlib.util
import json
import os
import stat
import subprocess
import sys

import pytest

from conftest import REPO

SCRIPT = os.path.join(REPO, "bootc", "upgrade", "release-checks.py")

TAGS = ["v1.8.2", "v2.0.0-beta1", "v2.2.4", "v2.3.0", "v2.4.0", "v2.5.0",
        "v2.6.0", "v2.6.1", "image-based", "1.5.4"]


def run(*args, stdin="", env=None):
    return subprocess.run([sys.executable, SCRIPT] + list(args), input=stdin,
                          capture_output=True, text=True, check=False, env=env)


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


# --- graph --------------------------------------------------------------------
IMAGE = "ghcr.io/gpillon/k4all-bootc"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"


def load_checks():
    loader = importlib.machinery.SourceFileLoader("release_checks", SCRIPT)
    module = importlib.util.module_from_spec(
        importlib.util.spec_from_loader("release_checks", loader))
    loader.exec_module(module)
    return module


checks = load_checks()


def entry(version, **extra):
    data = {"version": version, "kind": "minor", "minFrom": "v2.2.4",
            "kubernetes": "1.35.10", "crio": "1.35", "fedora": 43}
    data.update(extra)
    return data


def registry(manifests):
    """A lookup over {version: manifest} for graph_errors."""
    def lookup(image, version):
        assert image == IMAGE
        if version not in manifests:
            raise LookupError("%s:%s: not found" % (image, version))
        return manifests[version]
    return lookup


def index(digest):
    return {"mediaType": OCI_INDEX, "digest": digest, "size": 1234}


def test_a_graph_of_registry_index_digests_passes():
    doc = {"schema": 1, "image": IMAGE, "releases": [
        entry("v2.3.0", indexDigest="sha256:aaa"),
        entry("v2.4.0", indexDigest="sha256:bbb")]}
    lookup = registry({"v2.3.0": index("sha256:aaa"),
                       "v2.4.0": index("sha256:bbb")})
    assert checks.graph_errors(doc, lookup) == []


def test_a_docker_manifest_list_is_an_index_too():
    doc = {"image": IMAGE, "releases": [entry("v2.3.0", indexDigest="sha256:aaa")]}
    manifest = {"mediaType":
                "application/vnd.docker.distribution.manifest.list.v2+json",
                "digest": "sha256:aaa"}
    assert checks.graph_errors(doc, registry({"v2.3.0": manifest})) == []


def test_an_entry_with_digest_fails():
    # the graph that put v2.2.4 - v2.6.0 nodes in HOLD at STAGE on 18 Nov
    doc = {"image": IMAGE, "releases": [
        entry("v2.3.0", indexDigest="sha256:aaa", digest="sha256:aaa")]}
    errors = checks.graph_errors(doc, registry({"v2.3.0": index("sha256:aaa")}))
    assert len(errors) == 1 and "v2.3.0 has digest" in errors[0]


@pytest.mark.parametrize("manifests,extra,message", [
    ({"v2.3.0": index("sha256:new")}, {"indexDigest": "sha256:old"},
     "indexDigest is sha256:old, the registry has sha256:new"),
    ({"v2.3.0": index("sha256:aaa")}, {}, "v2.3.0 has no indexDigest"),
    ({}, {"indexDigest": "sha256:aaa"}, "cannot read %s:v2.3.0" % IMAGE),
    ({"v2.3.0": {"mediaType": "application/vnd.oci.image.manifest.v1+json",
                 "digest": "sha256:aaa"}},
     {"indexDigest": "sha256:aaa"}, "not a multi-arch index"),
])
def test_an_index_digest_that_is_not_the_registry_one_fails(manifests, extra,
                                                            message):
    doc = {"image": IMAGE, "releases": [entry("v2.3.0", **extra)]}
    errors = checks.graph_errors(doc, registry(manifests))
    assert len(errors) == 1 and message in errors[0]


@pytest.mark.parametrize("doc", [[], {"releases": [entry("v2.3.0")]},
                                 {"image": IMAGE, "releases": []}])
def test_a_graph_without_image_or_releases_fails(doc):
    assert checks.graph_errors(doc, registry({}))


def fake_docker(tmp_path, manifests):
    """A docker whose `buildx imagetools inspect REF --format ...` prints
    manifests[REF], as the real one prints {{json .Manifest}}."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "registry.json").write_text(json.dumps(manifests))
    docker = bin_dir / "docker"
    docker.write_text(
        "#!%s\nimport json, sys\n"
        "ref = sys.argv[sys.argv.index('inspect') + 1]\n"
        "registry = json.load(open(%r))\n"
        "if ref not in registry:\n"
        "    sys.exit('ERROR: %%s: not found' %% ref)\n"
        "print(json.dumps(registry[ref]))\n"
        % (sys.executable, str(tmp_path / "registry.json")))
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
    return dict(os.environ, PATH="%s%s%s" % (bin_dir, os.pathsep,
                                             os.environ["PATH"]))


def test_the_graph_command_reads_the_registry_with_docker(tmp_path):
    env = fake_docker(tmp_path, {IMAGE + ":v2.3.0": index("sha256:aaa"),
                                 IMAGE + ":v2.4.0": index("sha256:bbb")})
    path = tmp_path / "upgrade-graph.json"
    path.write_text(json.dumps({"schema": 1, "image": IMAGE, "releases": [
        entry("v2.3.0", indexDigest="sha256:aaa"),
        entry("v2.4.0", indexDigest="sha256:bbb")]}))
    proc = run("graph", str(path), env=env)
    assert proc.returncode == 0, proc.stderr
    assert "(2 releases)" in proc.stdout

    path.write_text(json.dumps({"schema": 1, "image": IMAGE, "releases": [
        entry("v2.3.0", indexDigest="sha256:aaa"),
        entry("v2.5.0", indexDigest="sha256:ccc", digest="sha256:ccc")]}))
    proc = run("graph", str(path), env=env)
    assert proc.returncode == 1
    assert "v2.5.0 has digest" in proc.stderr
    assert "cannot read %s:v2.5.0" % IMAGE in proc.stderr


def test_the_graph_command_fails_on_a_file_it_cannot_read(tmp_path):
    proc = run("graph", str(tmp_path / "missing.json"))
    assert proc.returncode == 1 and "cannot read" in proc.stderr


# --- latest -------------------------------------------------------------------
@pytest.mark.parametrize("version,tags,latest", [
    ("v2.6.1", TAGS, "true"),
    ("v2.6.2", TAGS + ["v2.6.2"], "true"),
    # 18 Nov: v2.3.0's release job finished last and took Latest from v2.6.0
    ("v2.3.0", TAGS, "false"),
    ("v2.6.0", TAGS, "false"),
    # GitHub never makes a prerelease Latest: neither the version nor a tag
    ("v2.7.0-rc1", TAGS + ["v2.7.0-rc1"], "false"),
    ("v2.6.2", TAGS + ["v2.6.2", "v2.7.0-rc1"], "true"),
    # versions compare as semver, not as strings
    ("v2.10.0", TAGS + ["v2.9.0", "v2.10.0"], "true"),
    ("v2.9.0", TAGS + ["v2.9.0", "v2.10.0"], "false"),
    # tags that are not v* release versions do not count
    ("v2.6.1", TAGS + ["image-based", "9.9.9", "headlamp-plugin-v0.1.2"], "true"),
    ("main", TAGS, "false"),
])
def test_only_the_highest_release_becomes_latest(version, tags, latest):
    proc = run("latest", version, stdin=ls_remote(tags))
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == latest
