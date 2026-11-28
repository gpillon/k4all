"""k4all-upgrade reads the k4all-operator's readiness verdict (k4all#126).

From k4all-operator v0.7.0 every Node carries the annotation
`k4all.magesgate.com/drain-readiness`: the operator's verdict for that node,
refreshed at most 30 minutes apart. From v2.7.2 the tool reads it for a hop
it drives itself on a cluster of more than one node:
- a control plane that drains itself holds before STAGE on a fresh verdict
  with Blocks findings; with none, its built-in checks (#87, #99) run too;
- a worker that waits for its drain from outside says the verdict first;
- without a fresh verdict (stale, missing, malformed) the built-in checks
  alone decide, as in v2.7.1;
- a hop the operator asked for, and a single node, never read it.
`status` and `plan` show it on their `Readiness:` lines.

The fixtures in data/ are the operator's own encoding: DrainReadiness.Encode
of k4all-operator api/v1alpha1 (release-v0.7.0), written by

    value, _ := v1alpha1.DrainReadiness{At: metav1.NewTime(at), Release: "v2.8.0",
        Blocks: 1, Disrupts: 12, First: []string{v1alpha1.DrainReadinessLine(f)}}.Encode()

- drain-readiness-blocks.json: the example of k4all#126;
- drain-readiness-clear.json: nothing found (`"first":[]`, never null);
- drain-readiness-cut.json: five findings, three kept (Blocks first),
  shortened to fit 2048 bytes with "…", no HTML escapes ("->", "<", "&").
"""

import datetime
import json
import os

import pytest

from conftest import Proc, ku, release, run_cli, write_graph
from test_drain import kubectl_calls, pdb, pod

DATA = os.path.join(os.path.dirname(__file__), "data")
NODE = "k4all-node-1"

GRAPH = [
    release("v2.7.0", "minor", "v2.6.0", "1.36.6", "1.36", 45),
    release("v2.7.2", "patch", "v2.7.0", "1.36.7", "1.36", 45),
    release("v2.7.3", "patch", "v2.7.2", "1.36.7", "1.36", 45),
    release("v2.8.0", "minor", "v2.7.2", "1.36.7", "1.36", 45),
]

CNPG = ("CNPGSingleInstance db/app-pg: single-instance CloudNativePG primary "
        "app-pg-1: PDB app-pg-primary allows no disruption")
HOLD = ("the k4all-operator holds the drain of k4all-node-1: 1 thing stops it "
        "(checked 2026-11-24T01:12:25Z, for v2.8.0): " + CNPG + ". Nothing was "
        "changed. Approve a fix in the k4all addon (Upgrades) and run the "
        "upgrade as a ClusterUpgrade, or fix it by hand (see docs/upgrades.md, "
        "Drains that never end). After a fix by hand, ask the k4all-operator "
        "for a new check (`kubectl annotate clusterupgrade k4all "
        "k4all.magesgate.com/check-readiness=now --overwrite`), then "
        "`k4all-upgrade clear-hold` and `k4all-upgrade resume`")
WAIT = ("Node k4all-node-1: the k4all-operator found 1 thing that stops its "
        "drain (checked 2026-11-24T01:12:25Z): " + CNPG + ". Fix it (the k4all "
        "addon, Upgrades), then drain this node from a control plane.")
# 17 minutes after the check of drain-readiness-blocks.json
CHECKED = datetime.datetime(2026, 11, 24, 1, 12, 25)
SOON = CHECKED + datetime.timedelta(minutes=17)


def fixture(name):
    with open(os.path.join(DATA, "drain-readiness-%s.json" % name),
              encoding="utf-8") as fh:
        return fh.read().rstrip("\n")


def value(**changes):
    """drain-readiness-blocks.json with some fields changed."""
    data = json.loads(fixture("blocks"))
    data.update(changes)
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def utc(when):
    return when.replace(tzinfo=datetime.timezone.utc)


def judge(text, now=SOON, releases=("v2.7.3", "v2.8.0"), after=None):
    node = {"metadata": {"annotations": {} if text is None
                         else {ku.ANNOTATION_DRAIN_READINESS: text}}}
    return ku.drain_readiness(node, utc(now),
                              None if releases is None else list(releases),
                              after)


def state(host):
    return ku.load_state(host)


def make(make_host, role="control", nodes=2, readiness=None, version="v2.7.2"):
    host = make_host(version=version, kubernetes="1.36.7", role=role)
    host.node_count = nodes
    host.clock = SOON
    write_graph(host, GRAPH)
    if readiness is not None:
        host.annotations[ku.ANNOTATION_DRAIN_READINESS] = readiness
    return host


