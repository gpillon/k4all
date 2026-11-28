"""The node side of the ClusterUpgrade protocol: `k4all-upgrade agent`.

The k4all-operator cordons and drains a node, then writes
`upgrade-target: <release>` on it. The agent runs that one hop and answers
with release, node-type, upgrade-phase, upgrade-message and upgrade-done.
"""

import base64
import datetime
import fcntl
import json
import os
import shutil
import subprocess

import pytest
import yaml

from conftest import ku, release, run_cli, write_graph

GRAPH = [
    release("v2.2.4", "patch", "v2.0.0-beta1", "1.35.6", "1.32", 43),
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 43),
    release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
            syncManifest=True),
    release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
    release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
]

TUESDAY = datetime.datetime(2026, 11, 17, 10, 0)    # outside the window

PHASE, MESSAGE = ku.ANNOTATION_PHASE, ku.ANNOTATION_MESSAGE
REASON = ku.ANNOTATION_REASON
RELEASE, DONE = ku.ANNOTATION_RELEASE, ku.ANNOTATION_DONE
TARGET, NODE_TYPE = ku.ANNOTATION_TARGET, ku.ANNOTATION_NODE_TYPE


def state(host):
    return ku.load_state(host)


def agent(host):
    return run_cli(host, "agent")


def commands(host, prefix):
    return [c for c in host.calls if c[:len(prefix)] == prefix]


def kubectl_calls(host, verb):
    return [c for c in host.calls if c[:1] == ["kubectl"] and c[3:4] == [verb]]


def finish(host, limit=10):
    for _ in range(limit):
        st = state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


def phases_published(host):
    return [p[PHASE] for p in host.patches if p.get(PHASE)]


@pytest.fixture
def node(make_host):
    """A single-node bootstrap on v2.4.0, outside the window."""
    def factory(version="v2.4.0", kubernetes="1.35.10", mode=None, **kwargs):
        host = make_host(version=version, kubernetes=kubernetes, **kwargs)
        write_graph(host, GRAPH)
        host.clock = TUESDAY
        if mode:
            host.write(ku.CONFIG_FILE, "mode: %s\n" % mode)
        return host
    return factory


# --- pure helpers ------------------------------------------------------------
@pytest.mark.parametrize("value,expected", [
    ("v2.5.0", "v2.5.0"), ("2.5.0", "v2.5.0"), (" v2.5.0\n", "v2.5.0"),
    ("v2.5.0-rc.1", "v2.5.0-rc.1"),
])
def test_parse_target_accepts_release_versions(value, expected):
    assert ku.parse_target(value) == expected


@pytest.mark.parametrize("value", ["", "latest", "v2.5", "2.5.x", "true"])
def test_parse_target_refuses_anything_else(value):
    with pytest.raises(ValueError):
        ku.parse_target(value)


def test_node_report_when_idle():
    want = ku.node_report(None, "worker", "v2.4.0")
    assert want == {RELEASE: "v2.4.0", NODE_TYPE: "worker", PHASE: None,
                    MESSAGE: None, REASON: None, DONE: None}


def test_node_report_during_a_hop_and_in_hold():
    st = {"current": "v2.4.0", "phase": "STAGE", "pending": [],
          "hop": {"from": "v2.4.0", "to": "v2.5.0"}, "hold": None}
    want = ku.node_report(st, "bootstrap")
    assert want[PHASE] == "STAGE" and want[MESSAGE] is None
    assert want[RELEASE] == "v2.4.0", "release is the last committed one"
    assert want[REASON] is None
    st["hold"] = {"reason": "kubeadm\nfailed:   etcd unhealthy"}
    want = ku.node_report(st, "bootstrap", target="v2.5.0")
    assert want[PHASE] == "HOLD"
    assert want[MESSAGE] == "kubeadm failed: etcd unhealthy"
    assert want[REASON] is None, "an ordinary HOLD is a HostHold"
    assert DONE not in want
    st["hold"]["code"] = "RollbackRebooted"
    assert ku.node_report(st)[REASON] == "RollbackRebooted"


def test_node_report_marks_a_refused_target():
    want = ku.node_report(None, "worker", "v2.4.0", problem="upgrade-target "
                          "v2.6.0: not one hop", target="v2.6.0")
    assert want[PHASE] == "HOLD" and want[REASON] == "TargetRejected"
    assert DONE not in want, "a different target leaves upgrade-done alone"


COMMITTED = {"mode": "operator", "current": "v2.5.0", "target": "v2.5.0",
             "phase": "DONE", "pending": [], "hop": None, "hold": None}


