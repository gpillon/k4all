"""Versioning rules, the graph in the repo, and hop planning."""

import datetime
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys

import pytest
import yaml

from conftest import LADDER, REPO, ku, release

RELEASES_YAML = os.path.join(REPO, "bootc", "upgrade", "releases.yaml")


def graph(entries):
    return ku.load_graph(json.loads(json.dumps(entries)))


# --- versions ---------------------------------------------------------------
def test_semver_ordering_puts_prereleases_first():
    versions = ["v2.2.3", "v2.0.0", "v2.0.0-beta2", "v2.0.0-beta1",
                "v2.0.1-beta.0", "v2.10.0", "v2.2.10"]
    ordered = sorted(versions, key=ku.parse_version)
    assert ordered == ["v2.0.0-beta1", "v2.0.0-beta2", "v2.0.0",
                       "v2.0.1-beta.0", "v2.2.3", "v2.2.10", "v2.10.0"]


@pytest.mark.parametrize("a,b,kind", [
    ("v2.2.3", "v2.2.4", "patch"),
    ("v2.2.4", "v2.3.0", "minor"),
    ("v2.6.1", "v2.7.0", "minor"),
])
def test_hop_kind_follows_the_stream(a, b, kind):
    assert ku.hop_kind(a, b) == kind


@pytest.mark.parametrize("ref,version", [
    ("ghcr.io/gpillon/k4all-bootc:v2.2.3-amd64", "v2.2.3"),
    ("ghcr.io/gpillon/k4all-bootc:v2.0.0-beta2-arm64", "v2.0.0-beta2"),
    ("ghcr.io/gpillon/k4all-bootc:v2.2.4", "v2.2.4"),
    ("ghcr.io/gpillon/k4all-bootc:latest", None),
    ("ghcr.io/gpillon/k4all-bootc@sha256:abc", None),
])
def test_version_from_image_ref(ref, version):
    assert ku.version_from_ref(ref) == version


# --- the graph in the repo -----------------------------------------------------
def test_repo_graph_follows_the_versioning_rules():
    with open(RELEASES_YAML, encoding="utf-8") as fh:
        releases = ku.load_graph(yaml.safe_load(fh))
    assert releases, "releases.yaml lists no release"
    assert ku.validate_graph(releases) == []


def test_repo_graph_starts_with_the_bridge():
    with open(RELEASES_YAML, encoding="utf-8") as fh:
        first = ku.load_graph(yaml.safe_load(fh))[0]
    assert first.version == "v2.2.4"
    assert first.kubernetes.startswith("1.35.")
    assert first.fedora == 43
    assert first.crio == "1.32", "the bridge must not change the runtime"
    assert not first.sync_manifest


def test_agreed_ladder_is_valid(ladder):
    assert ku.validate_graph(ladder) == []


def skipped_syncs(releases):
    """(patch, skipped) pairs: a patch without syncManifest that a node can
    reach straight from before an earlier patch of its stream that syncs.
    The sync applies the target image's manifest, so the skipped changes
    (a new operator, say) would wait for some later release that syncs."""
    found = []
    for rel in releases:
        if rel.kind != "patch" or rel.sync_manifest:
            continue
        for other in releases:
            if other.kind == "patch" and other.sync_manifest \
                    and stream_of(other) == stream_of(rel) \
                    and rel.min_from_key < other.key < rel.key:
                found.append((rel.version, other.version))
    return found


def stream_of(rel):
    return ku.stream_of(rel.version)


def test_repo_graph_never_skips_a_manifest_sync():
    with open(RELEASES_YAML, encoding="utf-8") as fh:
        releases = ku.load_graph(yaml.safe_load(fh))
    assert skipped_syncs(releases) == []