def save_plan(host, to):
    """A plan of `run` to ``to`` that has not started yet."""
    path = ku.plan_path(ku.load_graph(json.loads(json.dumps(GRAPH))),
                        "v2.7.2", to)
    ku.save_state(host, ku.new_state(to, "run", path, "v2.7.2",
                                     "ghcr.io/gpillon/k4all-bootc"))


def staged_nothing(host):
    assert not [c for c in host.calls if c[0].endswith("k4all-backup.sh")]
    assert not [c for c in host.calls if c[:2] == ["bootc", "switch"]]
    assert not kubectl_calls(host, "drain") and not kubectl_calls(host, "label")
    assert not host.unschedulable and host.operator_replicas == 1


# --- the format, as the operator writes it ---------------------------------
def test_the_operators_encoding_decodes():
    assert ku.decode_drain_readiness(fixture("blocks")) == {
        "v": 1, "at": "2026-11-24T01:12:25Z", "release": "v2.8.0",
        "blocks": 1, "disrupts": 12, "first": [CNPG]}
    assert ku.decode_drain_readiness(fixture("clear"))["first"] == []
    cut = fixture("cut")
    assert len(cut.encode()) <= 2048
    got = ku.decode_drain_readiness(cut)
    assert (got["blocks"], got["disrupts"], len(got["first"])) == (2, 3, 3)
    assert got["first"][0].startswith(
        'CephNotHealthy rook-ceph: HEALTH_WARN <1 osds down> & "noout" -> éé')
    assert got["first"][0].endswith("…") and got["first"][1].endswith("…")
    assert got["first"][2] == ("PDBTooLittleRoom shop/web: allows 1 of the 3 "
                               "pods on this node")


@pytest.mark.parametrize("name", ["blocks", "clear", "cut"])
def test_the_fixtures_are_compact_json_without_html_escapes(name):
    # Go's encoder with SetEscapeHTML(false), the fields in struct order: a
    # reader that decodes and encodes again gets the same bytes
    text = fixture(name)
    data = ku.decode_drain_readiness(text)
    assert json.dumps(data, ensure_ascii=False, separators=(",", ":")) == text
    assert "\\u003c" not in text and "\\u0026" not in text


def test_fields_a_later_operator_adds_are_ignored():
    got = judge(value(dryRun=True, nodes={"a": 1}))
    assert got["state"] == "fresh" and "dryRun" not in got


# --- fresh, stale, missing, malformed ------------------------------------------
def test_a_recent_verdict_for_this_plan_is_fresh():
    got = judge(fixture("blocks"))
    assert got == {"state": "fresh", "v": 1, "at": "2026-11-24T01:12:25Z",
                   "release": "v2.8.0", "blocks": 1, "disrupts": 12,
                   "first": [CNPG]}


def test_the_window_is_35_minutes():
    # the operator refreshes at most 30 minutes apart, plus 5 for that
    # period and for clock skew
    assert ku.DRAIN_READINESS_FRESH_MINUTES == 35
    edge = CHECKED + datetime.timedelta(minutes=35)
    assert judge(fixture("blocks"), now=edge)["state"] == "fresh"
    got = judge(fixture("blocks"), now=edge + datetime.timedelta(seconds=1))
    assert got["state"] == "stale" and got["staleBecause"] == "age"
    assert got["blocks"] == 1, "the fields stay, for status"


def test_a_verdict_from_the_future_is_stale():
    early = CHECKED - datetime.timedelta(minutes=36)
    got = judge(fixture("blocks"), now=early)
    assert got["state"] == "stale" and got["staleBecause"] == "clock"
    # a few minutes of skew are fine
    assert judge(fixture("blocks"), now=CHECKED - datetime.timedelta(
        minutes=3))["state"] == "fresh"


@pytest.mark.parametrize("releases,state", [
    (["v2.8.0"], "fresh"),                  # the hop's release
    (["v2.7.3", "v2.8.0"], "fresh"),        # a later release of the plan
    (["2.8.0"], "fresh"),
    (["v2.7.3"], "stale"),                  # another release
    ([], "stale"),
])
def test_the_release_must_be_one_of_the_plan(releases, state):
    got = judge(fixture("blocks"), releases=releases)
    assert got["state"] == state
    if state == "stale":
        assert got["staleBecause"] == "release"