def test_done_is_written_while_the_target_names_the_committed_release():
    want = ku.node_report(COMMITTED, "worker", target="v2.5.0")
    assert want[DONE] == "v2.5.0" and want[RELEASE] == "v2.5.0"
    # whoever ran the hop: the target is what counts
    assert ku.node_report(dict(COMMITTED, mode="auto"), "worker",
                          target="v2.5.0")[DONE] == "v2.5.0"
    running = dict(COMMITTED, current="v2.4.0", phase="SYNC",
                   hop={"from": "v2.4.0", "to": "v2.5.0"})
    assert DONE not in ku.node_report(running, "worker", target="v2.5.0")


def test_done_goes_away_without_a_target():
    assert ku.node_report(COMMITTED, "worker")[DONE] is None
    assert ku.node_report(COMMITTED, "worker", target=" ")[DONE] is None


def test_node_report_bounds_the_message():
    st = {"current": "v2.4.0", "phase": "STAGE", "pending": [],
          "hop": {"to": "v2.5.0"}, "hold": {"reason": "x" * 5000}}
    assert len(ku.node_report(st)[MESSAGE]) == ku.MESSAGE_MAX


def test_annotation_changes_sends_only_differences():
    observed = {RELEASE: "v2.4.0", PHASE: "STAGE", "other": "kept"}
    want = {RELEASE: "v2.4.0", PHASE: None, MESSAGE: None, NODE_TYPE: "worker"}
    assert ku.annotation_changes(observed, want) == {PHASE: None,
                                                     NODE_TYPE: "worker"}
    assert ku.annotation_changes({RELEASE: "v2.4.0"},
                                 {RELEASE: "v2.4.0", PHASE: None}) == {}


@pytest.fixture
def graph():
    return ku.load_graph(json.loads(json.dumps(GRAPH)))


def test_single_hop_is_accepted(graph):
    assert ku.check_single_hop(graph, "v2.4.0", "v2.5.0").version == "v2.5.0"
    assert ku.check_single_hop(graph, "v2.3.0", "v2.3.1").version == "v2.3.1"


@pytest.mark.parametrize("current,target,why", [
    ("v2.4.0", "v2.6.0", "is not one hop: the path is v2.4.0 -> v2.5.0 -> v2.6.0"),
    # the stream is finished first: v2.3.1 before v2.4.0
    ("v2.3.0", "v2.4.0", "is not one hop: the path is v2.3.0 -> v2.3.1 -> v2.4.0"),
    ("v2.4.0", "v2.9.9", "not in the upgrade graph"),
    ("v2.5.0", "v2.4.0", "k4all never downgrades"),
])
def test_illegal_hops_are_refused(graph, current, target, why):
    with pytest.raises(ku.NoPathError, match=why.replace("->", ".*")[:40]):
        ku.check_single_hop(graph, current, target)


def test_blocked_release_is_refused():
    entries = json.loads(json.dumps(GRAPH))
    entries[4]["blocked"] = True
    with pytest.raises(ku.NoPathError, match="blocked"):
        ku.check_single_hop(ku.load_graph(entries), "v2.4.0", "v2.5.0")


def test_invalid_graph_is_refused():
    entries = json.loads(json.dumps(GRAPH))
    entries[4]["minFrom"] = "v2.3.0"        # v2.5.0 would skip minor v2.4.0
    with pytest.raises(ku.NoPathError, match="graph is invalid"):
        ku.check_single_hop(ku.load_graph(entries), "v2.4.0", "v2.5.0")


# --- the Node name is the kubelet's ---------------------------------------
KUBELET_CONF = """apiVersion: v1
kind: Config
clusters:
- cluster: {server: "https://10.0.0.1:6443"}
  name: default-cluster
users:
- name: default-auth
  user:
%s
"""
CLIENT_PEM = "/var/lib/kubelet/pki/kubelet-client-current.pem"


def fake_cert_der(*common_names):
    """Enough DER for the CN scan: commonName attributes in order."""
    body = b""
    for name in common_names:
        value = name.encode()
        body += b"\x31" + bytes([len(value) + 9]) + b"\x30" + bytes([len(value) + 7])
        body += b"\x06\x03\x55\x04\x03\x0c" + bytes([len(value)]) + value
    return b"\x30\x82" + len(body).to_bytes(2, "big") + body


def pem(der):
    text = base64.encodebytes(der).decode()
    return ("-----BEGIN CERTIFICATE-----\n%s-----END CERTIFICATE-----\n"
            "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n"
            % text)


