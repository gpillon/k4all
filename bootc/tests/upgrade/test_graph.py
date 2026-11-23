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


def in_ci():
    """True under a CI runner: GitHub Actions sets CI=true."""
    return os.environ.get("CI", "").lower() not in ("", "0", "false", "no")


def missing_tag(tag):
    """Skip the test, or fail it in CI: a checkout without tags
    (actions/checkout fetches none by default) would otherwise drop the
    checks against published releases without a word."""
    message = "tag %s is not in this checkout" % tag
    if in_ci():
        pytest.fail(message + ": in CI the checkout needs the tags "
                    "(actions/checkout with fetch-depth: 0)")
    pytest.skip(message)


def shipped_tool(tag, tmp_path):
    """k4all-upgrade as release ``tag`` ships it, from git (missing_tag
    without the tag)."""
    try:
        text = subprocess.run(
            ["git", "-C", REPO, "show",
             "%s:bootc/overlay/usr/local/bin/k4all-upgrade" % tag],
            capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        missing_tag(tag)
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


def test_a_missing_tag_fails_in_ci_and_is_skipped_elsewhere(tmp_path,
                                                            monkeypatch):
    monkeypatch.setenv("CI", "true")
    with pytest.raises(pytest.fail.Exception, match="fetch-depth: 0"):
        shipped_tool("v0.0.0-missing", tmp_path)
    monkeypatch.delenv("CI")
    with pytest.raises(pytest.skip.Exception):
        shipped_tool("v0.0.0-missing", tmp_path)


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


def stream_with_a_blocked_patch(exit_min_from="v2.5.4"):
    """The review's case (#74): v2.5.4 is blocked, and v2.5.5, the latest
    patch of 2.5, comes only from v2.5.4 (an exit patch, ADR-0010)."""
    return graph([
        release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
        release("v2.5.3", "patch", "v2.5.0", "1.35.10", "1.35", 45),
        release("v2.5.4", "patch", "v2.5.0", "1.35.10", "1.35", 45,
                blocked=True),
        release("v2.5.5", "patch", exit_min_from, "1.35.10", "1.35", 45),
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
    ])


def test_a_node_does_not_leave_its_stream_below_a_patch_it_cannot_reach():
    releases = stream_with_a_blocked_patch()
    assert ku.validate_graph(releases) == []
    with pytest.raises(ku.NoPathError,
                       match="cannot leave v2.5.3 before reaching v2.5.5"):
        ku.plan_path(releases, "v2.5.3")
    with pytest.raises(ku.NoPathError, match="v2.5.5"):
        ku.check_single_hop(releases, "v2.5.3", "v2.6.0")
    # inside the stream nothing changes: v2.5.3 is its own latest reachable
    assert ku.plan_path(releases, "v2.5.3", "v2.5.3") == []
    # a node that can reach the latest patch goes through it
    assert versions(ku.plan_path(stream_with_a_blocked_patch("v2.5.3"),
                                 "v2.5.3")) == ["v2.5.5", "v2.6.0"]


def unreachable_patches(releases):
    """Usable releases that no sequence of hops reaches from their stream's
    X.Y.0 (listed or not) without a blocked release: a node of the stream
    below one of them cannot finish the stream. The tools of v2.2.4 - v2.6.5
    do not see it and leave the stream without it; later tools stop with
    NoPathError. Every node of a stream is at X.Y.0 or later, and minFrom
    is a lower bound, so what X.Y.0 reaches every later node reaches."""
    found = []
    for stream in sorted({ku.stream_of(r.version) for r in releases}):
        start = ku.parse_version("v%d.%d.0" % stream)
        members = [r for r in releases
                   if not r.blocked and r.key > start
                   and ku.stream_of(r.version) == stream]
        reached = [start]
        for rel in members:         # oldest first: hops only go up
            if any(rel.min_from_key <= key < rel.key for key in reached):
                reached.append(rel.key)
            else:
                found.append(rel.version)
    return found


def test_a_patch_no_hop_reaches_is_found():
    # The tools of v2.2.4 - v2.6.5 leave the stream below v2.5.5 without a
    # word: the graph must never give them the chance (#74).
    assert unreachable_patches(stream_with_a_blocked_patch()) == ["v2.5.5"]
    assert unreachable_patches(stream_with_a_blocked_patch("v2.5.3")) == []


def test_repo_graph_reaches_every_patch_of_a_stream_from_its_minor():
    with open(RELEASES_YAML, encoding="utf-8") as fh:
        releases = ku.load_graph(yaml.safe_load(fh))
    assert unreachable_patches(releases) == []


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


# --- pinned versions never go down (ADR-0010) ----------------------------------
def components(**versions):
    """spec.components of a release manifest: name=version, every one
    Managed. Underscores stand for dashes (k4all_operator)."""
    return {name.replace("_", "-"): {"version": version}
            for name, version in versions.items()}


def hops_allowed(releases):
    """{release: releases one hop can reach}: every hop the versioning rules
    allow (minFrom, no minor skipped, nothing blocked), whatever the target.
    plan_path picks among these; a plan saved before a release was published
    may take one it would not pick today."""
    minors = [r for r in releases if r.kind == "minor"]
    return {p.version: [r for r in releases
                        if not r.blocked and r.min_from_key <= p.key < r.key
                        and not any(p.key < m.key < r.key for m in minors)]
            for p in releases}


def reachable(releases):
    """{release: every release some sequence of hops reaches from it}."""
    hops = hops_allowed(releases)
    reach = {}
    for rel in reversed(releases):      # newest first: hops only go up
        reach[rel.version] = set()
        for nxt in hops[rel.version]:
            reach[rel.version] |= {nxt.version} | reach[nxt.version]
    return reach


def pin_decreases(releases, manifests):
    """(from, sync, component, pinned, synced) for every component version
    of release ``from``'s manifest that a later manifest sync, at release
    ``sync``, would move down. ``manifests`` maps each release to the
    spec.components of its release manifest."""
    reach = reachable(releases)
    by_version = {r.version: r for r in releases}
    found = []
    for start in releases:
        for sync in sorted(reach[start.version], key=ku.parse_version):
            if not by_version[sync].sync_manifest:
                continue
            for name, spec in manifests[start.version].items():
                new = manifests[sync].get(name)
                if new is None or "Removed" in (spec.get("management"),
                                                new.get("management")):
                    continue
                old_v, new_v = spec.get("version"), new.get("version")
                old_key, new_key = pin_key(old_v), pin_key(new_v)
                if old_key is None:
                    continue        # a floating pin: nothing to go below
                if new_key is None or new_key < old_key:
                    found.append((start.version, sync, name, old_v, new_v))
    return found


RELEASE_MANIFEST_PATH = "bootc/overlay/usr/local/share/k4all-release.yaml"
RELEASE_MANIFEST = os.path.join(REPO, RELEASE_MANIFEST_PATH)


def release_manifests(releases):
    """{release: spec.components of its release manifest}, from its tag.

    The newest release of the graph may have no tag yet (the release being
    prepared): it gets the working tree's manifest. Any other release must
    be tagged before the graph lists it (missing_tag)."""
    newest = releases[-1].version
    out = {}
    for rel in releases:
        proc = subprocess.run(
            ["git", "-C", REPO, "show",
             "%s:%s" % (rel.version, RELEASE_MANIFEST_PATH)],
            capture_output=True, text=True, check=False)
        if proc.returncode == 0:
            text = proc.stdout
        elif rel.version == newest:
            with open(RELEASE_MANIFEST, encoding="utf-8") as fh:
                text = fh.read()
        else:
            missing_tag(rel.version)
        out[rel.version] = (yaml.safe_load(text).get("spec") or {}).get(
            "components") or {}
    return out


def pin_key(version):
    """A sortable key for a component's pinned version, or None when the pin
    is not a semver version (latest, master, empty). Semver precedence: the
    leading v is optional, a prerelease sorts before its release, build
    metadata does not count."""
    text = str(version or "").split("+", 1)[0]
    return ku.parse_version(text) if ku.is_version(text) else None


def test_a_stream_patched_after_the_next_minor_is_caught():
    # The review's scenario B: v2.5.7, cut from a maintenance branch after
    # v2.6.0, pins operator v0.5.4. A node on it goes to v2.6.0 (no sync),
    # then, with --to v2.6.1, to a sync of operator v0.5.1.
    releases = graph([
        release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
        release("v2.5.6", "patch", "v2.5.0", "1.35.10", "1.35", 45),
        release("v2.5.7", "patch", "v2.5.0", "1.35.10", "1.35", 45,
                syncManifest=True),
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
        release("v2.6.1", "patch", "v2.6.0", "1.36.6", "1.36", 45,
                syncManifest=True),
        release("v2.6.4", "patch", "v2.6.0", "1.36.6", "1.36", 45,
                syncManifest=True),
    ])
    manifests = {
        "v2.5.0": components(k4all_operator="v0.5.0", cilium="1.20.4"),
        "v2.5.6": components(k4all_operator="v0.5.0", cilium="1.20.4"),
        "v2.5.7": components(k4all_operator="v0.5.4", cilium="1.20.4"),
        "v2.6.0": components(k4all_operator="v0.5.0", cilium="1.20.4"),
        "v2.6.1": components(k4all_operator="v0.5.1", cilium="1.20.4"),
        "v2.6.4": components(k4all_operator="v0.5.4", cilium="1.20.4"),
    }
    # the default path from v2.5.7 is v2.6.0, v2.6.4: v2.6.1 only by target
    assert versions(ku.plan_path(releases, "v2.5.7")) == ["v2.6.0", "v2.6.4"]
    assert pin_decreases(releases, manifests) == [
        ("v2.5.7", "v2.6.1", "k4all-operator", "v0.5.4", "v0.5.1")]


def first_sync(before, after):
    """v2.3.0, then v2.4.0 with the first manifest sync."""
    releases = graph([
        release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
        release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
                syncManifest=True),
    ])
    return releases, {"v2.3.0": before, "v2.4.0": after}