def test_a_patch_that_skips_a_sync_is_found():
    releases = graph([
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
        release("v2.6.1", "patch", "v2.6.0", "1.36.6", "1.36", 45,
                syncManifest=True),
        release("v2.6.2", "patch", "v2.6.0", "1.36.7", "1.36", 45),
    ])
    assert versions(ku.plan_path(releases, "v2.6.0")) == ["v2.6.2"]
    assert skipped_syncs(releases) == [("v2.6.2", "v2.6.1")]
    # a v2.6.2 that only v2.6.1 reaches, or that syncs too, is fine
    assert skipped_syncs(graph([e.to_dict() for e in releases[:2]] + [
        release("v2.6.2", "patch", "v2.6.1", "1.36.7", "1.36", 45)])) == []


def test_a_patch_may_sync_the_manifest():
    # v2.6.1: a new operator, nothing else; Kubernetes, CRI-O, Fedora stay.
    releases = graph([
        release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
        release("v2.6.1", "patch", "v2.6.0", "1.36.6", "1.36", 45,
                syncManifest=True),
    ])
    assert ku.validate_graph(releases) == []
    path = ku.plan_path(releases, "v2.6.0")
    assert versions(path) == ["v2.6.1"] and path[0].sync_manifest
    assert versions(ku.auto_allowed(path, "v2.6.0", "patch")) == ["v2.6.1"]
    assert versions(ku.plan_path(releases, "v2.5.0")) == ["v2.6.0", "v2.6.1"]


def test_build_graph_script_emits_index_digests(tmp_path):
    out = tmp_path / "graph.json"
    script = os.path.join(REPO, "bootc", "upgrade", "build-graph.py")
    subprocess.run([sys.executable, script, RELEASES_YAML, "-o", str(out),
                    "--digest", "v2.2.4=sha256:feed"], check=True)
    doc = json.loads(out.read_text())
    assert doc["schema"] == 1
    assert doc["releases"][0]["indexDigest"] == "sha256:feed"
    # The tools of v2.2.4 - v2.6.0 stop in HOLD on a release under "digest".
    assert not [r["version"] for r in doc["releases"] if "digest" in r]
    assert ku.load_graph(doc)[0].image_ref("img") == "img@sha256:feed"


def test_build_graph_script_moves_a_digest_to_index_digest(tmp_path):
    source = tmp_path / "releases.yaml"
    source.write_text(yaml.safe_dump({"releases": [
        release("v2.2.4", "patch", "v2.0.0", "1.35.6", "1.32", 43,
                digest="sha256:feed")]}))
    script = os.path.join(REPO, "bootc", "upgrade", "build-graph.py")
    proc = subprocess.run([sys.executable, script, str(source)],
                          capture_output=True, text=True, check=True)
    entry, = json.loads(proc.stdout)["releases"]
    assert entry["indexDigest"] == "sha256:feed" and "digest" not in entry


@pytest.mark.parametrize("extra,ref", [
    ({"indexDigest": "sha256:aaa"}, "img@sha256:aaa"),
    ({"digest": "sha256:bbb"}, "img@sha256:bbb"),       # a graph up to v2.6.0
    ({"indexDigest": "sha256:aaa", "digest": "sha256:bbb"}, "img@sha256:aaa"),
    ({}, "img:v2.3.0"),
])
def test_a_release_reads_index_digest_then_digest(extra, ref):
    rel, = graph([release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43,
                          **extra)])
    assert rel.image_ref("img") == ref
    # what start_next_hop reads back from state.json
    assert ku.Release(rel.to_dict()).image_ref("img") == ref
    assert "digest" not in rel.to_dict()


SHIPPED_TOOL_TAGS = ["v2.2.4", "v2.3.0", "v2.4.0", "v2.5.0", "v2.6.0"]