def test_node_name_from_the_client_certificate_file(make_host):
    host = make_host(role="worker")
    host.write(ku.KUBELET_KUBECONFIG, KUBELET_CONF % (
        "    client-certificate: %s\n    client-key: %s" % (CLIENT_PEM, CLIENT_PEM)))
    host.write(CLIENT_PEM, pem(fake_cert_der("kubernetes", "system:node:w-07")))
    assert ku.kubelet_node_name(host) == "w-07"


def test_node_name_from_embedded_certificate_data(make_host):
    host = make_host(role="worker")
    data = base64.b64encode(pem(fake_cert_der("kubernetes",
                                              "system:node:Node-A")).encode())
    host.write(ku.KUBELET_KUBECONFIG, KUBELET_CONF % (
        "    client-certificate-data: %s" % data.decode()))
    assert ku.kubelet_node_name(host) == "Node-A", "the CN is used as it is"


@pytest.mark.skipif(not shutil.which("openssl"), reason="needs openssl")
def test_node_name_from_a_real_certificate(make_host, tmp_path):
    cert, key = tmp_path / "c.pem", tmp_path / "k.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt",
                    "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
                    "-keyout", str(key), "-out", str(cert),
                    "-subj", "/O=system:nodes/CN=system:node:k4all-worker-3"],
                   check=True, capture_output=True)
    host = make_host(role="worker")
    host.write(ku.KUBELET_KUBECONFIG, KUBELET_CONF % (
        "    client-certificate: %s" % CLIENT_PEM))
    host.write(CLIENT_PEM, cert.read_text() + key.read_text())
    assert ku.kubelet_node_name(host) == "k4all-worker-3"


def test_node_name_from_hostname_override(make_host):
    host = make_host(role="worker")
    host.write("/var/lib/kubelet/kubeadm-flags.env",
               'KUBELET_KUBEADM_ARGS="--container-runtime-endpoint=unix:///run/'
               'crio/crio.sock --hostname-override=Edge-1 --pod-infra-container-'
               'image=registry.k8s.io/pause:3.10"\n')
    assert ku.kubelet_node_name(host) == "edge-1"


def test_node_name_falls_back_to_the_hostname(make_host):
    host = make_host(role="worker")          # kubelet.conf without a cert
    assert ku.kubelet_node_name(host) == "k4all-node-1"
    host.write(CLIENT_PEM, "not a certificate")
    host.write(ku.KUBELET_KUBECONFIG, KUBELET_CONF % (
        "    client-certificate: %s" % CLIENT_PEM))
    assert ku.kubelet_node_name(host) == "k4all-node-1"


def test_agent_annotates_the_node_named_by_the_kubelet(node):
    host = node(role="worker")
    host.kubelet_name = "w-07"
    host.write(ku.KUBELET_KUBECONFIG, KUBELET_CONF % (
        "    client-certificate: %s" % CLIENT_PEM))
    host.write(CLIENT_PEM, pem(fake_cert_der("kubernetes", "system:node:w-07")))
    assert agent(host) == 0
    assert host.annotations[RELEASE] == "v2.4.0"
    assert {c[5] for c in kubectl_calls(host, "get")} == {"w-07"}


# --- kubeconfig per role ---------------------------------------------------
@pytest.mark.parametrize("role,expected", [
    ("bootstrap", ku.ADMIN_KUBECONFIG),
    ("control", ku.ADMIN_KUBECONFIG),
    ("worker", ku.KUBELET_KUBECONFIG),
])
def test_agent_uses_the_kubeconfig_of_its_role(node, role, expected):
    host = node(role=role)
    assert agent(host) == 0
    used = {c[2] for c in host.calls if c[:1] == ["kubectl"]}
    assert used == {host.path(expected)}
    assert host.annotations[NODE_TYPE] == role


def test_control_plane_without_admin_conf_uses_kubelet_conf(node):
    host = node(role="control")
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    host.write(ku.KUBELET_KUBECONFIG, "fake\n")
    assert agent(host) == 0
    assert {c[2] for c in host.calls if c[:1] == ["kubectl"]} == \
        {host.path(ku.KUBELET_KUBECONFIG)}


def test_agent_without_any_kubeconfig_does_nothing(node):
    host = node(role="worker")
    os.remove(host.path(ku.KUBELET_KUBECONFIG))
    assert agent(host) == 0
    assert not host.calls and state(host) is None