def test_a_floating_pin_before_the_first_sync_is_not_a_decrease():
    # v2.2.4 and v2.3.0 say latest, master or nothing for some components
    releases, manifests = first_sync(
        components(kube_vip="latest", multus_cni="master", argocd=""),
        components(kube_vip="v1.3.1", multus_cni="v4.3.2", argocd="10.18.0"))
    assert pin_decreases(releases, manifests) == []


def test_a_sync_that_floats_a_pinned_component_is_reported():
    # nothing proves that "latest" is not older than v1.3.1
    releases, manifests = first_sync(components(kube_vip="v1.3.1"),
                                     components(kube_vip="latest"))
    assert pin_decreases(releases, manifests) == [
        ("v2.3.0", "v2.4.0", "kube-vip", "v1.3.1", "latest")]


@pytest.mark.parametrize("before,after,down", [
    ("v1.9.1", "v1.10.0", False),       # numbers, not text
    ("1.20.4", "v1.20.4", False),       # the v is optional
    ("v0.6.0-rc.1", "v0.6.0", False),   # a prerelease is older
    ("v0.6.0", "v0.6.0-rc.1", True),
    ("v1.3.1+k4all.2", "v1.3.1", False),  # build metadata does not count
    ("42.4.0", "41.9.9", True),
])
def test_versions_compare_as_semver(before, after, down):
    releases, manifests = first_sync(components(traefik=before),
                                     components(traefik=after))
    assert bool(pin_decreases(releases, manifests)) is down