def test_outside_a_plan_the_release_must_come_after_the_booted_one():
    assert judge(fixture("blocks"), releases=None,
                 after="v2.7.2")["state"] == "fresh"
    got = judge(fixture("blocks"), releases=None, after="v2.8.0")
    assert got["state"] == "stale" and got["staleBecause"] == "release"
    assert judge(fixture("blocks"), releases=None,
                 after="unknown (bootc busy)")["state"] == "fresh"
    assert judge(value(release="main"), releases=None,
                 after="v2.7.2")["state"] == "stale"


def test_no_annotation_is_missing():
    assert judge(None) == {"state": "missing"}


@pytest.mark.parametrize("text,error", [
    ("not json", "not JSON"),
    ('{"v":1,', "not JSON"),
    ("[1]", "not a JSON object"),
    (value(v=2), "format version 2, want 1"),
    (value(v="1"), 'format version "1", want 1'),
    (value(v=True), "format version true, want 1"),
    (value(v=1.0), "format version 1.0, want 1"),
    (value(blocks="1"), "blocks is not a count"),
    (value(blocks=-1), "blocks is not a count"),
    (value(disrupts=None), "disrupts is not a count"),
    (value(at="2026-11-24 01:12:25"), "not an RFC 3339 time"),
    (value(at="2026-13-24T01:12:25Z"), "month must be in 1..12"),
    (value(at=1764000000), "at is not a time"),
    (value(release=280), "release is not a string"),
    (value(first=None), "first is not a list of strings"),
    (value(first=[1]), "first is not a list of strings"),
    (value(first="x"), "first is not a list of strings"),
], ids=["not-json", "truncated", "not-an-object", "v2", "v-string", "v-bool",
        "v-float", "blocks-string", "blocks-negative", "disrupts-null",
        "at-not-rfc3339", "at-no-date", "at-number", "release-number",
        "first-null", "first-numbers", "first-string"])
def test_what_is_malformed(text, error):
    got = judge(text)
    assert got["state"] == "malformed"
    assert error in got["error"]
    assert got["value"] == text[:200]


def test_a_missing_field_is_malformed():
    data = json.loads(fixture("blocks"))
    for key in ("v", "at", "release", "blocks", "disrupts", "first"):
        broken = {k: v for k, v in data.items() if k != key}
        assert judge(json.dumps(broken))["state"] == "malformed", key


@pytest.mark.parametrize("text,when", [
    ("2026-11-24T01:12:25Z", datetime.datetime(2026, 11, 24, 1, 12, 25)),
    ("2026-11-24T01:12:25.5Z", datetime.datetime(2026, 11, 24, 1, 12, 25, 500000)),
    ("2026-11-24T02:12:25+01:00", datetime.datetime(2026, 11, 24, 1, 12, 25)),
    ("2026-11-23T23:42:25-01:30", datetime.datetime(2026, 11, 24, 1, 12, 25)),
])
def test_parse_rfc3339(text, when):
    assert ku.parse_rfc3339(text) == utc(when)


# --- the texts ---------------------------------------------------------------
def test_the_hold_text():
    verdict = judge(fixture("blocks"))
    assert ku.drain_readiness_hold(NODE, verdict) == HOLD


def test_the_wait_message_of_a_worker():
    verdict = judge(fixture("blocks"))
    assert ku.drain_readiness_note(NODE, verdict) == WAIT


def test_the_texts_name_only_the_blocks_findings():
    # first holds Blocks first: past `blocks` come the Disrupts ones
    verdict = judge(fixture("cut"), now=datetime.datetime(2026, 11, 24, 2, 20))
    hold = ku.drain_readiness_hold(NODE, verdict)
    assert ": 2 things stop it (checked 2026-11-24T02:12:25Z, for v2.8.0): " \
        "CephNotHealthy rook-ceph: " in hold
    assert "; VMCannotMove vms/db-1: " in hold
    assert "PDBTooLittleRoom" not in hold
    note = ku.drain_readiness_note(NODE, verdict)
    assert "found 2 things that stop its drain" in note and "Fix them" in note


def test_more_blocks_than_messages_are_counted():
    verdict = judge(value(blocks=5))
    assert ("1 thing" not in ku.drain_readiness_hold(NODE, verdict))
    assert (CNPG + "; and 4 more in the k4all addon (Upgrades). Nothing was "
            "changed.") in ku.drain_readiness_hold(NODE, verdict)
    verdict = judge(value(blocks=2, first=[]))
    assert ": named in the k4all addon (Upgrades). Nothing" \
        in ku.drain_readiness_hold(NODE, verdict)