# --- idle node: release and node-type ----------------------------------------
def test_agent_publishes_release_and_node_type_then_stays_quiet(node):
    host = node()
    assert agent(host) == 0
    assert host.patches == [{RELEASE: "v2.4.0", NODE_TYPE: "bootstrap"}]
    assert agent(host) == 0
    assert len(host.patches) == 1, "nothing changed: no write"
    assert state(host) is None


def test_agent_fixes_stale_annotations(node):
    host = node()
    host.annotations.update({RELEASE: "v2.3.1", NODE_TYPE: "worker",
                             PHASE: "STAGE", MESSAGE: "old"})
    agent(host)
    assert host.annotations == {RELEASE: "v2.4.0", NODE_TYPE: "bootstrap"}


@pytest.mark.parametrize("mode", ["auto", "manual", "managed"])
def test_agent_never_starts_a_hop_without_a_target(node, mode):
    host = node(mode=mode)
    host.clock = datetime.datetime(2026, 11, 21, 2, 45)  # inside the window
    assert agent(host) == 0
    assert state(host) is None
    assert not commands(host, ["bootc", "switch"])


def test_managed_timer_does_nothing_inside_the_window(node):
    host = node(version="v2.3.0", mode="managed")
    host.clock = datetime.datetime(2026, 11, 21, 2, 45)
    assert run_cli(host, "auto") == 0
    assert state(host) is None


# --- upgrade-target ----------------------------------------------------------
def test_target_equal_to_the_release_is_done_at_once(node):
    host = node()
    host.annotations[TARGET] = "v2.4.0"
    assert agent(host) == 0
    assert host.annotations[DONE] == "v2.4.0"
    assert host.patches[0][RELEASE] == "v2.4.0", "release in the same write"
    assert state(host) is None and not commands(host, ["bootc", "switch"])


@pytest.mark.parametrize("value,why", [
    ("v2.3.1", "older than v2.4.0"),
    ("v2.6.0", "not one hop: the path is v2.4.0 -> v2.5.0 -> v2.6.0"),
    ("v2.9.9", "not in the upgrade graph"),
    ("latest", "not a release version"),
])
def test_illegal_target_holds_without_doing_anything(node, value, why):
    host = node(mode="managed")
    host.annotations[TARGET] = value
    assert agent(host) == 0
    assert host.annotations[PHASE] == "HOLD"
    assert why in host.annotations[MESSAGE]
    assert host.annotations[MESSAGE].startswith("upgrade-target")
    assert host.annotations[REASON] == "TargetRejected"
    assert state(host) is None
    assert not commands(host, ["bootc", "switch"])
    assert DONE not in host.annotations


def test_upgrade_done_goes_away_with_the_target(node):
    host = node(mode="managed")
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    finish(host)
    assert host.annotations[DONE] == "v2.5.0"
    agent(host)
    assert host.annotations[DONE] == "v2.5.0", "kept while the target is there"
    del host.annotations[TARGET]             # the operator moves on
    assert agent(host) == 0
    assert DONE not in host.annotations
    assert host.annotations[RELEASE] == "v2.5.0"


def test_no_done_when_the_target_goes_away_during_the_hop(node):
    host = node(mode="managed")
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    del host.annotations[TARGET]             # e.g. the ClusterUpgrade is gone
    assert finish(host)["current"] == "v2.5.0"
    assert DONE not in host.annotations
    assert host.annotations[RELEASE] == "v2.5.0"


def test_corrected_target_lifts_the_refusal(node):
    host = node(mode="managed")
    host.annotations[TARGET] = "v2.6.0"
    agent(host)
    assert host.annotations[PHASE] == "HOLD"
    host.annotations[TARGET] = "v2.5.0"
    assert agent(host) == 0
    assert state(host)["phase"] == "REBOOT"
    assert host.annotations[PHASE] == "REBOOT"
    assert MESSAGE not in host.annotations and REASON not in host.annotations


@pytest.mark.parametrize("mode", ["managed", "auto", "manual"])
def test_target_runs_a_minor_hop_in_any_mode_outside_the_window(node, mode):
    host = node(mode=mode)                   # autoAllow: patch, Tuesday
    host.annotations[TARGET] = "v2.5.0"
    assert agent(host) == 0
    st = state(host)
    assert st["mode"] == "operator" and st["hop"]["kind"] == "minor"
    assert commands(host, ["bootc", "switch", "--download-only"])[0][-1] == \
        "ghcr.io/gpillon/k4all-bootc:v2.5.0"
    assert st["phase"] == "REBOOT" and host.reboots == 1

    st = finish(host)
    assert st["phase"] == "DONE" and st["current"] == "v2.5.0"
    assert host.annotations[DONE] == "v2.5.0"
    assert host.annotations[RELEASE] == "v2.5.0"
    assert PHASE not in host.annotations and MESSAGE not in host.annotations
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations


def test_every_phase_is_published_and_done_comes_with_release(node):
    host = node(mode="managed")
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    finish(host)
    assert phases_published(host) == ["PREFLIGHT", "BACKUP", "STAGE",
                                      "PRE_REBOOT", "DRAIN", "REBOOT", "SYNC",
                                      "COMMIT"]
    done = [p for p in host.patches if p.get(DONE)]
    assert done[0] == {DONE: "v2.5.0", RELEASE: "v2.5.0", PHASE: None}
    assert host.patches.index(done[0]) > max(
        i for i, p in enumerate(host.patches) if p.get(PHASE) == "COMMIT")


def test_done_follows_the_manifest_sync_on_the_bootstrap(node):
    host = node(version="v2.3.1", mode="managed")
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump({
        "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
        "metadata": {"name": "k4all"},
        "spec": {"components": {"calico": {"version": "v3.33.1"}}}}))
    host.release_manifest = {"metadata": {"name": "k4all"},
                             "spec": {"components": {}}}
    host.annotations[TARGET] = "v2.4.0"
    agent(host)
    assert finish(host)["current"] == "v2.4.0"
    applied = max(i for i, c in enumerate(host.calls)
                  if c[:1] == ["kubectl"] and c[3:5] == ["apply", "--server-side"])
    done = min(i for i, c in enumerate(host.calls)
               if c[:1] == ["kubectl"] and c[3:4] == ["patch"]
               and DONE in c[c.index("-p") + 1])
    assert applied < done, "SYNC and the component wait come before upgrade-done"


# --- no drain: the operator cordoned and drained the node -------------------
def test_operator_hop_on_a_multinode_worker_needs_no_admin_kubeconfig(node):
    host = node(version="v2.5.0", role="worker", nodes=3)
    host.apiserver = "1.36.6"
    host.annotations[ku.ANNOTATION_CORDONED] = "true"
    host.annotations[TARGET] = "v2.6.0"
    assert agent(host) == 0
    assert state(host)["hold"] is None
    assert [c for c in host.calls if c[1:3] == ["upgrade", "node"]]
    assert not kubectl_calls(host, "drain")
    st = finish(host)
    assert st["current"] == "v2.6.0"
    assert host.annotations[DONE] == "v2.6.0"
    assert not kubectl_calls(host, "uncordon")
    assert host.annotations[ku.ANNOTATION_CORDONED] == "true", \
        "the cordon belongs to the operator"


def test_the_same_worker_hop_without_the_operator_still_needs_a_drain(node):
    host = node(version="v2.5.0", role="worker", nodes=3)
    host.apiserver = "1.36.6"
    assert run_cli(host, "run", "--yes") == 3, "not yet: no HOLD"
    assert state(host) is None
    assert any("needs a drain" in m for m in host.logs)
    assert PHASE not in host.annotations


def test_a_patch_hop_on_a_worker_also_needs_a_drain(node):
    # Every hop reboots, a Kubernetes minor or not.
    host = node(version="v2.3.0", role="worker")
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    assert any("needs a drain" in m for m in host.logs)


def waiting_operator_plan(node):
    host = node(version="v2.4.0", role="control", mode="managed")
    host.extra_nodes = [{"metadata": {"name": "kube-bootstrap-1", "annotations": {
        RELEASE: "v2.4.0", NODE_TYPE: "bootstrap"}},
        "status": {"conditions": [{"type": "Ready", "status": "True"}]}}]
    host.annotations[TARGET] = "v2.5.0"
    assert agent(host) == 0
    assert state(host)["waiting"]
    return host


# Review 2: a ClusterUpgrade cancelled while the hop waited for the
# bootstrap node; the next boot started it, without a drain.
def test_a_waiting_operator_hop_is_closed_when_the_target_goes(node):
    host = waiting_operator_plan(node)
    del host.annotations[TARGET]
    assert agent(host) == 0
    st = state(host)
    assert st["phase"] == "DONE" and st["history"][-1]["result"] == "target removed"
    assert PHASE not in host.annotations
    host.extra_nodes[0]["metadata"]["annotations"][RELEASE] = "v2.5.0"
    assert run_cli(host, "resume", "--boot") == 0
    assert not commands(host, ["bootc", "switch"])