def test_a_component_the_sync_leaves_out_or_adds_is_not_compared():
    # the sync leaves an unlisted component as it is (ADR-0005)
    releases, manifests = first_sync(
        components(ingress_nginx="4.14.3", cilium="1.19.1"),
        components(traefik="42.4.0", cilium="1.20.4"))
    assert pin_decreases(releases, manifests) == []


@pytest.mark.parametrize("before,after", [
    ({"version": "4.14.3"}, {"version": "4.0.0", "management": "Removed"}),
    ({"version": "4.14.3", "management": "Removed"}, {"version": "4.0.0"}),
])
def test_a_removed_component_has_no_version_to_keep(before, after):
    releases, manifests = first_sync({"ingress-nginx": before},
                                     {"ingress-nginx": after})
    assert pin_decreases(releases, manifests) == []


def test_an_unmanaged_pin_is_compared():
    # the host writes kube-vip at the version the manifest pins (ADR-0007)
    releases, manifests = first_sync(
        {"kube-vip": {"version": "v1.3.1", "management": "Unmanaged"}},
        {"kube-vip": {"version": "v1.2.0", "management": "Unmanaged"}})
    assert pin_decreases(releases, manifests) == [
        ("v2.3.0", "v2.4.0", "kube-vip", "v1.3.1", "v1.2.0")]


def test_a_blocked_release_still_counts_where_clusters_run_it():
    # v2.6.1 is blocked for pinning an operator that later releases do not
    # carry: clusters already on it would still go down at v2.6.2's sync.
    # No hop goes to a blocked release, so its own sync is not compared.
    releases = graph([
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
        release("v2.6.1", "patch", "v2.6.0", "1.36.6", "1.36", 45,
                syncManifest=True, blocked=True),
        release("v2.6.2", "patch", "v2.6.0", "1.36.6", "1.36", 45,
                syncManifest=True),
        release("v2.6.3", "patch", "v2.6.0", "1.36.6", "1.36", 45,
                syncManifest=True, blocked=True),
    ])
    manifests = {"v2.6.0": components(k4all_operator="v0.5.0"),
                 "v2.6.1": components(k4all_operator="v0.6.0"),
                 "v2.6.2": components(k4all_operator="v0.5.9"),
                 "v2.6.3": components(k4all_operator="v0.5.1")}
    assert pin_decreases(releases, manifests) == [
        ("v2.6.1", "v2.6.2", "k4all-operator", "v0.6.0", "v0.5.9")]


