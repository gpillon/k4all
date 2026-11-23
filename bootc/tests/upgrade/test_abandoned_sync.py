"""A hop abandoned after the reboot of a sync release (#76).

The node keeps the new image, and the next plan starts from the release it
boots: that release's ReleaseManifest would never reach the cluster. The
node remembers the missing sync until `sync-manifest` runs.
"""

import pytest
import yaml

from conftest import ku, release, run_cli, write_graph

GRAPH = [
    release("v2.2.4", "patch", "v2.0.0-beta1", "1.35.6", "1.32", 43),
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 43),
    release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
            syncManifest=True),
    release("v2.4.1", "patch", "v2.4.0", "1.35.10", "1.35", 43),
]

MANIFEST = {
    "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
    "metadata": {"name": "k4all"},
    "spec": {"components": {
        "k4all-operator": {"type": "manifest", "version": "v0.2.0",
                           "source": "https://example/{{ version }}/install.yaml"},
        "cert-manager": {"type": "helm", "version": "v1.21.3"},
    }},
}


TARGET, DONE = ku.ANNOTATION_TARGET, ku.ANNOTATION_DONE
PHASE, MESSAGE = ku.ANNOTATION_PHASE, ku.ANNOTATION_MESSAGE
REASON = ku.ANNOTATION_REASON


def state(host):
    return ku.load_state(host)


def finish(host, limit=10):
    """Boot-time resumes until the plan settles."""
    for _ in range(limit):
        st = state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


def switches(host):
    return [c for c in host.calls if c[:2] == ["bootc", "switch"]]


def abandoned_in_sync(make_host, by_operator=False):
    """v2.3.1 -> v2.4.0 stops in SYNC (the new operator never runs), and
    the hop is abandoned: the node boots v2.4.0, the cluster has not
    synced its manifest. ``by_operator``: the hop was asked for with
    upgrade-target."""
    host = make_host(version="v2.3.1", kubernetes="1.35.10")
    write_graph(host, GRAPH)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(MANIFEST))
    host.operator_adopts = False
    if by_operator:
        host.write(ku.CONFIG_FILE, "mode: managed\n")
        host.annotations[TARGET] = "v2.4.0"
        run_cli(host, "agent")
    else:
        run_cli(host, "run", "--to", "v2.4.0", "--yes")
    st = finish(host)
    assert st["phase"] == "SYNC" and st["hold"], st
    assert run_cli(host, "clear-hold", "--abandon") == 0
    assert host.booted["version"] == "v2.4.0"
    return host


def test_run_does_not_start_a_hop_while_the_sync_is_missing(make_host):
    host = abandoned_in_sync(make_host)
    before = len(switches(host))
    assert run_cli(host, "run", "--yes") == 2
    assert len(switches(host)) == before
    assert any("v2.4.0" in m and "sync-manifest" in m for m in host.logs)


def test_sync_manifest_clears_the_missing_sync(make_host):
    host = abandoned_in_sync(make_host)
    host.operator_adopts = True
    host._refresh_status()
    assert run_cli(host, "sync-manifest") == 0
    assert "syncPending" not in state(host)
    assert run_cli(host, "run", "--yes") == 0
    assert finish(host)["current"] == "v2.4.1"


def test_a_failed_sync_manifest_keeps_it(make_host):
    host = abandoned_in_sync(make_host)
    assert run_cli(host, "sync-manifest") == 2      # the operator still fails
    assert state(host)["syncPending"]["release"] == "v2.4.0"


def test_clear_hold_sync_done_clears_it_by_hand(make_host):
    host = abandoned_in_sync(make_host)
    assert run_cli(host, "clear-hold", "--sync-done") == 0
    assert "syncPending" not in state(host)
    assert any("sync" in m and "v2.4.0" in m for m in host.logs)
    assert run_cli(host, "run", "--yes") == 0


def test_the_timer_does_not_start_a_hop_while_the_sync_is_missing(make_host):
    host = abandoned_in_sync(make_host)
    assert ku.in_window(host.now(), ku.load_config(host)["window"])
    before = len(switches(host))
    assert run_cli(host, "auto") == 0
    assert len(switches(host)) == before
    assert state(host)["phase"] == "DONE"
    assert any("sync-manifest" in m for m in host.logs[-2:])


def test_the_operator_hears_of_the_missing_sync(make_host):
    host = abandoned_in_sync(make_host, by_operator=True)
    assert host.annotations[PHASE] == "ABANDONED"
    assert "not synced" in host.annotations[MESSAGE]
    assert TARGET not in host.annotations

    # the operator's retry names the release the node already boots: it is
    # not done before its manifest is synced
    host.annotations[TARGET] = "v2.4.0"
    assert run_cli(host, "agent") == 0
    assert DONE not in host.annotations
    assert host.annotations[PHASE] == "HOLD"
    assert host.annotations[REASON] == "TargetRejected"
    assert "sync-manifest" in host.annotations[MESSAGE]

    host.annotations[TARGET] = "v2.4.1"
    before = len(switches(host))
    assert run_cli(host, "agent") == 0
    assert len(switches(host)) == before
    assert host.annotations[REASON] == "TargetRejected"

    host.annotations[TARGET] = "v2.4.0"
    host.operator_adopts = True
    host._refresh_status()
    assert run_cli(host, "sync-manifest") == 0
    assert run_cli(host, "agent") == 0
    assert host.annotations[DONE] == "v2.4.0"
    assert PHASE not in host.annotations


def test_status_and_plan_show_the_missing_sync(make_host, capsys):
    host = abandoned_in_sync(make_host)
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    out = capsys.readouterr().out
    assert "Sync:" in out and "v2.4.0 is not synced" in out
    assert run_cli(host, "plan") == 0
    out = capsys.readouterr().out
    assert "v2.4.0 -> v2.4.1" in out and "sync-manifest" in out


@pytest.mark.parametrize("phase,sync,role,booted,left", [
    ("SYNC", True, "bootstrap", "v2.4.0", "v2.4.0"),
    ("REBOOT", True, "bootstrap", "v2.4.0", "v2.4.0"),   # health checks
    ("REBOOT", True, "bootstrap", "v2.3.1", None),       # still on the old
    ("ROLLBACK_REBOOT", True, "bootstrap", "v2.3.1", None),
    ("STAGE", True, "bootstrap", "v2.3.1", None),        # before the reboot
    ("COMMIT", True, "bootstrap", "v2.4.0", None),       # the sync is done
    ("SYNC", False, "bootstrap", "v2.4.0", None),        # nothing to sync
    ("SYNC", True, "control", "v2.4.0", None),           # only the bootstrap
    # bootc unreadable: SYNC comes only after post_boot saw the new release
    ("SYNC", True, "bootstrap", None, "v2.4.0"),
    ("REBOOT", True, "bootstrap", None, None),
])
def test_which_abandoned_hops_leave_a_sync_behind(phase, sync, role, booted,
                                                   left):
    st = {"phase": phase, "hop": {"from": "v2.3.1", "to": "v2.4.0",
                                  "syncManifest": sync}}
    assert ku.sync_left_behind(st, booted, role) == left


def test_an_abandoned_hop_before_the_reboot_leaves_nothing_behind(make_host):
    host = make_host(version="v2.3.1", kubernetes="1.35.10")
    write_graph(host, GRAPH)
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}
    run_cli(host, "run", "--to", "v2.4.0", "--yes")
    assert state(host)["hold"]
    run_cli(host, "clear-hold", "--abandon")
    assert "syncPending" not in state(host)