def test_resume_by_hand_closes_a_waiting_operator_hop_without_target(node):
    host = waiting_operator_plan(node)
    del host.annotations[TARGET]
    host.extra_nodes[0]["metadata"]["annotations"][RELEASE] = "v2.5.0"
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "DONE"
    assert not commands(host, ["bootc", "switch"])
    assert any("no longer asks for v2.5.0" in m for m in host.logs)


def test_resume_by_hand_tries_a_waiting_operator_hop_still_asked_for(node):
    host = waiting_operator_plan(node)
    host.extra_nodes[0]["metadata"]["annotations"][RELEASE] = "v2.5.0"
    assert run_cli(host, "resume", "--boot") == 0
    assert state(host)["phase"] == "PREFLIGHT", "not at boot"
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "REBOOT"


# Review: "bootstrap behind" and "not cordoned" pass by themselves; as a HOLD
# a plan in auto mode never started again.
def test_an_operator_hop_waits_for_the_bootstrap_node_without_a_hold(node):
    host = node(version="v2.4.0", role="control", mode="managed")
    host.extra_nodes = [{"metadata": {"name": "kube-bootstrap-1", "annotations": {
        RELEASE: "v2.4.0", NODE_TYPE: "bootstrap"}},
        "status": {"conditions": [{"type": "Ready", "status": "True"}]}}]
    host.annotations[TARGET] = "v2.5.0"
    assert agent(host) == 0
    st = state(host)
    assert st["phase"] == "PREFLIGHT" and st["hold"] is None
    assert "the bootstrap node kube-bootstrap-1 runs v2.4.0" in st["waiting"]
    assert host.annotations[PHASE] == "PREFLIGHT"
    # Review 2: the reason is on the Node too, without a HOLD
    assert host.annotations[MESSAGE].startswith(
        "waiting: the bootstrap node kube-bootstrap-1 runs v2.4.0")
    assert REASON not in host.annotations
    assert not commands(host, ["bootc", "switch"])

    host.extra_nodes[0]["metadata"]["annotations"][RELEASE] = "v2.5.0"
    assert agent(host) == 0
    st = state(host)
    assert st["phase"] == "REBOOT" and "waiting" not in st
    assert MESSAGE not in host.annotations, "gone once the hop starts"


def test_operator_hop_on_the_bootstrap_neither_drains_nor_pauses_it(node):
    host = node(version="v2.5.0", nodes=3)
    host.annotations[TARGET] = "v2.6.0"
    assert agent(host) == 0
    assert [c for c in host.calls if c[1:3] == ["upgrade", "apply"]]
    assert host.operator_scale_history == [], \
        "an operator that writes upgrade-target knows the pause gate"
    assert host.annotations[ku.ANNOTATION_IN_PROGRESS] == "v2.5.0->v2.6.0"
    assert finish(host)["current"] == "v2.6.0"
    assert not kubectl_calls(host, "drain") and not kubectl_calls(host, "uncordon")


def test_a_run_on_the_bootstrap_still_drains_and_pauses(node):
    host = node(version="v2.5.0", nodes=3)
    run_cli(host, "run", "--yes")
    assert kubectl_calls(host, "drain")
    assert host.operator_scale_history == [0]


# --- HOLD and abandon ---------------------------------------------------------
def foreign_stage(host):
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}


def test_hold_publishes_phase_and_message(node):
    host = node(mode="managed")
    foreign_stage(host)
    host.annotations[TARGET] = "v2.5.0"
    assert agent(host) == 1
    assert host.annotations[PHASE] == "HOLD"
    assert "already staged" in host.annotations[MESSAGE]
    assert REASON not in host.annotations, "the operator calls it HostHold"
    before = len(host.patches)
    assert agent(host) == 0
    assert len(host.patches) == before, "HOLD stays as it is"
    assert state(host)["hold"]


def test_hold_resumed_by_hand_goes_on_and_clears_the_message(node):
    host = node(mode="managed")
    foreign_stage(host)
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    host.staged = None
    run_cli(host, "clear-hold")
    assert host.annotations[PHASE] == "PREFLIGHT"
    assert MESSAGE not in host.annotations
    run_cli(host, "resume")
    assert finish(host)["current"] == "v2.5.0"
    assert host.annotations[DONE] == "v2.5.0"


def test_hold_after_a_rollback_says_rollback_rebooted(node):
    host = node(mode="managed")
    host.healthy_after_boot = False
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    run_cli(host, "resume")                  # unhealthy: rollback and reboot
    assert host.annotations[PHASE] == "ROLLBACK_REBOOT"
    host.healthy_after_boot = True
    run_cli(host, "resume")
    assert host.annotations[PHASE] == "HOLD"
    assert host.annotations[REASON] == "RollbackRebooted"
    assert "rolled back to v2.4.0" in host.annotations[MESSAGE]
    run_cli(host, "clear-hold", "--abandon")
    assert host.annotations[PHASE] == "ABANDONED"
    assert REASON not in host.annotations