# --- PREFLIGHT of a control plane that drains itself -------------------------
def test_a_fresh_verdict_with_blocks_holds_before_stage(make_host):
    host = make(make_host, readiness=fixture("blocks"))

    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PREFLIGHT" and st["hop"]["to"] == "v2.7.3"
    assert st["hold"]["reason"] == HOLD
    assert host.annotations[ku.ANNOTATION_PHASE] == "HOLD"
    assert host.annotations[ku.ANNOTATION_MESSAGE] == HOLD
    staged_nothing(host)
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations
    # the verdict decides: the built-in checks are not run
    assert not [c for c in host.calls if "poddisruptionbudgets" in c]
    # it is the operator's annotation: the tool never writes it
    assert all(ku.ANNOTATION_DRAIN_READINESS not in p for p in host.patches)


def test_the_hold_goes_once_the_operator_says_clear(make_host):
    host = make(make_host, readiness=fixture("blocks"))
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 1
    host.annotations[ku.ANNOTATION_DRAIN_READINESS] = value(
        at="2026-11-24T01:42:25Z", blocks=0, disrupts=0, first=[])
    host.clock = datetime.datetime(2026, 11, 24, 1, 45)
    assert run_cli(host, "clear-hold") == 0
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "REBOOT"
    assert kubectl_calls(host, "drain")


def test_a_fresh_verdict_without_blocks_still_runs_the_built_in_checks(make_host):
    host = make(make_host, readiness=fixture("clear"))
    host.clock = datetime.datetime(2026, 11, 24, 1, 50)
    host.pdbs = [pdb("app-pg-primary", namespace="db")]
    host.pods = [pod("app-pg-1", namespace="db")]
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 1
    assert state(host)["hold"]["reason"].startswith(
        "the drain of k4all-node-1 would never end: PDB db/app-pg-primary "
        "allows no disruption of pod db/app-pg-1")


def test_a_fresh_verdict_without_blocks_lets_the_hop_go_on(make_host):
    host = make(make_host, readiness=fixture("clear"))
    host.clock = datetime.datetime(2026, 11, 24, 1, 50)
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert not [m for m in host.logs if "readiness" in m]


NOT_FRESH = [
    (fixture("blocks"), CHECKED + datetime.timedelta(minutes=36),
     "the k4all-operator's readiness check of k4all-node-1 is from "
     "2026-11-24T01:12:25Z (for v2.8.0): too old, using the built-in check"),
    (value(release="v2.7.1"), SOON,
     "the k4all-operator's readiness check of k4all-node-1 is from "
     "2026-11-24T01:12:25Z (for v2.7.1): for another release than this "
     "plan's, using the built-in check"),
    (value(v=2), SOON,
     "WARNING: the k4all-operator's readiness annotation "
     "k4all.magesgate.com/drain-readiness of k4all-node-1 is unreadable "
     "(format version 2, want 1), using the built-in check: " + value(v=2)[:200]),
    (None, SOON, None),
]
NOT_FRESH_IDS = ["stale-by-age", "stale-by-release", "malformed", "missing"]


@pytest.mark.parametrize("readiness,clock,logged", NOT_FRESH, ids=NOT_FRESH_IDS)
def test_without_a_fresh_verdict_its_blocks_do_not_hold(
        make_host, readiness, clock, logged):
    host = make(make_host, readiness=readiness)
    host.clock = clock
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    if logged:
        assert logged in host.logs
    else:
        assert not [m for m in host.logs if "readiness" in m]


@pytest.mark.parametrize("readiness,clock,logged", NOT_FRESH, ids=NOT_FRESH_IDS)
def test_without_a_fresh_verdict_the_built_in_checks_decide(
        make_host, readiness, clock, logged):
    host = make(make_host, readiness=readiness)
    host.clock = clock
    host.pdbs, host.pods = [pdb()], [pod()]
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 1
    assert state(host)["hold"]["reason"].startswith(
        "the drain of k4all-node-1 would never end")


