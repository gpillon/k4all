"""A saved plan is checked against the upgrade graph before each hop (#73).

The timer (mode auto) and `k4all-upgrade run` save the hops they planned in
state.json, and later hops follow that plan: with autoAllow minor the next
hop can wait a week for the next window. Before a hop starts, its plan is
checked on the graph the node would plan with now, and planned again when a
release was blocked meanwhile, a patch that ends the stream was published,
or a minFrom was raised.
"""

import datetime
import json

import pytest

from conftest import ku, release, run_cli, write_graph

SATURDAY = datetime.datetime(2026, 11, 21, 2, 45)       # inside the window
TUESDAY = datetime.datetime(2026, 11, 24, 10, 0)        # outside it
NEXT_SATURDAY = datetime.datetime(2026, 11, 28, 2, 45)


def rel(version, kind, min_from, **extra):
    return release(version, kind, min_from, "1.36.6", "1.36", 45, **extra)


# Two streams on one Kubernetes minor: hops without kubeadm.
GRAPH = [
    rel("v2.6.0", "minor", "v2.5.0"),
    rel("v2.6.1", "patch", "v2.6.0"),
    rel("v2.6.2", "patch", "v2.6.0"),
    rel("v2.7.0", "minor", "v2.6.0"),
    rel("v2.7.1", "patch", "v2.7.0"),
    rel("v2.7.2", "patch", "v2.7.0"),
]


def changed(graph, version, **fields):
    """``graph`` with the entry of ``version`` changed."""
    out = json.loads(json.dumps(graph))
    for entry in out:
        if entry["version"] == version:
            entry.update(fields)
    return out


def with_exit_patch(graph, **fields):
    """``graph`` with v2.6.3, a patch published after the plan was made."""
    out = json.loads(json.dumps(graph))
    out.insert(3, rel("v2.6.3", "patch", "v2.6.0", **fields))
    return out


def state(host):
    return ku.load_state(host)


def staged(host):
    return [c[-1].rsplit(":", 1)[-1] for c in host.calls
            if c[:3] == ["bootc", "switch", "--download-only"]]


def plan_waits(make_host, version, graph=GRAPH):
    """A node whose timer plan (autoAllow minor) ran its first hop on
    Saturday, then waits for the next window with the rest of the plan."""
    host = make_host(version=version, kubernetes="1.36.6")
    host.write(ku.CONFIG_FILE, "mode: auto\nautoAllow: minor\n")
    write_graph(host, graph)
    host.clock = SATURDAY
    assert run_cli(host, "auto") == 0
    assert state(host)["phase"] == "REBOOT"
    host.clock = TUESDAY                    # the reboot took long
    assert run_cli(host, "resume", "--boot") == 0
    st = state(host)
    assert st["phase"] == "IDLE" and st["pending"], "the plan waits"
    host.calls.clear()
    host.logs.clear()
    return host


def next_window(host):
    host.clock = NEXT_SATURDAY
    assert run_cli(host, "auto") == 0
    return state(host)


def replanned(st):
    return [h for h in st["history"] if h["result"] in ("replanned", "dropped")]


# --- a plan that waited between two windows --------------------------------
def test_a_patch_published_since_ends_the_stream_first(make_host):
    host = plan_waits(make_host, "v2.6.1")
    st = state(host)
    assert st["current"] == "v2.6.2"
    assert [r["version"] for r in st["pending"]] == ["v2.7.0", "v2.7.2"]

    write_graph(host, with_exit_patch(GRAPH))
    st = next_window(host)

    assert st["hop"]["to"] == "v2.6.3", "the stream is finished first"
    assert [r["version"] for r in st["pending"]] == ["v2.7.0", "v2.7.2"]
    assert staged(host) == ["v2.6.3"]
    entry, = replanned(st)
    assert entry["from"] == "v2.6.2" and entry["to"] == "v2.7.0"
    assert entry["result"] == "replanned"
    assert entry["plan"] == ["v2.6.3", "v2.7.0", "v2.7.2"]
    assert "v2.6.2 -> v2.7.0 is not one hop" in entry["reason"]
    assert any(m.startswith("plan changed: ") and "v2.6.3" in m
               for m in host.logs)