def test_agent_publishes_a_hold_it_missed(node):
    host = node()
    foreign_stage(host)
    host.apiserver_up = False
    run_cli(host, "run", "--to", "v2.5.0", "--yes")
    assert PHASE not in host.annotations
    host.apiserver_up = True
    agent(host)
    assert host.annotations[PHASE] == "HOLD"
    assert "already staged" in host.annotations[MESSAGE]


def test_abandon_drops_the_target_and_publishes_abandoned(node):
    host = node(mode="managed")
    foreign_stage(host)
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    assert run_cli(host, "clear-hold", "--abandon") == 0
    assert TARGET not in host.annotations
    assert host.annotations[PHASE] == "ABANDONED"
    assert "v2.4.0->v2.5.0 abandoned" in host.annotations[MESSAGE]
    assert "already staged" in host.annotations[MESSAGE]
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations

    host.staged = None
    switches = len(commands(host, ["bootc", "switch"]))
    assert agent(host) == 0
    assert host.annotations[PHASE] == "ABANDONED", "kept until a new request"
    assert len(commands(host, ["bootc", "switch"])) == switches

    host.annotations[TARGET] = "v2.5.0"          # the operator's retry
    assert agent(host) == 0
    assert state(host)["phase"] == "REBOOT"
    assert "abandoned" not in state(host)
    assert finish(host)["current"] == "v2.5.0"
    assert host.annotations[DONE] == "v2.5.0"
    assert PHASE not in host.annotations


def test_abandon_with_the_apiserver_down_removes_the_target_later(node):
    host = node(mode="managed")
    foreign_stage(host)
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    host.apiserver_up = False
    run_cli(host, "clear-hold", "--abandon")
    assert host.annotations[TARGET] == "v2.5.0"
    host.apiserver_up = True
    host.staged = None
    assert agent(host) == 0
    assert TARGET not in host.annotations
    assert host.annotations[PHASE] == "ABANDONED"
    assert not commands(host, ["bootc", "switch"]), \
        "an abandoned target is not picked up again"
    assert state(host)["abandoned"]["targetRemoved"]


def test_abandon_keeps_a_target_the_operator_changed(node):
    host = node(mode="managed")
    foreign_stage(host)
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    host.apiserver_up = False
    run_cli(host, "clear-hold", "--abandon")
    host.apiserver_up = True
    host.annotations[TARGET] = "v2.4.0"
    agent(host)
    assert host.annotations[TARGET] == "v2.4.0"
    assert host.annotations[DONE] == "v2.4.0"
    assert PHASE not in host.annotations


def test_abandon_of_a_plan_of_the_node_just_clears_the_phase(node):
    host = node()
    foreign_stage(host)
    run_cli(host, "run", "--to", "v2.5.0", "--yes")
    assert host.annotations[PHASE] == "HOLD"
    run_cli(host, "clear-hold", "--abandon")
    assert PHASE not in host.annotations and MESSAGE not in host.annotations