def shipped_tool(tag, tmp_path):
    """k4all-upgrade as release ``tag`` ships it, from git."""
    try:
        text = subprocess.run(
            ["git", "-C", REPO, "show",
             "%s:bootc/overlay/usr/local/bin/k4all-upgrade" % tag],
            capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("tag %s is not in this checkout" % tag)
    path = tmp_path / ("k4all-upgrade-" + tag)
    path.write_text(text)
    name = "k4all_upgrade_" + tag.replace(".", "_")
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    module = importlib.util.module_from_spec(
        importlib.util.spec_from_loader(name, loader))
    loader.exec_module(module)
    return module


@pytest.mark.parametrize("tag", SHIPPED_TOOL_TAGS)
def test_the_shipped_tools_use_tags_with_a_graph_of_index_digests(tag, tmp_path):
    # Those tools keep their _same_image bug: they must keep switching to
    # release tags when the graph names the releases by index digest.
    old = shipped_tool(tag, tmp_path)
    entry = release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43,
                    indexDigest="sha256:aaa")
    rel, = old.load_graph({"releases": [entry]})
    assert rel.image_ref("img") == "img:v2.3.0"
    assert old.validate_graph(old.load_graph({"releases": [
        dict(e, indexDigest="sha256:aaa") for e in LADDER]})) == []
    # ...as they would not with "digest", which this test would catch
    rel, = old.load_graph({"releases": [dict(entry, digest="sha256:bbb")]})
    assert rel.image_ref("img") == "img@sha256:bbb"


def test_build_graph_script_rejects_an_invalid_graph(tmp_path):
    bad = tmp_path / "releases.yaml"
    bad.write_text(yaml.safe_dump({"releases": [
        release("v2.2.4", "patch", "v2.0.0", "1.35.6", "1.32", 43),
        release("v2.3.0", "minor", "v2.2.4", "1.37.0", "1.37", 43)]}))
    script = os.path.join(REPO, "bootc", "upgrade", "build-graph.py")
    proc = subprocess.run([sys.executable, script, str(bad)],
                          capture_output=True, text=True)
    assert proc.returncode == 1
    assert "Kubernetes jumps" in proc.stderr


# --- rule violations ---------------------------------------------------------
@pytest.mark.parametrize("entries,message", [
    ([release("v2.2.4", "patch", "v2.0.0", "1.35.6", "1.32", 43),
      release("v2.3.0", "minor", "v2.2.4", "1.37.0", "1.37", 43)],
     "Kubernetes jumps"),
    ([release("v2.2.4", "patch", "v2.0.0", "1.35.6", "1.32", 43),
      release("v2.3.0", "minor", "v2.2.4", "1.36.0", "1.36", 45)],
     "Kubernetes minor and Fedora together"),
    ([release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
      release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 45)],
     "a patch cannot change"),
    ([release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
      release("v2.3.1", "patch", "v2.2.4", "1.35.10", "1.35", 43)],
     "minFrom >= 2.3.0"),
    ([release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
      release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43),
      release("v2.5.0", "minor", "v2.3.0", "1.35.10", "1.35", 45)],
     "skips minor release v2.4.0"),
    ([release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
      release("v2.4.0", "minor", "v2.3.0", "1.36.0", "1.35", 43)],
     "no longer matches"),
    ([release("v2.3.1", "minor", "v2.2.4", "1.35.10", "1.35", 43)],
     "must be X.Y.0"),
    ([release("v2.3.0", "patch", "v2.2.4", "1.35.10", "1.35", 43),
      release("v2.4.0", "patch", "v2.3.0", "1.35.10", "1.35", 43)],
     "opening a new stream must be a minor"),
])
def test_rule_violations_are_reported(entries, message):
    errors = ku.validate_graph(graph(entries))
    assert any(message in e for e in errors), errors


# --- planning --------------------------------------------------------------------
def versions(path):
    return [r.version for r in path]


def test_old_release_walks_every_minor(ladder):
    path = ku.plan_path(ladder, "v2.2.4")
    assert versions(path) == ["v2.3.0", "v2.4.0", "v2.5.0", "v2.6.0",
                              "v2.6.1", "v2.7.0", "v2.8.0", "v2.9.0"]


def test_plan_stops_at_the_requested_target(ladder):
    assert versions(ku.plan_path(ladder, "v2.2.4", "v2.4.0")) == ["v2.3.0", "v2.4.0"]


def test_plan_is_empty_when_up_to_date(ladder):
    assert ku.plan_path(ladder, "v2.9.0") == []


def test_patches_inside_a_stream_are_skipped():
    releases = graph([
        release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
        release("v2.3.1", "patch", "v2.3.0", "1.35.11", "1.35", 43),
        release("v2.3.2", "patch", "v2.3.0", "1.35.12", "1.35", 43),
    ])
    assert versions(ku.plan_path(releases, "v2.3.0")) == ["v2.3.2"]