def test_a_minor_whose_minfrom_moved_to_the_exit_patch_waits_for_it(make_host):
    host = plan_waits(make_host, "v2.6.1")
    graph = changed(with_exit_patch(GRAPH), "v2.7.0", minFrom="v2.6.3")
    write_graph(host, graph)
    st = next_window(host)
    assert st["hop"]["to"] == "v2.6.3"
    assert staged(host) == ["v2.6.3"]


def test_a_minfrom_raised_since_adds_the_hop_it_needs(make_host):
    host = plan_waits(make_host, "v2.6.2")
    st = state(host)
    assert st["current"] == "v2.7.0"
    assert [r["version"] for r in st["pending"]] == ["v2.7.2"]

    write_graph(host, changed(GRAPH, "v2.7.2", minFrom="v2.7.1"))
    st = next_window(host)

    assert st["hop"]["to"] == "v2.7.1"
    assert [r["version"] for r in st["pending"]] == ["v2.7.2"]
    assert st["target"] == "v2.7.2"
    assert staged(host) == ["v2.7.1"]
    entry, = replanned(st)
    assert "v2.7.0 -> v2.7.2 is not one hop" in entry["reason"]


def test_a_next_release_blocked_since_is_not_taken(make_host):
    host = plan_waits(make_host, "v2.6.2")
    write_graph(host, changed(GRAPH, "v2.7.2", blocked=True))
    st = next_window(host)

    # The target is withdrawn: the timer goes to the latest it may run.
    assert st["hop"]["to"] == "v2.7.1"
    assert st["pending"] == [] and st["target"] == "v2.7.1"
    assert staged(host) == ["v2.7.1"]
    entry, = replanned(st)
    assert "v2.7.2 is blocked" in entry["reason"]


def test_a_plan_with_no_path_left_is_dropped(make_host):
    host = plan_waits(make_host, "v2.6.1")
    # v2.7.0 is withdrawn: nothing else enters 2.7, a .0 is the only door
    write_graph(host, changed(GRAPH, "v2.7.0", blocked=True))
    st = next_window(host)
    assert st["phase"] == "DONE" and st["hop"] is None and st["pending"] == []
    assert staged(host) == []
    entry, = replanned(st)
    assert entry["result"] == "dropped" and entry["plan"] == []
    assert "v2.7.0 is blocked" in entry["reason"]
    assert any(m.startswith("plan dropped: ") for m in host.logs)


def test_an_unchanged_graph_keeps_the_plan(make_host):
    host = plan_waits(make_host, "v2.6.1")
    before = state(host)
    st = next_window(host)
    assert st["hop"]["to"] == "v2.7.0"
    assert st["pending"] == before["pending"][1:]
    assert staged(host) == ["v2.7.0"]
    assert replanned(st) == []
    assert not [m for m in host.logs if m.startswith("plan ")]


def test_a_newer_release_alone_keeps_the_plan(make_host):
    host = plan_waits(make_host, "v2.6.2")
    write_graph(host, GRAPH + [rel("v2.7.3", "patch", "v2.7.0")])
    st = next_window(host)
    assert st["hop"]["to"] == "v2.7.2", "the plan stays as it was"
    assert st["target"] == "v2.7.2"
    assert replanned(st) == []


@pytest.mark.parametrize("allow, hop", [("minor", "v2.8.0"), ("patch", None)])
def test_the_new_plan_follows_autoallow(make_host, allow, hop):
    host = plan_waits(make_host, "v2.6.2")
    host.write(ku.CONFIG_FILE, "mode: auto\nautoAllow: %s\n" % allow)
    # the rest of 2.7 is withdrawn, and 2.8 is out
    graph = changed(changed(GRAPH, "v2.7.1", blocked=True), "v2.7.2",
                    blocked=True) + [rel("v2.8.0", "minor", "v2.7.0")]
    write_graph(host, graph)
    st = next_window(host)
    entry, = replanned(st)
    if hop:
        assert st["hop"]["to"] == hop and entry["plan"] == [hop]
    else:
        # the new plan starts with a minor: the timer does not run it
        assert st["phase"] == "DONE" and st["pending"] == []
        assert entry["result"] == "dropped"
        assert staged(host) == []