# --- concurrency and reboots -------------------------------------------------
def hold_lock(host):
    path = host.path(ku.STATE_DIR + "/lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = open(path, "w", encoding="utf-8")
    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fh


def test_agent_skips_its_pass_while_the_lock_is_held(node):
    host = node()
    host.annotations[TARGET] = "v2.5.0"
    fh = hold_lock(host)
    try:
        assert agent(host) == 0
    finally:
        fh.close()
    assert not host.calls and state(host) is None
    assert any("another k4all-upgrade is running" in m for m in host.logs)


def test_resume_waits_for_a_short_agent_pass(node):
    host = node()
    run_cli(host, "run", "--to", "v2.5.0", "--yes")
    assert state(host)["phase"] == "REBOOT"
    fh = hold_lock(host)
    original = host.sleep

    def sleep(seconds):
        fh.close()                         # the agent pass ends
        original(seconds)
    host.sleep = sleep
    assert run_cli(host, "resume") == 0
    assert state(host)["current"] == "v2.5.0"


def test_resume_gives_up_on_a_lock_held_too_long(node):
    host = node()
    run_cli(host, "run", "--to", "v2.5.0", "--yes")
    started = host.clock
    fh = hold_lock(host)
    try:
        assert run_cli(host, "resume") == 2
    finally:
        fh.close()
    assert host.clock - started >= datetime.timedelta(seconds=ku.RESUME_LOCK_WAIT)
    assert state(host)["phase"] == "REBOOT"


def test_timer_pass_skips_while_a_resume_holds_the_lock(node):
    # Seen on VM 951: the timer fired during a resume, k4all-upgrade.service
    # ended "failed" and showed up in `systemctl --failed`.
    host = node(mode="auto")
    run_cli(host, "run", "--to", "v2.5.0", "--yes")
    calls = len(host.calls)
    fh = hold_lock(host)
    try:
        assert run_cli(host, "auto") == 0
    finally:
        fh.close()
    assert len(host.calls) == calls and state(host)["phase"] == "REBOOT"
    assert any("auto: another k4all-upgrade is running; skipped" in m
               for m in host.logs)


def test_agent_leaves_the_phases_after_a_reboot_to_resume(node):
    host = node(mode="managed")
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    assert state(host)["phase"] == "REBOOT"
    calls = len(host.calls)
    host.annotations.pop(PHASE)
    assert agent(host) == 0                  # booted, resume not started yet
    new = host.calls[calls:]
    # kubectl, and the loader's --help for the x86-64 level: no phase runs
    assert all(c[:1] in (["kubectl"], [ku.LD_SO_X86_64]) for c in new), new
    assert state(host)["phase"] == "REBOOT"
    assert host.annotations[PHASE] == "REBOOT"
    assert host.annotations[RELEASE] == "v2.4.0", "not committed yet"
    assert finish(host)["current"] == "v2.5.0"


def test_operator_target_replaces_an_auto_plan_waiting_between_hops(node):
    host = node(version="v2.3.0", mode="auto")
    host.clock = datetime.datetime(2026, 11, 21, 2, 45)
    run_cli(host, "auto")                    # v2.3.1 only: v2.4.0 is a minor
    finish(host)
    st = state(host)
    st.update({"phase": "IDLE", "pending": [ku.Release(GRAPH[3]).to_dict()]})
    ku.save_state(host, st)
    host.clock = TUESDAY
    host.annotations[TARGET] = "v2.4.0"
    host.release_manifest = {"metadata": {"name": "k4all"},
                             "spec": {"components": {}}}
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump({
        "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
        "metadata": {"name": "k4all"}, "spec": {"components": {}}}))
    assert agent(host) == 0
    st = state(host)
    assert st["mode"] == "operator" and st["hop"]["to"] == "v2.4.0"
    assert [h["to"] for h in st["history"]] == ["v2.3.1"], "history kept"


def test_managed_mode_stops_a_leftover_auto_plan_between_hops(node):
    host = node(version="v2.2.4", kubernetes="1.35.6", mode="auto")
    host.write(ku.CONFIG_FILE, "mode: auto\nautoAllow: minor\n")
    host.clock = datetime.datetime(2026, 11, 21, 2, 45)
    run_cli(host, "auto")
    assert state(host)["hop"]["to"] == "v2.3.0"
    host.write(ku.CONFIG_FILE, "mode: managed\n")
    run_cli(host, "resume")
    st = state(host)
    assert st["current"] == "v2.3.0" and st["phase"] == "IDLE"
    assert st["pending"] and st["hop"] is None
    assert host.reboots == 1


# --- the apiserver is down, or refuses ----------------------------------------
def test_agent_with_the_apiserver_down_changes_nothing(node):
    host = node()
    host.apiserver_up = False
    assert agent(host) == 0
    assert state(host) is None and not host.patches
    assert any("cannot read Node k4all-node-1" in m for m in host.logs)


def test_phase_reports_never_stop_a_hop(node):
    host = node(version="v2.3.0", role="worker")
    host.unschedulable = True
    host.forbid_patch = True
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert not host.patches
    host.forbid_patch = False
    assert finish(host)["current"] == "v2.3.1"
    assert host.annotations[RELEASE] == "v2.3.1"


def test_a_refused_patch_is_logged(node):
    host = node(role="worker")
    host.forbid_patch = True
    assert agent(host) == 0
    assert any("cannot annotate Node k4all-node-1" in m and "forbidden" in m
               for m in host.logs)


def test_status_tells_who_asked_for_the_hop(node, capsys):
    host = node(mode="managed")
    host.annotations[TARGET] = "v2.5.0"
    agent(host)
    capsys.readouterr()
    run_cli(host, "status")
    assert "asked by the k4all-operator" in capsys.readouterr().out