def test_stream_is_finished_before_crossing_a_minor():
    releases = graph([
        release("v2.6.0", "minor", "v2.5.0", "1.35.10", "1.35", 45),
        release("v2.6.1", "patch", "v2.6.0", "1.35.11", "1.35", 45),
        release("v2.7.0", "minor", "v2.6.0", "1.36.6", "1.36", 45),
    ])
    assert versions(ku.plan_path(releases, "v2.6.0")) == ["v2.6.1", "v2.7.0"]


def test_blocked_release_is_never_picked():
    releases = graph([
        release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
        release("v2.3.1", "patch", "v2.3.0", "1.35.11", "1.35", 43, blocked=True),
    ])
    assert ku.plan_path(releases, "v2.3.0") == []
    with pytest.raises(ku.NoPathError):
        ku.plan_path(releases, "v2.3.0", "v2.3.1")


def test_no_path_from_a_release_older_than_every_minfrom(ladder):
    with pytest.raises(ku.NoPathError):
        ku.plan_path(ladder[1:], "v2.2.3")


def test_bridge_is_reachable_from_any_2x(ladder):
    assert versions(ku.plan_path(ladder, "v2.0.0-beta1", "v2.2.4")) == ["v2.2.4"]


def test_auto_policy_keeps_only_patch_hops():
    releases = graph([
        release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
        release("v2.3.1", "patch", "v2.3.0", "1.35.11", "1.35", 43),
        release("v2.4.0", "minor", "v2.3.0", "1.35.11", "1.35", 43),
    ])
    path = ku.plan_path(releases, "v2.3.0")
    assert versions(ku.auto_allowed(path, "v2.3.0", "patch")) == ["v2.3.1"]
    assert versions(ku.auto_allowed(path, "v2.3.0", "minor")) == ["v2.3.1", "v2.4.0"]


# --- maintenance window --------------------------------------------------------
WINDOW = {"days": ["Sat"], "start": "02:30", "durationMinutes": 120}


@pytest.mark.parametrize("when,inside", [
    (datetime.datetime(2026, 11, 21, 2, 30), True),    # Saturday start
    (datetime.datetime(2026, 11, 21, 4, 29), True),
    (datetime.datetime(2026, 11, 21, 4, 30), False),   # end is exclusive
    (datetime.datetime(2026, 11, 21, 2, 29), False),
    (datetime.datetime(2026, 11, 22, 2, 45), False),   # Sunday
])
def test_window(when, inside):
    assert ku.in_window(when, WINDOW) is inside


def test_window_crossing_midnight():
    window = {"days": ["Sat"], "start": "23:30", "durationMinutes": 120}
    assert ku.in_window(datetime.datetime(2026, 11, 22, 0, 45), window)
    assert not ku.in_window(datetime.datetime(2026, 11, 22, 1, 31), window)


def test_next_window_start():
    start = ku.next_window_start(datetime.datetime(2026, 11, 17, 10, 0), WINDOW)
    assert start == datetime.datetime(2026, 11, 21, 2, 30)


@pytest.mark.parametrize("user,message", [
    ({"mode": "sometimes"}, "mode must be"),
    ({"autoAllow": "major"}, "autoAllow must be"),
    ({"window": {"days": ["Saturday"]}}, "unknown window day"),
    ({"window": {"start": "25:00"}}, "HH:MM"),
])
def test_bad_config_is_rejected(user, message):
    with pytest.raises(ku.UpgradeError, match=message):
        ku.merge_config(user)


def test_default_config_file_matches_the_built_in_defaults():
    path = os.path.join(REPO, "bootc", "overlay", "usr", "local", "share",
                        "k4all-upgrade.yaml.default")
    with open(path, encoding="utf-8") as fh:
        user = yaml.safe_load(fh)
    cfg = ku.merge_config(user)
    assert cfg["mode"] == "auto"
    assert cfg["autoAllow"] == "patch"
    assert cfg["window"] == WINDOW