# --- where the graph comes from ---------------------------------------------
def test_the_published_graph_is_the_one_checked(make_host):
    host = plan_waits(make_host, "v2.6.2")
    published = {"releases": changed(GRAPH, "v2.7.2", blocked=True)}
    host.fetch = lambda url, timeout=20: json.dumps(published).encode()
    st = next_window(host)            # the image's graph still has v2.7.2
    assert st["hop"]["to"] == "v2.7.1"


def test_offline_the_images_graph_cannot_judge_a_later_release(make_host):
    host = plan_waits(make_host, "v2.6.2")
    # The image of v2.7.0 lists the releases up to itself.
    host.write(ku.LOCAL_GRAPH_FILE, json.dumps({"releases": GRAPH[:4]}))
    st = next_window(host)
    assert st["hop"]["to"] == "v2.7.2", "the plan goes on as before"
    assert replanned(st) == []


def test_offline_the_images_graph_still_blocks_what_it_lists(make_host):
    host = plan_waits(make_host, "v2.6.2")
    host.write(ku.LOCAL_GRAPH_FILE,
               json.dumps({"releases": changed(GRAPH, "v2.7.2", blocked=True)}))
    st = next_window(host)
    assert st["hop"]["to"] == "v2.7.1"


# --- a hop that waits (NotYet) ----------------------------------------------
def test_a_hop_that_waited_is_checked_again_before_it_starts(make_host):
    host = make_host(version="v2.7.0", kubernetes="1.36.6", role="worker")
    write_graph(host, GRAPH)
    host.clock = SATURDAY
    assert run_cli(host, "auto") == 0
    st = state(host)
    assert st["phase"] == "PREFLIGHT" and st["hop"]["to"] == "v2.7.2"
    assert "is not cordoned" in st["waiting"]

    write_graph(host, changed(GRAPH, "v2.7.2", blocked=True))
    host.unschedulable = True               # drained at last
    host.clock = NEXT_SATURDAY
    assert run_cli(host, "auto") == 0
    st = state(host)
    assert st["hop"]["to"] == "v2.7.1" and st["phase"] == "REBOOT"
    assert "waiting" not in st
    assert staged(host) == ["v2.7.1"]
    entry, = replanned(st)
    assert entry["to"] == "v2.7.2"


def test_resume_by_hand_checks_a_waiting_hop_too(make_host):
    host = make_host(version="v2.7.0", kubernetes="1.36.6", role="worker")
    write_graph(host, GRAPH)
    host.clock = SATURDAY
    run_cli(host, "auto")
    write_graph(host, changed(GRAPH, "v2.7.2", minFrom="v2.7.1"))
    host.unschedulable = True
    assert run_cli(host, "resume") == 0
    st = state(host)
    assert st["hop"]["to"] == "v2.7.1"
    assert [r["version"] for r in st["pending"]] == ["v2.7.2"]


# --- plans of `k4all-upgrade run` -------------------------------------------
def test_a_run_plan_goes_another_way_to_its_target(make_host):
    host = make_host(version="v2.6.1", kubernetes="1.36.6")
    write_graph(host, GRAPH)
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 0
    assert state(host)["hop"]["to"] == "v2.6.2"
    write_graph(host, with_exit_patch(GRAPH))
    host.calls.clear()
    assert run_cli(host, "resume", "--boot") == 0    # commits, then goes on
    st = state(host)
    assert st["hop"]["to"] == "v2.6.3" and st["target"] == "v2.7.2"
    assert [r["version"] for r in st["pending"]] == ["v2.7.0", "v2.7.2"]
    assert staged(host) == ["v2.6.3"]


def test_a_run_plan_whose_target_is_withdrawn_holds(make_host):
    host = make_host(version="v2.6.2", kubernetes="1.36.6")
    write_graph(host, GRAPH)
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 0
    write_graph(host, changed(GRAPH, "v2.7.2", blocked=True))
    host.calls.clear()
    assert run_cli(host, "resume", "--boot") == 1
    st = state(host)
    assert st["current"] == "v2.7.0", "the hop that ran is committed"
    assert st["hold"] and "v2.7.2 is blocked" in st["hold"]["reason"]
    assert "clear-hold --abandon" in st["hold"]["reason"]
    assert staged(host) == [], "never toward a release nobody asked for"
    assert host.annotations[ku.ANNOTATION_PHASE] == ku.PHASE_HOLD