def test_a_verdict_for_a_release_past_this_plan_is_stale(make_host):
    # run --to v2.7.3: the operator's verdict is for v2.8.0
    host = make(make_host, readiness=fixture("blocks"))
    assert run_cli(host, "run", "--to", "v2.7.3", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert any("(for v2.8.0): for another release" in m for m in host.logs)


def test_a_node_that_cannot_be_read_uses_the_built_in_check(make_host):
    host = make(make_host, readiness=fixture("blocks"))
    real = host._kubectl

    def kubectl(args, input_text, kubeconfig=""):
        if args[:2] == ["get", "node"]:
            return Proc(returncode=1, stderr="etcdserver: request timed out")
        return real(args, input_text, kubeconfig)
    host._kubectl = kubectl
    assert run_cli(host, "run", "--to", "v2.7.3", "--yes") == 0
    assert "cannot read Node k4all-node-1: etcdserver: request timed out, " \
        "using the built-in check" in host.logs


def test_a_bootstrap_node_with_other_nodes_reads_the_verdict(make_host):
    host = make(make_host, role="bootstrap", readiness=fixture("blocks"))
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 1
    assert state(host)["hold"]["reason"] == HOLD


def test_a_single_node_never_holds(make_host):
    # not drained: status shows what stops at the reboot instead
    host = make(make_host, role="bootstrap", nodes=1, readiness=fixture("blocks"))
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert not [m for m in host.logs if "readiness" in m]


def test_an_operator_hop_ignores_the_verdict(make_host):
    # the k4all-operator checked before its cordon
    host = make(make_host, nodes=3, readiness=value(release="v2.7.3"))
    host.annotations[ku.ANNOTATION_TARGET] = "v2.7.3"
    assert run_cli(host, "agent") == 0
    assert not state(host).get("hold")
    assert state(host)["phase"] == "REBOOT"
    assert not [m for m in host.logs if "readiness" in m]


# --- a worker, drained from outside --------------------------------------------
def test_a_worker_says_the_verdict_first_while_it_waits(make_host):
    host = make(make_host, role="worker", readiness=fixture("blocks"))

    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 3
    reason = [m for m in host.logs if m.startswith("not yet: ")][0]
    assert reason.startswith("not yet: " + WAIT + " this node needs a drain "
                             "before the reboot")
    assert "kubectl drain k4all-node-1 --ignore-daemonsets" in reason
    staged_nothing(host)


def test_the_waiting_line_of_status_shows_the_verdict(make_host, capsys):
    host = make(make_host, role="worker", readiness=fixture("blocks"))
    save_plan(host, "v2.8.0")
    assert run_cli(host, "resume") == 0
    assert state(host)["waiting"].startswith(WAIT)
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    assert "Waiting:   " + WAIT in capsys.readouterr().out


def test_a_worker_names_its_bare_pods_after_the_verdict(make_host):
    host = make(make_host, role="worker", readiness=fixture("blocks"))
    host.pods = [pod("debug-x", namespace="default", labels={"run": "x"},
                     owner=None)]
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 3
    reason = [m for m in host.logs if m.startswith("not yet: ")][0]
    assert reason.startswith("not yet: " + WAIT + " Node k4all-node-1 runs pods "
                             "that declare no controller: default/debug-x.")


def test_a_worker_without_a_fresh_verdict_waits_as_before(make_host):
    host = make(make_host, role="worker", readiness=fixture("blocks"))
    host.clock = CHECKED + datetime.timedelta(hours=2)
    assert run_cli(host, "run", "--to", "v2.7.3", "--yes") == 3
    reason = [m for m in host.logs if m.startswith("not yet: ")][0]
    assert reason.startswith("not yet: this node needs a drain before the reboot")
    assert any("too old, using the built-in check" in m for m in host.logs)


def test_a_worker_drained_from_outside_goes_on(make_host):
    # cordoned and drained by the admin: their call
    host = make(make_host, role="worker", readiness=fixture("blocks"))
    host.unschedulable = True
    assert run_cli(host, "run", "--to", "v2.8.0", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"


# --- status and plan -----------------------------------------------------------
def status_out(host, capsys, *argv):
    capsys.readouterr()
    assert run_cli(host, "status", *argv) == 0
    return capsys.readouterr().out


def test_status_shows_the_verdict(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    out = status_out(host, capsys)
    assert out.endswith(
        "Readiness: 1 blocks, 12 disrupts (k4all-operator, checked "
        "2026-11-24T01:12:25Z, for v2.8.0)\n"
        "           " + CNPG + "\n")


def test_status_shows_up_to_three_findings(make_host, capsys):
    host = make(make_host, readiness=fixture("cut"))
    host.clock = datetime.datetime(2026, 11, 24, 2, 20)
    lines = status_out(host, capsys).splitlines()
    at = [i for i, line in enumerate(lines) if line.startswith("Readiness:")][0]
    assert lines[at] == ("Readiness: 2 blocks, 3 disrupts (k4all-operator, "
                         "checked 2026-11-24T02:12:25Z, for v2.8.0)")
    findings = lines[at + 1:]
    assert len(findings) == 3
    for line, kind in zip(findings, ["CephNotHealthy rook-ceph: ",
                                     "VMCannotMove vms/db-1: ",
                                     "PDBTooLittleRoom shop/web: "]):
        assert line.startswith(ku.READINESS_INDENT + kind)


def test_status_marks_a_stale_verdict(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    host.clock = CHECKED + datetime.timedelta(hours=1)
    assert ("Readiness: 1 blocks, 12 disrupts (k4all-operator, checked "
            "2026-11-24T01:12:25Z (stale), for v2.8.0)\n") \
        in status_out(host, capsys)


def test_status_judges_the_release_by_the_plan(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    save_plan(host, "v2.7.3")
    assert "(stale), for v2.8.0)" in status_out(host, capsys)
    save_plan(host, "v2.8.0")
    assert "checked 2026-11-24T01:12:25Z, for v2.8.0)" in status_out(host, capsys)


@pytest.mark.parametrize("readiness,line", [
    (None, "Readiness: not reported by the k4all-operator\n"),
    ("{", "Readiness: unreadable annotation (not JSON: "),
    (value(v=2), "Readiness: unreadable annotation (format version 2, want 1)\n"),
])
def test_status_without_a_verdict(make_host, capsys, readiness, line):
    host = make(make_host, readiness=readiness)
    assert line in status_out(host, capsys)


def test_status_without_a_kubeconfig_has_no_readiness(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    assert "Readiness" not in status_out(host, capsys)
    assert "readiness" not in json.loads(status_out(host, capsys, "--json"))
    assert not [c for c in host.calls if c[3:5] == ["get", "node"]]


def test_status_when_the_node_cannot_be_read(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    host.apiserver_up = False
    out = status_out(host, capsys)
    assert "Readiness: unknown, cannot read Node k4all-node-1: The connection " \
        "to the server" in out
    got = json.loads(status_out(host, capsys, "--json"))["readiness"]
    assert got["state"] == "unknown"


def test_status_json_has_the_readiness(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    got = json.loads(status_out(host, capsys, "--json"))
    assert got["readiness"] == {
        "state": "fresh", "v": 1, "at": "2026-11-24T01:12:25Z",
        "release": "v2.8.0", "blocks": 1, "disrupts": 12, "first": [CNPG]}

    host.clock = CHECKED + datetime.timedelta(hours=1)
    got = json.loads(status_out(host, capsys, "--json"))["readiness"]
    assert (got["state"], got["staleBecause"], got["blocks"]) == ("stale", "age", 1)

    host.annotations[ku.ANNOTATION_DRAIN_READINESS] = "{"
    got = json.loads(status_out(host, capsys, "--json"))["readiness"]
    assert got["state"] == "malformed" and got["value"] == "{"

    del host.annotations[ku.ANNOTATION_DRAIN_READINESS]
    got = json.loads(status_out(host, capsys, "--json"))["readiness"]
    assert got == {"state": "missing"}


def test_status_outside_a_plan_judges_by_the_booted_release(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"), version="v2.8.0")
    host.booted["version"] = "v2.8.0"
    assert "(stale), for v2.8.0)" in status_out(host, capsys)
    host = make(make_host, readiness=fixture("blocks"))
    assert "checked 2026-11-24T01:12:25Z, for v2.8.0)" in status_out(host, capsys)


def test_plan_prints_the_verdict_after_the_hops(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    capsys.readouterr()
    assert run_cli(host, "plan", "--to", "v2.8.0") == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].startswith("v2.7.2 -> v2.7.3  [patch]")
    assert lines[1].startswith("v2.7.3 -> v2.8.0  [minor]")
    assert lines[2:] == [
        "Readiness: 1 blocks, 12 disrupts (k4all-operator, checked "
        "2026-11-24T01:12:25Z, for v2.8.0)", "           " + CNPG]


def test_plan_judges_the_release_by_its_hops(make_host, capsys):
    host = make(make_host, readiness=fixture("blocks"))
    capsys.readouterr()
    assert run_cli(host, "plan", "--to", "v2.7.3") == 0
    assert "(stale), for v2.8.0)" in capsys.readouterr().out