def exit_patch_ladder(exit_min_from):
    """The 2.6 stream, where every patch syncs, frozen by v2.7.0, and v2.6.6:
    an exit patch with v2.6.5's manifest, which v2.7.0 needs (minFrom)."""
    synced = [release("v2.6.%d" % z, "patch", "v2.6.0", "1.36.6", "1.36", 45,
                      syncManifest=True) for z in range(1, 6)]
    return graph([
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45)] + synced + [
        release("v2.6.6", "patch", exit_min_from, "1.36.6", "1.36", 45),
        release("v2.7.0", "minor", "v2.6.6", "1.36.6", "1.36", 45),
        release("v2.7.1", "patch", "v2.7.0", "1.36.6", "1.36", 45,
                syncManifest=True),
    ])


def test_an_exit_patch_keeps_the_rules():
    releases = exit_patch_ladder("v2.6.5")
    operator = {"v2.6.0": "v0.5.0", "v2.6.1": "v0.5.1", "v2.6.2": "v0.5.1",
                "v2.6.3": "v0.5.1", "v2.6.4": "v0.5.3", "v2.6.5": "v0.5.4",
                "v2.6.6": "v0.5.4", "v2.7.0": "v0.5.4", "v2.7.1": "v0.6.0"}
    manifests = {v: components(k4all_operator=o) for v, o in operator.items()}
    assert ku.validate_graph(releases) == []
    assert skipped_syncs(releases) == []
    assert pin_decreases(releases, manifests) == []
    assert versions(ku.plan_path(releases, "v2.6.3")) == [
        "v2.6.5", "v2.6.6", "v2.7.0", "v2.7.1"]


def test_an_exit_patch_without_a_sync_cannot_skip_one():
    # from v2.6.0 straight to v2.6.6 would skip the syncs of v2.6.1 - v2.6.5
    assert skipped_syncs(exit_patch_ladder("v2.6.0"))[0] == ("v2.6.6", "v2.6.1")


def test_the_check_sees_every_hop_the_planner_takes(ladder):
    # pin_decreases may follow more hops than plan_path, never fewer
    with open(RELEASES_YAML, encoding="utf-8") as fh:
        repo = ku.load_graph(yaml.safe_load(fh))
    for releases in (ladder, repo, exit_patch_ladder("v2.6.5")):
        reach = reachable(releases)
        for start in releases:
            for target in releases:
                try:
                    path = ku.plan_path(releases, start.version, target.version)
                except ku.NoPathError:
                    continue
                assert {r.version for r in path} <= reach[start.version], \
                    (start, target)


def test_pinned_versions_never_go_down_on_the_repo_graph():
    with open(RELEASES_YAML, encoding="utf-8") as fh:
        releases = ku.load_graph(yaml.safe_load(fh))
    found = pin_decreases(releases, release_manifests(releases))
    assert found == [], (
        "a manifest sync moves these pins down, as (from, sync, component, "
        "pinned, synced); see docs/adr/0010: %s" % found)


def test_the_release_being_prepared_has_the_working_tree_manifest():
    # the newest release of the graph, before its tag exists: a release PR
    releases = graph([
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
        release("v99.0.0", "minor", "v2.6.0", "1.36.6", "1.36", 45)])
    with open(RELEASE_MANIFEST, encoding="utf-8") as fh:
        tree = yaml.safe_load(fh)["spec"]["components"]
    manifests = release_manifests(releases)
    assert manifests["v99.0.0"] == tree
    assert manifests["v2.6.0"]["k4all-operator"]["version"] == "v0.5.0"


def test_an_older_release_without_a_tag_fails_in_ci_and_is_skipped_elsewhere(
        monkeypatch):
    releases = graph([
        release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
        release("v2.6.99", "patch", "v2.6.0", "1.36.6", "1.36", 45),
        release("v99.0.0", "minor", "v2.6.0", "1.36.6", "1.36", 45)])
    monkeypatch.setenv("CI", "true")
    with pytest.raises(pytest.fail.Exception, match="v2.6.99"):
        release_manifests(releases)
    monkeypatch.delenv("CI")
    with pytest.raises(pytest.skip.Exception):
        release_manifests(releases)