# --- a hop that started is never planned again -------------------------------
def test_a_hop_past_its_reboot_finishes_on_the_old_plan(make_host):
    host = make_host(version="v2.6.2", kubernetes="1.36.6")
    write_graph(host, GRAPH)
    assert run_cli(host, "run", "--to", "v2.7.1", "--yes") == 0
    assert state(host)["hop"]["to"] == "v2.7.0"
    write_graph(host, changed(GRAPH, "v2.7.0", blocked=True))
    run_cli(host, "resume", "--boot")
    st = state(host)
    assert st["current"] == "v2.7.0", "the hop that started is committed"
    assert [(h["to"], h["result"]) for h in st["history"]] == [("v2.7.0", "ok")]


def test_the_graph_is_read_once_per_hop(make_host):
    host = plan_waits(make_host, "v2.6.1")
    loads = []
    upgrader = ku.Upgrader(host, ku.load_config(host),
                           graph_loader=lambda: loads.append(1) or
                           ku.load_graph({"releases": GRAPH}))
    host.clock = NEXT_SATURDAY
    upgrader.drive(state(host))
    assert len(loads) == 1


# --- the rules, without a node -------------------------------------------------
def saved(mode, current, pending, target=None, hop=None):
    graph = ku.load_graph({"releases": GRAPH + [rel("v2.6.3", "patch", "v2.6.0")]})
    by = {r.version: r for r in graph}
    st = ku.new_state(target, mode, [by[v] for v in pending], current,
                      "ghcr.io/gpillon/k4all-bootc")
    if target:
        st["target"] = target
    if hop:
        ku.start_next_hop(st)
    return st


def test_stale_hop_is_none_while_the_hop_is_legal():
    st = saved("auto", "v2.6.2", ["v2.7.0", "v2.7.2"])
    assert ku.stale_hop(ku.load_graph({"releases": GRAPH}), st) is None


def test_stale_hop_reads_the_hop_that_waits():
    st = saved("auto", "v2.6.2", ["v2.7.0"], hop=True)
    assert st["pending"] == [] and st["hop"]["to"] == "v2.7.0"
    graph = ku.load_graph({"releases": with_exit_patch(GRAPH)})
    assert "v2.6.2 -> v2.7.0 is not one hop" in ku.stale_hop(graph, st)


def test_stale_hop_says_when_the_graph_is_invalid():
    st = saved("auto", "v2.6.2", ["v2.7.0"])
    graph = ku.load_graph({"releases": changed(GRAPH, "v2.7.1", kind="minor")})
    assert "the upgrade graph is invalid" in ku.stale_hop(graph, st)


def test_replan_of_the_timer_goes_to_the_latest_when_the_target_is_gone():
    st = saved("auto", "v2.7.0", ["v2.7.2"])
    graph = ku.load_graph({"releases": changed(GRAPH, "v2.7.2", blocked=True)})
    assert [r.version for r in ku.replan(graph, st, "minor")] == ["v2.7.1"]


def test_replan_of_run_keeps_its_target_or_fails():
    st = saved("run", "v2.7.0", ["v2.7.2"])
    graph = ku.load_graph({"releases": changed(GRAPH, "v2.7.2", blocked=True)})
    with pytest.raises(ku.NoPathError, match="v2.7.2"):
        ku.replan(graph, st, "minor")      # a run plan keeps its target


def test_replan_of_the_timer_keeps_what_the_policy_allows():
    st = saved("auto", "v2.6.2", ["v2.7.0", "v2.7.2"])
    graph = ku.load_graph({"releases": with_exit_patch(GRAPH)})
    assert [r.version for r in ku.replan(graph, st, "patch")] == ["v2.6.3"]
    assert [r.version for r in ku.replan(graph, st, "minor")] == [
        "v2.6.3", "v2.7.0", "v2.7.2"]
