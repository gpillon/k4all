"""End-to-end behaviour of the phase driver against a simulated node."""

import datetime
import http.client
import json
import os
import subprocess
import time

import pytest
import yaml

from conftest import (READYZ_NOT_READY, Proc, index_digest, ku, manifest_digest,
                      release, run_cli, write_graph)

STREAM_23 = [
    release("v2.2.4", "patch", "v2.0.0-beta1", "1.35.6", "1.32", 43),
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 43),
    release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
            syncManifest=True),
]

TO_136 = [
    release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
    release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
]

TO_137 = [
    release("v2.8.0", "minor", "v2.7.0", "1.36.6", "1.36", 45),
    release("v2.9.0", "minor", "v2.8.0", "1.37.2", "1.37", 45),
]


def state(host):
    return ku.load_state(host)


def commands(host, prefix):
    return [c for c in host.calls if c[:len(prefix)] == prefix]


def index_of(host, predicate):
    for i, call in enumerate(host.calls):
        if predicate(call):
            return i
    raise AssertionError("command not run")


def finish(host, limit=10):
    """Boot-time resumes until the plan settles."""
    for _ in range(limit):
        st = state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


# --- hops without a Kubernetes change ------------------------------------------
def test_patch_hop_stages_reboots_and_commits(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert commands(host, ["bootc", "switch", "--download-only"])[0][-1] == \
        "ghcr.io/gpillon/k4all-bootc:v2.3.1"
    assert commands(host, ["bootc", "upgrade", "--from-downloaded", "--apply"])
    assert not [c for c in host.calls if "apply" in c and "upgrade" in c
                and c[0].endswith("kubeadm-1.35.10")]
    assert state(host)["phase"] == "REBOOT"
    assert host.annotations[ku.ANNOTATION_IN_PROGRESS] == "v2.3.0->v2.3.1"
    assert host.operator_scale_history == [], "no Kubernetes change, no pause"

    st = finish(host)
    assert st["phase"] == "DONE"
    assert st["current"] == "v2.3.1"
    assert st["history"][-1]["result"] == "ok"
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations


# VM 953: after `run --to v2.4.0` the v2.2.4 -> v2.3.0 entry was gone from
# state.json; the agent already kept it.
def test_a_new_run_keeps_the_history(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    finish(host)
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    st = finish(host)
    assert st["current"] == "v2.3.1"
    assert [(h["from"], h["to"], h["result"]) for h in st["history"]] == [
        ("v2.2.4", "v2.3.0", "ok"), ("v2.3.0", "v2.3.1", "ok")]


def test_the_timer_keeps_the_history(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.0", "--yes")
    finish(host)
    assert run_cli(host, "auto") == 0          # the patch, in the window
    st = finish(host)
    assert [h["to"] for h in st["history"]] == ["v2.3.0", "v2.3.1"]


def test_backup_runs_before_staging(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    backup = index_of(host, lambda c: c[0].endswith("k4all-backup.sh"))
    stage = index_of(host, lambda c: c[:3] == ["bootc", "switch", "--download-only"])
    assert backup < stage
    assert host.exists("%s/backup/v2.3.0-v2.3.1/files/var/lib/kubelet/config.yaml"
                       % ku.STATE_DIR)


# --- Kubernetes changes -------------------------------------------------------
def test_control_plane_is_upgraded_before_the_reboot(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)

    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    apply_at = index_of(host, lambda c: c[1:3] == ["upgrade", "apply"])
    reboot_at = index_of(host, lambda c: c[:3] == ["bootc", "upgrade",
                                                   "--from-downloaded"])
    assert apply_at < reboot_at
    kubeadm = host.calls[apply_at][0]
    assert kubeadm.endswith("/var/lib/k4all/upgrade/bin/kubeadm-1.35.10"), \
        "kubeadm must come from the staged image"
    assert host.calls[apply_at][3] == "v1.35.10"
    assert host.apiserver == "1.35.10"
    assert host.operator_replicas == 0, "old operators are paused for the hop"

    st = finish(host)
    assert st["current"] == "v2.3.0"
    assert host.booted["kubernetes"] == "1.35.10"
    assert host.operator_scale_history == [0, 1]


def test_kubeadm_is_read_from_the_staged_commit(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.0", "--yes")
    cat = [c for c in host.calls if c[:1] == ["ostree"]]
    assert cat and cat[0][2:] == ["cat", "c-v2.3.0", "/usr/bin/kubeadm"]


V1BETA3_CONFIG = """apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
networking:
  podSubnet: "10.100.0.1/18"
controllerManager:
  extraArgs:
    flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
nodeRegistration:
  kubeletExtraArgs:
    volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
"""


def test_136_hop_drops_the_flexvolume_flag_before_kubeadm(make_host):
    host = make_host(version="v2.5.0", kubernetes="1.35.10")
    write_graph(host, TO_136)
    host.write(ku.KUBEADM_CONFIG_FILE, V1BETA3_CONFIG)

    assert run_cli(host, "run", "--yes") == 0
    replace_at = index_of(host, lambda c: "replace" in c)
    apply_at = index_of(host, lambda c: c[1:3] == ["upgrade", "apply"])
    assert replace_at < apply_at
    names = [a["name"] for a in host.cluster_config["controllerManager"]["extraArgs"]]
    assert "flex-volume-plugin-dir" not in names
    # VM 953: kubeadm-config was clean after the 1.36 hop, /etc/k8s-config.yaml
    # still had the flag.
    docs = list(yaml.safe_load_all(host.read(ku.KUBEADM_CONFIG_FILE)))
    assert [d["apiVersion"] for d in docs] == ["kubeadm.k8s.io/v1beta3"] * 2, \
        "v1beta3 still works on 1.36: the file is converted on the 1.37 hop"
    assert docs[0]["controllerManager"]["extraArgs"] == {}
    assert docs[0]["networking"] == {"podSubnet": "10.100.0.1/18"}
    assert docs[1]["nodeRegistration"]["kubeletExtraArgs"] == {
        "volume-plugin-dir": "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"}, \
        "the kubelet's flag is another one, and stays"
    assert host.read(ku.KUBEADM_CONFIG_FILE + ".flexvolume.bak") == V1BETA3_CONFIG
    assert any("removed flex-volume-plugin-dir from /etc/k8s-config.yaml" in m
               for m in host.logs)


def test_136_hop_cleans_the_kubeadm_config_file_on_every_control_plane(make_host):
    host = make_host(version="v2.5.0", kubernetes="1.35.10", role="control")
    write_graph(host, TO_136)
    host.node_count = 2
    host.apiserver = "1.36.6"           # the bootstrap node went first
    host.cluster_config["kubernetesVersion"] = "v1.36.6"
    host.write(ku.KUBEADM_CONFIG_FILE, V1BETA3_CONFIG)
    assert run_cli(host, "run", "--yes") == 0
    docs = list(yaml.safe_load_all(host.read(ku.KUBEADM_CONFIG_FILE)))
    assert docs[0]["controllerManager"]["extraArgs"] == {}
    assert not [c for c in host.calls if "replace" in c], \
        "only the bootstrap node changes kubeadm-config"


def test_a_clean_kubeadm_config_file_is_left_alone(make_host):
    host = make_host(version="v2.5.0", kubernetes="1.35.10")
    write_graph(host, TO_136)
    clean = V1BETA3_CONFIG.replace(
        '  extraArgs:\n    flex-volume-plugin-dir: '
        '"/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"\n', "  {}\n")
    host.write(ku.KUBEADM_CONFIG_FILE, clean)
    assert run_cli(host, "run", "--yes") == 0
    assert host.read(ku.KUBEADM_CONFIG_FILE) == clean
    assert not host.exists(ku.KUBEADM_CONFIG_FILE + ".flexvolume.bak")


def test_137_hop_converts_the_kubeadm_config_file_first(make_host):
    host = make_host(version="v2.8.0", kubernetes="1.36.6")
    host.cluster_config["controllerManager"] = {}
    write_graph(host, TO_137)
    host.write(ku.KUBEADM_CONFIG_FILE, V1BETA3_CONFIG)

    assert run_cli(host, "run", "--yes") == 0
    assert not [c for c in host.calls if c[:3] == ["kubeadm", "config", "migrate"]], \
        "kubeadm config migrate would inject defaults (token, address, socket)"
    docs = list(yaml.safe_load_all(host.read(ku.KUBEADM_CONFIG_FILE)))
    assert [d["apiVersion"] for d in docs] == ["kubeadm.k8s.io/v1beta4"] * 2
    assert docs[0]["controllerManager"]["extraArgs"] == [
        {"name": "flex-volume-plugin-dir",
         "value": "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"}]
    assert docs[1]["nodeRegistration"]["kubeletExtraArgs"] == [
        {"name": "volume-plugin-dir",
         "value": "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"}]
    assert "bootstrapTokens" not in docs[1] and "localAPIEndpoint" not in docs[1]
    assert host.read(ku.KUBEADM_CONFIG_FILE + ".v1beta3.bak") == V1BETA3_CONFIG
    assert finish(host)["current"] == "v2.9.0"


# Review 2: the file is parsed only when it holds the flag, and a file
# that cannot be parsed is a HOLD, never an exception out of the driver.
def test_a_kubeadm_config_without_the_flag_is_not_parsed(make_host, monkeypatch):
    host = make_host()
    host.write(ku.KUBEADM_CONFIG_FILE, "kind: InitConfiguration\n")
    monkeypatch.setattr(ku, "load_yaml_docs", lambda *a: pytest.fail("parsed"))
    assert ku.rewrite_kubeadm_config_file(
        host, ("flex-volume-plugin-dir",), lambda d: True, ".bak", "x") is False


def test_a_kubeadm_config_that_does_not_parse_is_a_hold(make_host):
    host = make_host(version="v2.5.0", kubernetes="1.35.10")
    write_graph(host, TO_136)
    host.write(ku.KUBEADM_CONFIG_FILE, "flex-volume-plugin-dir: [unclosed\n")
    assert run_cli(host, "run", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PRE_REBOOT"
    assert "cannot parse /etc/k8s-config.yaml" in st["hold"]["reason"]


def test_v1beta4_conversion_moves_timeouts():
    join = {"apiVersion": "kubeadm.k8s.io/v1beta3", "kind": "JoinConfiguration",
            "discovery": {"timeout": "5m0s"}}
    doc, changed = ku.kubeadm_doc_to_v1beta4(join)
    assert changed and doc["timeouts"] == {"discovery": "5m0s"}
    same, changed = ku.kubeadm_doc_to_v1beta4({"apiVersion": "kubeadm.k8s.io/v1beta4"})
    assert not changed


def test_worker_waits_for_the_control_plane(make_host):
    host = make_host(version="v2.5.0", kubernetes="1.35.10", role="worker")
    write_graph(host, TO_136)
    host.apiserver = "1.35.10"

    assert run_cli(host, "run", "--yes") == 3
    assert state(host) is None, "not yet: no plan, no HOLD left behind"
    assert any("upgrade the control plane" in m for m in host.logs)
    assert not commands(host, ["bootc", "switch"])


def test_worker_upgrades_once_the_control_plane_is_ahead(make_host):
    host = make_host(version="v2.5.0", kubernetes="1.35.10", role="worker")
    write_graph(host, TO_136)
    host.apiserver = "1.36.6"
    host.unschedulable = True       # drained from a control plane

    assert run_cli(host, "run", "--yes") == 0
    node_at = index_of(host, lambda c: c[1:3] == ["upgrade", "node"])
    reboot_at = index_of(host, lambda c: c[:3] == ["bootc", "upgrade",
                                                   "--from-downloaded"])
    assert node_at < reboot_at
    assert finish(host)["current"] == "v2.6.0"


# --- the bootstrap node goes first --------------------------------------------
# Lab: a cluster installed with kubeadm's stable-1.35 already ran apiserver
# 1.35.10, so the Kubernetes checks let the v2.3.0 hop start on a node before
# the bootstrap one. A control plane reads the bootstrap node's Node.
def bootstrap_node(name="kube-bootstrap-3e0pg", release=None, kubelet="v1.35.6",
                   node_type=None):
    annotations = {}
    if release:
        annotations[ku.ANNOTATION_RELEASE] = release
    if node_type:
        annotations[ku.ANNOTATION_NODE_TYPE] = node_type
    return {"metadata": {"name": name, "annotations": annotations},
            "status": {"nodeInfo": {"kubeletVersion": kubelet},
                       "conditions": [{"type": "Ready", "status": "True"}]}}


def control_on(make_host, version, kubernetes):
    host = make_host(version=version, kubernetes=kubernetes, role="control")
    host.kubelet_name = "kube-control-oqb53"
    write_graph(host, STREAM_23 + LADDER_UP)
    host.apiserver = host.cluster_version = "1.35.10"
    host.cluster_config["kubernetesVersion"] = "v1.35.10"
    return host


LADDER_UP = [
    release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
]


def test_a_control_plane_waits_for_the_bootstrap_kubelet(make_host):
    host = control_on(make_host, "v2.2.4", "1.35.6")
    host.extra_nodes = [bootstrap_node(kubelet="v1.35.6")]

    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 3
    assert state(host) is None
    assert ("not yet: the bootstrap node kube-bootstrap-3e0pg runs kubelet "
            "v1.35.6, the hop to v2.3.0 brings 1.35.10: run it there first") \
        in host.logs
    assert not commands(host, ["bootc", "switch"])

    host.extra_nodes = [bootstrap_node(kubelet="v1.35.10")]
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"


def test_a_control_plane_waits_for_the_bootstrap_release(make_host):
    # v2.4.0 -> v2.5.0 changes no Kubernetes: only the release annotation
    # that v2.4.0's k4all-upgrade publishes shows where the bootstrap is.
    host = control_on(make_host, "v2.4.0", "1.35.10")
    host.extra_nodes = [bootstrap_node(name="b1", release="v2.4.0",
                                       kubelet="v1.35.10", node_type="bootstrap")]

    assert run_cli(host, "run", "--to", "v2.5.0", "--yes") == 3
    assert any(m.startswith("not yet: the bootstrap node b1 runs v2.4.0: run "
                            "the hop to v2.5.0 there first") for m in host.logs)

    host.extra_nodes[0]["metadata"]["annotations"][ku.ANNOTATION_RELEASE] = "v2.5.0"
    assert run_cli(host, "run", "--to", "v2.5.0", "--yes") == 0


def test_without_a_known_bootstrap_node_the_order_is_not_checked(make_host):
    host = control_on(make_host, "v2.2.4", "1.35.6")
    host.extra_nodes = [bootstrap_node(name="node-a", kubelet="v1.35.6")]
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    assert any("no bootstrap Node found" in m for m in host.logs)


@pytest.mark.parametrize("nodes,expected", [
    # the annotation wins over the name
    ([bootstrap_node(name="kube-bootstrap-a"),
      bootstrap_node(name="x", node_type="bootstrap")], "x"),
    ([bootstrap_node(name="kube-bootstrap-a")], "kube-bootstrap-a"),
    ([bootstrap_node(name="kube-bootstrap-a"),
      bootstrap_node(name="kube-bootstrap-b")], None),
    ([bootstrap_node(name="me", node_type="bootstrap")], None),
    ([], None),
])
def test_find_bootstrap_node(nodes, expected):
    found = ku.find_bootstrap_node(nodes, "me")
    assert (found["metadata"]["name"] if found else None) == expected


def test_bootstrap_behind_ignores_what_it_cannot_parse():
    hop = {"to": "v2.3.0", "kubernetes": "1.35.10"}
    assert ku.bootstrap_behind([bootstrap_node(kubelet="")], "me", hop) is None
    assert ku.bootstrap_behind([bootstrap_node(release="v2.3.0")], "me", hop) is None
    assert ku.bootstrap_behind([bootstrap_node(release="v2.4.0")], "me", hop) is None


# --- drain: who does it ------------------------------------------------------
# Lab, three nodes: a worker's `k4all-upgrade run` logged "single-node
# cluster: no drain" and rebooted with its pods. kubelet.conf may not list
# the Nodes (Node authorizer), so the tool believed it was alone.
def test_a_worker_is_never_a_single_node_cluster(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    assert state(host) is None, "nothing started: no plan left behind"
    reason = [m for m in host.logs if m.startswith("not yet: ")][0]
    assert "Node k4all-node-1 is not cordoned" in reason
    assert "kubectl drain k4all-node-1 --ignore-daemonsets " \
           "--delete-emptydir-data" in reason
    assert "then the hop can start" in reason
    assert "kubectl uncordon k4all-node-1" in reason
    assert not commands(host, ["bootc", "switch"]), "nothing staged yet"
    assert not any("single-node" in m for m in host.logs)


def test_a_worker_drained_from_outside_goes_on_and_stays_cordoned(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    host.unschedulable = True       # `kubectl drain` from a control plane

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert not [c for c in host.calls if c[:1] == ["kubectl"]
                and c[3:4] in (["drain"], ["uncordon"])]
    st = finish(host)
    assert st["current"] == "v2.3.1"
    assert host.unschedulable, "the cordon belongs to whoever drained the node"
    assert any("Node k4all-node-1 is still cordoned" in m
               and "kubectl uncordon k4all-node-1" in m for m in host.logs)


def test_a_worker_uncordoned_before_the_reboot_holds_again(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.unschedulable = True
    real = ku.Upgrader.pre_reboot

    def uncordon_meanwhile(self, st):
        real(self, st)
        host.unschedulable = False
    ku.Upgrader.pre_reboot = uncordon_meanwhile
    try:
        assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    finally:
        ku.Upgrader.pre_reboot = real
    st = state(host)
    assert st["phase"] == "DRAIN" and "is not cordoned" in st["hold"]["reason"]
    assert not commands(host, ["bootc", "upgrade", "--from-downloaded"])


def test_a_worker_that_cannot_read_its_node_does_not_reboot(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.apiserver_up = False
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    assert any("cannot read Node k4all-node-1" in m for m in host.logs)
    assert host.reboots == 0


def test_a_waiting_worker_in_auto_mode_starts_at_a_later_pass(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    assert run_cli(host, "auto") == 0
    st = state(host)
    assert st["phase"] == "PREFLIGHT" and st["hold"] is None
    assert "is not cordoned" in st["waiting"]

    assert run_cli(host, "auto") == 0, "still waiting, no HOLD"
    assert state(host)["phase"] == "PREFLIGHT"
    host.unschedulable = True
    host.clock = datetime.datetime(2026, 11, 17, 10, 0)     # outside the window
    assert run_cli(host, "auto") == 0
    assert state(host)["phase"] == "PREFLIGHT", "a waiting hop keeps the window"
    host.clock = datetime.datetime(2026, 11, 21, 3, 0)
    assert run_cli(host, "auto") == 0
    st = state(host)
    assert st["phase"] == "REBOOT" and "waiting" not in st


# Review 2: resume at boot started hops that were waiting, without the
# window, the mode, or the operator still asking for them.
def parked_auto_worker(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    assert run_cli(host, "auto") == 0
    assert state(host)["waiting"]
    host.unschedulable = True       # the admin drains it
    return host


def test_resume_at_boot_leaves_a_waiting_hop_alone(make_host):
    host = parked_auto_worker(make_host)
    host.clock = datetime.datetime(2026, 11, 17, 10, 0)     # outside the window
    assert run_cli(host, "resume", "--boot") == 0
    assert state(host)["phase"] == "PREFLIGHT"
    assert not commands(host, ["bootc", "switch"])
    assert any(m.startswith("a hop waits: ") and "timer" in m for m in host.logs)
    host.clock = datetime.datetime(2026, 11, 21, 3, 0)      # inside it
    assert run_cli(host, "resume", "--boot") == 0
    assert state(host)["phase"] == "PREFLIGHT", "at boot, never"


def test_resume_by_hand_tries_once_under_the_timers_rules(make_host):
    host = parked_auto_worker(make_host)
    host.clock = datetime.datetime(2026, 11, 17, 10, 0)
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "PREFLIGHT"
    assert any("waits for the window" in m for m in host.logs)
    host.clock = datetime.datetime(2026, 11, 21, 3, 0)
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "REBOOT"


def test_a_waiting_hop_says_how_it_goes_on(make_host, capsys):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    run_cli(host, "auto")
    assert any(m.startswith("not yet: ") and "then the hop can start" in m
               and "the timer tries again inside the window, or now: "
               "`k4all-upgrade resume`" in m for m in host.logs)
    capsys.readouterr()
    run_cli(host, "status")
    out = capsys.readouterr().out
    assert "Waiting:   this node needs a drain" in out
    assert "HOLD:" not in out


def test_a_run_that_waits_keeps_the_previous_state(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.unschedulable = True
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    finish(host)
    before = host.read(ku.state_path())
    host.write(ku.VERSION_FILE, "v2.3.0\n")     # rolled back by hand
    host.unschedulable = False
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    assert host.read(ku.state_path()) != "" and \
        ku.load_state(host)["history"] == json.loads(before)["history"]
    assert ku.load_state(host)["phase"] == "DONE"


# Review: drain() asked for a cordon where it must not.
def test_a_node_without_a_kubeconfig_is_not_drained(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    os.remove(host.path(ku.KUBELET_KUBECONFIG))
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert any("in no cluster, no drain" in m for m in host.logs)


def test_a_bootstrap_with_kubelet_conf_only_is_not_drained(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    host.write(ku.KUBELET_KUBECONFIG, "fake\n")
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert any("WARNING: bootstrap node without" in m for m in host.logs)
    assert not [c for c in host.calls if c[3:4] == ["drain"]]


def test_a_control_plane_with_kubelet_conf_only_does_not_wait_on_the_node_list(
        make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="control")
    write_graph(host, STREAM_23)
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    host.write(ku.KUBELET_KUBECONFIG, "fake\n")
    host.unschedulable = True
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.sleeps == [], "forbidden is not 'not ready'"
    assert any("may not list the Nodes" in m for m in host.logs)
    assert state(host)["phase"] == "REBOOT"


def test_a_control_plane_with_kubelet_conf_only_needs_a_drain(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="control")
    write_graph(host, STREAM_23)
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    host.write(ku.KUBELET_KUBECONFIG, "fake\n")
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    assert any("is not cordoned" in m for m in host.logs)


def test_a_control_plane_drains_itself(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="control")
    write_graph(host, STREAM_23)
    host.node_count = 2
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert [c for c in host.calls if c[3:5] == ["drain", "k4all-node-1"]]
    finish(host)
    assert not host.unschedulable, "uncordoned after the reboot"


def test_a_lone_control_plane_is_still_drained(make_host):
    # Only a bootstrap node can be the whole cluster.
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="control")
    write_graph(host, STREAM_23)
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert [c for c in host.calls if c[3:4] == ["drain"]]


def test_a_bootstrap_that_cannot_list_the_nodes_drains(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    upgrader = ku.Upgrader(host, ku.load_config(host))
    host.apiserver_up = False
    assert upgrader._cluster_nodes() is None
    assert not upgrader._single_node()
    host.apiserver_up = True
    assert upgrader._single_node()
    host.node_count = 2
    assert not upgrader._single_node()


# --- the reboot does not wait on slow pods ------------------------------------
# Multi-node lab: control-plane reboots took 4 minutes. ingress-nginx (a
# DaemonSet, so not drained: 300 s grace and a preStop that waits for nginx)
# held the shutdown, with the API down all along.
def test_pods_are_stopped_with_a_deadline_before_the_reboot(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    stop = index_of(host, lambda c: c == ["systemctl", "stop", "kubelet"])
    pods = index_of(host, lambda c: c[:2] == ["sh", "-c"] and "stopp" in c[2])
    reboot = index_of(host, lambda c: c[:3] == ["bootc", "upgrade",
                                                "--from-downloaded"])
    assert stop < pods < reboot
    assert "--timeout=30s stopp" in host.calls[pods][2]
    assert host.pods_stopped == 1


def test_a_failed_reboot_starts_kubelet_again(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    real = host._bootc

    def failing(args):
        if args[:1] == ["upgrade"]:
            return Proc(returncode=1, stderr="no staged deployment")
        return real(args)
    host._bootc = failing
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    st = state(host)
    assert st["phase"] == "DRAIN" and "no staged deployment" in st["hold"]["reason"]
    assert host.kubelet_running
    assert host.reboots == 0


def test_the_rollback_reboot_stops_the_pods_too(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.healthy_after_boot = False
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    before = host.pods_stopped
    run_cli(host, "resume")
    assert state(host)["phase"] == "ROLLBACK_REBOOT"
    assert host.pods_stopped == before + 1


# Review: a TimeoutExpired from Host.run left kubelet stopped, without the
# reboot and without a HOLD.
def test_a_failing_pod_stop_does_not_stop_the_reboot(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    real = host._dispatch

    def stuck(argv, input_text):
        if argv[:1] == ["sh"]:
            raise ku.subprocess.TimeoutExpired(argv, 90)
        if argv[:2] == ["systemctl", "stop"]:
            return Proc(returncode=1, stderr="Job for kubelet.service canceled")
        return real(argv, input_text)
    host._dispatch = stuck
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.reboots == 1
    assert any("before the reboot: sh" in m for m in host.logs)
    assert any("before the reboot: systemctl stop exited 1" in m for m in host.logs)


# VM 953: "before the reboot: sh -c exited 123: ... failed to remove netns
# path: unlinkat /var/run/netns/...: device or resource busy" on every hop. It
# is xargs saying that some `crictl stopp` failed; the reboot ends those pods.
NETNS_BUSY = ('time="2026-11-18T08:20:44Z" level=fatal msg="stopping the pod '
              'sandbox \\"5eac46e3\\": rpc error: code = Unknown desc = failed '
              'to remove netns path: unlinkat /var/run/netns/5eac46e3-a8e6-413e-'
              'bf1a-7e0ad8c19ea8: device or resource busy"')


def _pod_stop_answers(host, rc, stderr):
    real = host._dispatch

    def answer(argv, input_text):
        if argv[:2] == ["sh", "-c"] and "stopp" in argv[2]:
            host.pods_stopped += 1
            return Proc(returncode=rc, stderr=stderr)
        return real(argv, input_text)
    host._dispatch = answer


def test_pods_that_do_not_stop_cleanly_are_only_a_note(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    _pod_stop_answers(host, 123, NETNS_BUSY)
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.reboots == 1
    note, = [m for m in host.logs if m.startswith("before the reboot:")]
    assert note.startswith("before the reboot: some pods did not stop cleanly; "
                           "the reboot ends them (last crictl message: ")
    assert "device or resource busy" in note and "exited" not in note


def test_a_pod_stop_that_cannot_run_still_says_how_it_exited(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    _pod_stop_answers(host, 127, "sh: crictl: command not found")
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.reboots == 1
    assert "before the reboot: sh -c exited 127: sh: crictl: command not found" \
        in host.logs


def test_host_run_turns_a_timeout_into_a_failed_command(monkeypatch):
    def slow(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"], output="half")
    monkeypatch.setattr(ku.subprocess, "run", slow)
    got = ku.Host().run(["sleep", "99"], check=False, timeout=5)
    assert got.returncode == 124
    assert got.stdout == "half" and "timed out after 5 s" in got.stderr
    with pytest.raises(ku.UpgradeError, match="rc=124"):
        ku.Host().run(["sleep", "99"], timeout=5)
    assert ku.Host().run_bytes(["sleep", "99"], timeout=5) == b""


def test_host_run_turns_a_missing_command_into_a_failed_command(monkeypatch):
    def missing(argv, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", argv[0])
    monkeypatch.setattr(ku.subprocess, "run", missing)
    assert ku.Host().run(["crictl"], check=False).returncode == 127
    with pytest.raises(ku.UpgradeError, match="rc=127"):
        ku.Host().run(["crictl"])


@pytest.mark.parametrize("error", [
    OSError("timed out"),
    http.client.IncompleteRead(b"partial", 1000),
    http.client.BadStatusLine("garbage"),
    UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte"),
])
def test_a_kubeadm_download_that_fails_is_a_hold(make_host, error):
    # The staged image has no kubeadm and dl.k8s.io fails: a HOLD in
    # PRE_REBOOT with the operator running again, not a crash half way.
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    host.run_bytes = lambda argv, timeout=None: b""

    def failing(url, timeout=20):
        raise error
    host.fetch = failing
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PRE_REBOOT"
    assert "cannot download kubeadm v1.35.10: %s" % type(error).__name__ \
        in st["hold"]["reason"]
    assert host.operator_scale_history == [0, 1]


def test_the_stop_script_stops_every_pod_at_once(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "stopp.log"
    crictl = bin_dir / "crictl"
    crictl.write_text("#!/bin/bash\n"
                      'case " $* " in\n'
                      '  *" pods -q --state ready "*) printf "p1\\np2\\np3\\n" ;;\n'
                      '  *" stopp "*) sleep 1; echo "$*" >> %s ;;\n'
                      "esac\n" % log)
    crictl.chmod(0o755)
    env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]))
    started = time.monotonic()
    subprocess.run(["sh", "-c", ku.STOP_PODS_SCRIPT % 30], env=env, check=True)
    elapsed = time.monotonic() - started
    lines = sorted(log.read_text().splitlines())
    assert [l.split()[-1] for l in lines] == ["p1", "p2", "p3"]
    assert all("--runtime-endpoint unix:///run/crio/crio.sock --timeout=30s "
               "stopp" in l for l in lines)
    assert elapsed < 2.5, "the pods stop in parallel"


# --- failures ---------------------------------------------------------------
def test_unhealthy_node_rolls_back_once_then_holds(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.healthy_after_boot = False

    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    run_cli(host, "resume")             # post-boot check times out
    assert commands(host, ["bootc", "rollback"])
    assert state(host)["phase"] == "ROLLBACK_REBOOT"
    assert host.booted["version"] == "v2.3.0"

    host.healthy_after_boot = True
    run_cli(host, "resume")
    st = state(host)
    assert st["hold"] and "rolled back to v2.3.0" in st["hold"]["reason"]
    assert ku.ANNOTATION_IN_PROGRESS in host.annotations, \
        "the operator stays paused while the node needs a human"


# Review 2: a failed reboot inside rollback() went out of the driver, with
# the state already ROLLBACK_REBOOT and no HOLD; the next resume then said
# "rolled back" when nothing had rebooted.
def test_a_rollback_whose_reboot_fails_holds_with_the_true_reason(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.healthy_after_boot = False
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    real = host._dispatch

    def no_reboot(argv, input_text):
        if argv[:2] == ["systemctl", "reboot"]:
            return Proc(returncode=1, stderr="Failed to reboot: Access denied")
        return real(argv, input_text)
    host._dispatch = no_reboot
    assert run_cli(host, "resume") == 1
    st = state(host)
    assert st["phase"] == "ROLLBACK_REBOOT"
    assert "v2.3.0 is set for the next boot" in st["hold"]["reason"]
    assert "the reboot failed" in st["hold"]["reason"]
    assert host.kubelet_running


def test_a_rollback_is_recorded_before_anything_else_can_fail(make_host):
    # Third review: a failed copy of the kubelet files after `bootc rollback`
    # left the state in REBOOT, so the next resume ran `bootc rollback` again
    # and flipped the node back to the broken image.
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.healthy_after_boot = False
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    real_copy = host.copy

    def broken_copy(src, dst):
        if dst.startswith("/var/lib/kubelet/"):
            raise OSError("read-only file system")
        return real_copy(src, dst)
    host.copy = broken_copy
    run_cli(host, "resume")
    st = state(host)
    assert st["phase"] == "ROLLBACK_REBOOT" and st["rollbacks"] == 1
    rollbacks = [c for c in host.calls if c[:2] == ["bootc", "rollback"]
                 or c[-2:] == ["/usr/bin/bootc", "rollback"]]
    assert len(rollbacks) == 1, rollbacks
    assert any("could not restore /var/lib/kubelet/config.yaml" in m
               for m in host.logs)


def test_a_rollback_that_bootc_refuses_holds_where_it_was(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.healthy_after_boot = False
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    real = host._bootc

    def refuse(args):
        if args[:1] == ["rollback"]:
            return Proc(returncode=1, stderr="no rollback deployment")
        return real(args)
    host._bootc = refuse
    assert run_cli(host, "resume") == 1
    st = state(host)
    assert st["phase"] == "REBOOT" and st["rollbacks"] == 0
    assert "bootc could not roll back" in st["hold"]["reason"]
    assert host.reboots == 1, "no second reboot"


def test_node_still_on_the_old_image_holds_without_rollback(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    # simulate a boot back into the old deployment
    host.booted = {"version": "v2.3.0", "kubernetes": "1.35.10"}
    host.write(ku.VERSION_FILE, "v2.3.0\n")

    run_cli(host, "resume")
    st = state(host)
    assert "still on v2.3.0" in st["hold"]["reason"]
    assert not commands(host, ["bootc", "rollback"])


def test_a_kubeadm_apply_that_times_out_once_is_tried_again(make_host):
    # VM 953, 18 nov: etcd came back after 150 s and kubeadm gave up
    # ("context deadline exceeded"); the second run went through.
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    original = host._kubeadm
    tries = []

    def flaky(cmd, args):
        if args[:2] == ["upgrade", "apply"]:
            tries.append(args)
            if len(tries) == 1:
                from conftest import Proc
                return Proc(returncode=1, stderr="fatal error creating etcd "
                            "client: context deadline exceeded")
        return original(cmd, args)
    host._kubeadm = flaky
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    assert len(tries) == 2
    assert state(host)["phase"] == "REBOOT"
    assert any("waiting for the apiserver to try once more" in m
               for m in host.logs)
    logs = os.listdir(host.path(ku.STATE_DIR + "/logs"))
    assert any(name.startswith("kubeadm-") for name in logs), \
        "kubeadm's whole output is kept"


def test_the_kubeadm_log_is_named_by_its_start(make_host):
    # VM 953: the name had the time kubeadm ended, minutes after the
    # "kubeadm upgrade apply" line of the journal.
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    original = host._kubeadm
    started = []

    def slow(cmd, args):
        if args[:2] == ["upgrade", "apply"]:
            started.append(host.clock)
            host.clock += datetime.timedelta(seconds=113)
        return original(cmd, args)
    host._kubeadm = slow
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    logs = [n for n in os.listdir(host.path(ku.STATE_DIR + "/logs"))
            if n.startswith("kubeadm-")]
    assert logs == ["kubeadm-%s.log" % started[0].strftime("%Y%m%dT%H%M%S")]


def _scale_up_fails(host):
    """kubectl scale --replicas>0 of the operator fails, as with the
    apiserver down; returns a function that heals it."""
    original = host._kubectl

    def broken(args, input_text, kubeconfig=""):
        if args[:1] == ["-n"] and args[2:3] == ["scale"] \
                and args[-1] != "--replicas=0":
            from conftest import Proc
            return Proc(returncode=1, stderr="The connection to the server "
                        "192.168.6.132:6443 was refused")
        return original(args, input_text, kubeconfig)
    host._kubectl = broken

    def heal():
        host._kubectl = original
    return heal


def _kubeadm_apply_fails(host):
    original = host._kubeadm

    def failing(cmd, args):
        if args[:2] == ["upgrade", "apply"]:
            from conftest import Proc
            return Proc(returncode=1, stderr="context deadline exceeded")
        return original(cmd, args)
    host._kubeadm = failing

    def heal():
        host._kubeadm = original
    return heal


def test_a_hold_with_the_api_down_keeps_the_operator_replicas(make_host):
    # VM 953, 18 nov: the HOLD after a failed kubeadm dropped the saved
    # replicas although the scale failed; the retry saw 0 replicas, saved
    # nothing, and the operator stayed at 0 for good.
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    heal_kubeadm = _kubeadm_apply_fails(host)
    heal_scale = _scale_up_fails(host)
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PRE_REBOOT"
    assert st["hop"]["operatorReplicas"] == 1, "kept for a later pass"
    assert host.operator_replicas == 0
    assert any("k4all-operator not resumed yet" in m for m in host.logs)

    heal_scale()
    heal_kubeadm()
    run_cli(host, "clear-hold")
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "REBOOT"
    assert host.operator_replicas == 0, "paused again for the hop"
    finish(host)
    assert host.operator_replicas == 1


def test_the_agent_brings_a_held_operator_back_when_the_api_answers(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    _kubeadm_apply_fails(host)
    heal_scale = _scale_up_fails(host)
    run_cli(host, "run", "--to", "v2.3.0", "--yes")
    assert host.operator_replicas == 0
    heal_scale()
    assert run_cli(host, "agent") == 0
    assert host.operator_replicas == 1
    st = state(host)
    assert "operatorReplicas" not in st["hop"] and st["hold"]


def test_failed_kubeadm_apply_holds_and_resumes_the_operator(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    original = host._kubeadm

    def failing(cmd, args):
        if args[:2] == ["upgrade", "apply"]:
            from conftest import Proc
            return Proc(returncode=1, stderr="etcd unhealthy")
        return original(cmd, args)
    host._kubeadm = failing

    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PRE_REBOOT" and "etcd unhealthy" in st["hold"]["reason"]
    assert host.operator_scale_history == [0, 1]
    assert not commands(host, ["bootc", "upgrade", "--from-downloaded"])
    # Review 2: before the reboot the cluster is unchanged: the pause
    # annotation goes too, and comes back when the hop goes on.
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations

    host._kubeadm = original
    run_cli(host, "clear-hold")
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "REBOOT"
    assert host.annotations[ku.ANNOTATION_IN_PROGRESS] == "v2.2.4->v2.3.0"
    assert host.operator_scale_history == [0, 1, 0]


def test_foreign_staged_deployment_blocks_the_hop(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "already staged" in state(host)["hold"]["reason"]
    assert not commands(host, ["bootc", "switch"])


# --- releases named by digest ---------------------------------------------------
# VM 953, 18 nov: the published graph named every release by the digest of its
# multi-arch index. bootc keeps that ref, but reports the digest of the amd64
# manifest inside the index as imageDigest, and the tool compared only the
# digests: every hop stopped in HOLD at STAGE ("bootc did not stage ...").
BOOTC_REPO = "ghcr.io/gpillon/k4all-bootc"


def by_index_digest(entries, key="indexDigest"):
    return [dict(entry, **{key: index_digest(entry["version"])})
            for entry in entries]


@pytest.mark.parametrize("key", ["indexDigest", "digest"])
def test_a_hop_by_index_digest_is_staged_and_committed(make_host, key):
    # indexDigest from v2.6.1 on; "digest" in the graphs up to v2.6.0
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, by_index_digest(STREAM_23, key))
    ref = "%s@%s" % (BOOTC_REPO, index_digest("v2.3.1"))

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert commands(host, ["bootc", "switch", "--download-only"])[0][-1] == ref
    st = state(host)
    assert st["phase"] == "REBOOT" and not st.get("hold")
    st = finish(host)
    assert st["current"] == "v2.3.1" and st["phase"] == "DONE"
    assert host.booted["image"] == ref
    assert host.booted["digest"] == manifest_digest("v2.3.1") != \
        index_digest("v2.3.1"), "the fake reports what bootc reports"


def test_preflight_accepts_the_hops_own_image_staged_by_digest(make_host):
    # A hop that starts again (a new run after an abandoned one) finds its
    # own image staged: no "already staged", nothing downloaded twice.
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, by_index_digest(STREAM_23))
    host.staged = {"version": "v2.3.1", "kubernetes": "1.35.10",
                   "image": "%s@%s" % (BOOTC_REPO, index_digest("v2.3.1")),
                   "digest": manifest_digest("v2.3.1")}

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert not commands(host, ["bootc", "switch"])
    assert finish(host)["current"] == "v2.3.1"


def test_another_release_staged_by_digest_still_blocks_the_hop(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, by_index_digest(STREAM_23))
    host.staged = {"version": "v2.4.0", "kubernetes": "1.35.10",
                   "image": "%s@%s" % (BOOTC_REPO, index_digest("v2.4.0")),
                   "digest": manifest_digest("v2.4.0")}

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "already staged" in state(host)["hold"]["reason"]


# The staged entry of `bootc status --json` on VM 953 in that HOLD (bootc
# 1.17.1): v2.3.0 staged by the digest of its index.
VM953_V230_INDEX = ("sha256:34a7ccc8f8d750c7d01dca0cf6154885670fade9e451111810d0"
                    "2830d789ca61")
VM953_V230_AMD64 = ("sha256:e16f762286e2a8e5464d4f618967f6a072999be2f4b421b4678"
                    "502f5611822f3")
VM953_V240_INDEX = ("sha256:fc557418db89932fde0ba65977069cb92831936ed992042b6194"
                    "b8b467f6ecac")
VM953_STAGED = {
    "image": {"image": {"image": BOOTC_REPO + "@" + VM953_V230_INDEX,
                        "transport": "registry"},
              "imageDigest": VM953_V230_AMD64, "version": "v2.3.0",
              "architecture": "amd64"},
}


@pytest.mark.parametrize("ref,same", [
    (BOOTC_REPO + "@" + VM953_V230_INDEX, True),     # the ref bootc keeps
    (BOOTC_REPO + "@" + VM953_V230_AMD64, True),     # its platform manifest
    (BOOTC_REPO + "@" + VM953_V240_INDEX, False),    # another release
    (BOOTC_REPO + ":v2.3.0", False),                 # the tag: another ref
])
def test_same_image_on_the_bootc_status_of_vm_953(ref, same):
    assert ku._same_image(VM953_STAGED, ref) is same


def test_same_image_by_tag_compares_the_ref():
    entry = {"image": {"image": {"image": BOOTC_REPO + ":v2.3.1"},
                       "imageDigest": manifest_digest("v2.3.1")}}
    assert ku._same_image(entry, BOOTC_REPO + ":v2.3.1")
    assert not ku._same_image(entry, BOOTC_REPO + ":v2.3.2")
    assert not ku._same_image({}, BOOTC_REPO + "@" + index_digest("v2.3.1"))


def test_run_refuses_while_an_upgrade_is_in_progress(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 2


def test_clear_hold_abandon_forgets_the_plan(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}
    run_cli(host, "run", "--to", "v2.3.1", "--yes")

    assert run_cli(host, "clear-hold", "--abandon") == 0
    st = state(host)
    assert st["phase"] == "DONE" and st["hold"] is None
    assert st["history"][-1]["result"] == "abandoned"


def test_run_without_yes_needs_a_terminal(make_host, monkeypatch):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False, raising=False)
    assert run_cli(host, "run", "--to", "v2.3.1") == 2
    assert state(host) is None


# --- preflight right after a boot --------------------------------------------
# Lab, right after the reboot into the bridge: `k4all-upgrade run` went to
# HOLD in PREFLIGHT because /readyz failed on
# poststarthook/apiservice-discovery-controller while metrics-server and
# calico-apiserver came up; a minute later /readyz was ok.
def test_preflight_waits_until_readyz_is_ok(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.readyz_failures = 2

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.readyz_calls == 3, "ok on the third try"
    assert host.sleeps == [ku.READY_POLL_SECONDS] * 2
    st = state(host)
    assert not st.get("hold") and st["phase"] == "REBOOT"
    assert commands(host, ["bootc", "switch", "--download-only"])


def test_preflight_holds_once_readyz_stays_failed_past_the_timeout(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.readyz_failures = 10 ** 6
    start = host.clock

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PREFLIGHT"
    reason = st["hold"]["reason"]
    assert reason == ("the apiserver is not ready: failed checks: "
                      "poststarthook/apiservice-discovery-controller "
                      "(still after 5 minutes)")
    waited = host.clock - start
    assert datetime.timedelta(minutes=5) <= waited < datetime.timedelta(minutes=6)
    assert set(host.sleeps) == {ku.READY_POLL_SECONDS}
    assert host.readyz_calls == len(host.sleeps) + 1
    assert not commands(host, ["bootc", "switch"])


def test_preflight_wait_follows_the_policy_file(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.CONFIG_FILE, "mode: manual\napiserverReadyTimeoutMinutes: 1\n")
    host.readyz_failures = 10 ** 6
    start = host.clock

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "(still after 1 minutes)" in state(host)["hold"]["reason"]
    assert host.clock - start < datetime.timedelta(minutes=2)


def test_preflight_waits_for_the_node_to_turn_ready(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.nodes_not_ready = 3

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.sleeps == [ku.READY_POLL_SECONDS] * 3
    assert state(host)["phase"] == "REBOOT"


def test_preflight_holds_on_a_node_that_stays_not_ready(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.nodes_not_ready = 10 ** 6

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert state(host)["hold"]["reason"] == \
        "nodes not Ready: k4all-node-1 (still after 5 minutes)"


def test_worker_preflight_does_not_wait_on_readyz(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.readyz_failures = 10 ** 6
    host.unschedulable = True

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.readyz_calls == 0 and host.sleeps == []


@pytest.mark.parametrize("proc, problem", [
    (Proc("ok"), None),
    (Proc(returncode=1, stderr=READYZ_NOT_READY),
     "failed checks: poststarthook/apiservice-discovery-controller"),
    # a real newline between the checks, two failures
    (Proc(returncode=1, stdout="[+]ping ok\n[-]etcd failed: reason withheld\n"
          "[-]poststarthook/apiservice-discovery-controller failed: reason "
          "withheld\nreadyz check failed\n"),
     "failed checks: etcd, poststarthook/apiservice-discovery-controller"),
    (Proc(returncode=1, stderr="The connection to the server 10.0.0.1:6443 "
          "was refused - did you specify the right host or port?\n"),
     "The connection to the server 10.0.0.1:6443 was refused - did you "
     "specify the right host or port?"),
    (Proc(returncode=1), "no answer (rc=1)"),
])
def test_readyz_problem_is_one_short_line(proc, problem):
    assert ku.readyz_problem(proc) == problem


def test_readyz_problem_keeps_the_end_of_a_long_answer():
    got = ku.readyz_problem(Proc(returncode=1, stderr="x" * 1000 + " the end"))
    assert len(got) == 300 and got.startswith("...") and got.endswith("the end")


# --- automatic mode --------------------------------------------------------
def test_timer_does_nothing_outside_the_window(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.clock = datetime.datetime(2026, 11, 17, 10, 0)   # Tuesday
    assert run_cli(host, "auto") == 0
    assert state(host) is None


def test_timer_runs_patches_but_not_minors(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)

    assert run_cli(host, "auto") == 0
    assert state(host)["hop"]["to"] == "v2.3.1"
    st = finish(host)
    assert st["current"] == "v2.3.1" and st["phase"] == "DONE"
    assert not [c for c in host.calls if c[-1:] == ["ghcr.io/gpillon/k4all-bootc:v2.4.0"]]


def test_timer_runs_minors_when_allowed(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23[:2])
    host.write(ku.CONFIG_FILE, "mode: auto\nautoAllow: minor\n")
    run_cli(host, "auto")
    assert finish(host)["current"] == "v2.3.0"


def test_manual_mode_ignores_the_timer(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.CONFIG_FILE, "mode: manual\n")
    run_cli(host, "auto")
    assert state(host) is None


# --- several hops and the manifest sync ---------------------------------------
NEW_MANIFEST = {
    "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
    "metadata": {"name": "k4all"},
    "spec": {"components": {
        "k4all-operator": {"type": "manifest", "version": "v0.2.0",
                           "source": "https://example/{{ version }}/install.yaml"},
        "cert-manager": {"type": "helm", "version": "v1.21.3"},
        "calico": {"type": "manifest", "version": "v3.33.1"},
    }},
}


def test_run_walks_every_hop_and_syncs_the_manifest_in_two_steps(make_host):
    host = make_host(version="v2.2.4", kubernetes="1.35.6")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = {
        "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
        "metadata": {"name": "k4all", "resourceVersion": "7"},
        "spec": {"components": {
            "k4all-operator": {"version": "v0.1.5", "source": "old"},
            "cert-manager": {"version": "v1.14.5", "custom": {"replicas": "2"}},
            "calico": {"version": "v3.27.3", "management": "Unmanaged"},
            "my-extra": {"version": "v1"},
        }}}

    assert run_cli(host, "run", "--to", "v2.4.0", "--yes") == 0
    st = finish(host)
    assert st["current"] == "v2.4.0" and st["phase"] == "DONE"
    # v2.3.1 is visited: a stream is always finished before crossing a minor
    assert [h["to"] for h in st["history"]] == ["v2.3.0", "v2.3.1", "v2.4.0"]
    assert host.reboots == 3

    # step 1: a JSON patch of the operator component alone; step 2: apply
    (kind, ops), = host.rm_patches
    assert kind == "json" and [op["path"] for op in ops] == [
        "/spec/components/k4all-operator"]
    assert ops[0]["value"]["version"] == "v0.2.0"
    second, = host.applied_manifests
    comps = second["spec"]["components"]
    assert comps["cert-manager"]["version"] == "v1.21.3"
    assert comps["cert-manager"]["custom"] == {"replicas": "2"}
    assert comps["calico"]["management"] == "Unmanaged"
    assert comps["my-extra"] == {"version": "v1"}
    assert "resourceVersion" not in second["metadata"]


# v2.6.1: a patch whose only change to the cluster is a new operator.
STREAM_26 = [
    release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
    release("v2.6.1", "patch", "v2.6.0", "1.36.6", "1.36", 45,
            syncManifest=True),
]


def test_a_patch_with_a_sync_runs_in_the_window_and_brings_the_operator(make_host):
    host = make_host(version="v2.6.0", kubernetes="1.36.6")
    write_graph(host, STREAM_26)
    image = json.loads(json.dumps(NEW_MANIFEST))
    image["spec"]["components"]["k4all-operator"]["version"] = "v0.5.1"
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(image))
    cluster = json.loads(json.dumps(image))
    cluster["metadata"]["resourceVersion"] = "9"
    comps = cluster["spec"]["components"]
    comps["k4all-operator"]["version"] = "v0.5.0"
    # uninstalled by the v2.4.0 sync, no longer in the image's manifest
    comps["ingress-nginx"] = {"type": "helm", "version": "4.15.1",
                              "management": "Removed"}
    host.release_manifest = cluster
    host.operator_running = "v0.5.0"

    # mode auto (the default), inside the Saturday window: patches run alone
    assert run_cli(host, "auto") == 0
    st = finish(host)
    assert st["current"] == "v2.6.1" and st["phase"] == "DONE"
    assert host.reboots == 1
    assert not [c for c in host.calls if c[1:3] == ["upgrade", "apply"]]
    assert host.operator_scale_history == [], "Kubernetes stays: no pause"
    (kind, ops), = host.rm_patches              # step 1: the operator alone
    assert kind == "json" and ops[0]["value"]["version"] == "v0.5.1"
    assert host.operator_running == "v0.5.1"
    assert host.applied_manifests, "step 2 applied"
    comps = host.release_manifest["spec"]["components"]
    assert comps["ingress-nginx"]["management"] == "Removed"
    assert any("ReleaseManifest sync 1/2: k4all-operator v0.5.1" in m
               for m in host.logs)


def test_sync_loads_the_shipped_images_before_applying(make_host):
    host = make_host(version="v2.3.1", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = {"metadata": {"name": "k4all"}, "spec": {
        "components": {"k4all-operator": {"version": "v0.1.5"}}}}
    host.write(ku.IMAGE_CACHE_DIR + "/docker.io_traefik_v3.7.18.tar", "")

    assert run_cli(host, "run", "--to", "v2.4.0", "--yes") == 0
    finish(host)
    calls = [c for c in host.calls if c[0] in ("podman", "kubectl")]
    load = next(i for i, c in enumerate(calls)
                if c[:2] == ["podman", "load"] and c[-1].endswith("traefik_v3.7.18.tar"))
    apply = next(i for i, c in enumerate(calls) if "apply" in c)
    assert load < apply


def test_second_sync_step_waits_for_the_new_operator_to_adopt(make_host):
    host = make_host(version="v2.3.1", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = {"metadata": {"name": "k4all"}, "spec": {
        "components": {"k4all-operator": {"version": "v0.1.5"}}}}
    host.operator_adopts = False        # an operator without appliedHash

    run_cli(host, "run", "--to", "v2.4.0", "--yes")
    st = finish(host)
    assert "k4all-operator v0.2.0 not running" in st["hold"]["reason"]
    assert len(host.rm_patches) == 1
    assert host.applied_manifests == [], "step 2 must not be applied"


# --- step 1 never removes a component ----------------------------------------
# Found by the operator's agent in envtest, then checked with kube-apiserver
# 1.33 and kubectl: a server-side apply of the operator component alone
# removed every other component. The field manager had applied them before
# (the previous sync's step 2), or kubectl had just moved to it the fields of
# the client-side `kubectl apply` that created the CR (the first sync).
CLUSTER_CR = {
    "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
    "metadata": {"name": "k4all"},
    "spec": {"components": {
        "k4all-operator": {"version": "v0.1.5", "source": "old"},
        "cert-manager": {"version": "v1.14.5", "custom": {"replicas": "2"}},
        "calico": {"version": "v3.27.3", "management": "Unmanaged"},
        "kube-vip": {"version": "latest", "management": "Unmanaged"},
        "my-extra": {"version": "v1"},
    }}}


def test_the_fake_apiserver_drops_what_an_apply_leaves_out(make_host):
    # What the old step 1 did; the model in conftest must show it.
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    host._server_side_apply("k4all-upgrade", {"spec": {"components": {
        "k4all-operator": {"version": "v0.2.0"}}}})
    assert list(host.release_manifest["spec"]["components"]) == ["k4all-operator"]


def sync_once(host, operator_version):
    manifest = json.loads(json.dumps(NEW_MANIFEST))
    manifest["spec"]["components"]["k4all-operator"]["version"] = operator_version
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(manifest))
    upgrader = ku.Upgrader(host, ku.load_config(host))
    try:
        upgrader.sync_manifest()
        return None
    except ku.UpgradeError as exc:
        return str(exc)


def kept_by_the_cluster(host):
    comps = host.release_manifest["spec"]["components"]
    return (comps["cert-manager"].get("custom"), comps["calico"].get("management"),
            comps["kube-vip"].get("management"), "my-extra" in comps)


@pytest.mark.parametrize("syncs_before", [0, 1])
def test_a_sync_stopped_after_step_1_keeps_every_component(make_host, syncs_before):
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    if syncs_before:
        assert sync_once(host, "v0.2.0") is None       # step 2 owns it all
    host.operator_adopts = False
    assert "not running" in sync_once(host, "v0.3.0")
    comps = host.release_manifest["spec"]["components"]
    assert comps["k4all-operator"]["version"] == "v0.3.0"
    assert kept_by_the_cluster(host) == ({"replicas": "2"}, "Unmanaged",
                                         "Unmanaged", True)


def test_a_sync_resumed_after_a_hold_in_step_1_keeps_custom_and_unmanaged(make_host):
    host = make_host(version="v2.3.1", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    host.operator_adopts = False
    run_cli(host, "run", "--to", "v2.4.0", "--yes")
    st = finish(host)
    assert st["phase"] == "SYNC" and "not running" in st["hold"]["reason"]

    host.operator_adopts = True
    host._refresh_status()
    host.logs.clear()
    run_cli(host, "clear-hold")
    st = finish(host)
    assert st["phase"] == "DONE" and st["current"] == "v2.4.0"
    assert any("k4all-operator v0.2.0 already in the manifest" in m
               for m in host.logs)
    assert len(host.rm_patches) == 1, "step 1 is not applied twice"
    assert kept_by_the_cluster(host) == ({"replicas": "2"}, "Unmanaged",
                                         "Unmanaged", True)
    comps = host.release_manifest["spec"]["components"]
    assert comps["cert-manager"]["version"] == "v1.21.3"


def test_a_resumed_sync_still_waits_for_the_operator(make_host):
    # The operator component is already new in the cluster, so step 1 is
    # skipped; step 2 must still wait until the new operator adopted.
    host = make_host(version="v2.3.1", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    host.operator_adopts = False
    run_cli(host, "run", "--to", "v2.4.0", "--yes")
    finish(host)
    run_cli(host, "clear-hold")
    st = finish(host)
    assert "k4all-operator v0.2.0 not running" in st["hold"]["reason"]
    assert host.applied_manifests == []


# Multi-node lab: operator v0.1.4 rewrote kube-vip.yaml with the image alone.
# The v2.4.0 sync starts a new operator on the cluster's manifest (step 1),
# so kube-vip must already be Unmanaged there.
@pytest.mark.parametrize("management", [None, "Managed"])
def test_sync_hands_kube_vip_to_the_host_before_step_1(make_host, management):
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    kube_vip = host.release_manifest["spec"]["components"]["kube-vip"]
    kube_vip.pop("management")
    if management:
        kube_vip["management"] = management
    assert sync_once(host, "v0.2.0") is None
    (kind, body), (step1, _) = host.rm_patches
    assert kind == "merge" and body == {"spec": {"components": {
        "kube-vip": {"management": "Unmanaged"}}}}
    assert step1 == "json"
    applied, = host.applied_manifests
    assert applied["spec"]["components"]["kube-vip"]["management"] == "Unmanaged"
    assert any("kube-vip: management Unmanaged" in m for m in host.logs)


@pytest.mark.parametrize("management", ["Unmanaged", "Removed", "absent"])
def test_sync_leaves_other_kube_vip_entries_alone(make_host, management):
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    comps = host.release_manifest["spec"]["components"]
    if management == "absent":
        del comps["kube-vip"]
    else:
        comps["kube-vip"]["management"] = management
    assert sync_once(host, "v0.2.0") is None
    assert [kind for kind, _ in host.rm_patches] == ["json"]


def test_an_unreadable_release_manifest_stops_the_sync(make_host):
    # A blip of the API is not "no ReleaseManifest": syncing the new
    # manifest alone would drop what only the cluster has.
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    host.apiserver_up = False
    assert "cannot read the ReleaseManifest" in sync_once(host, "v0.2.0")
    host.apiserver_up = True
    assert host.applied_manifests == [] and host.rm_patches == []


def test_a_not_found_in_an_error_message_is_still_an_error(make_host):
    # Review of 664340e: "not found" in stderr was taken for "no
    # ReleaseManifest", whatever was not found.
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    real = host._kubectl

    def broken(args, input_text, kubeconfig=""):
        if args[:2] == ["get", "releasemanifest"]:
            return Proc(returncode=1, stderr='error: the server doesn\'t have a '
                        'resource type "releasemanifest" (not found)')
        return real(args, input_text, kubeconfig)
    host._kubectl = broken
    assert "cannot read the ReleaseManifest" in sync_once(host, "v0.2.0")
    assert host.applied_manifests == [] and host.rm_patches == []


# Review: `k4all-upgrade sync-manifest` went straight to step 2 when the
# operator component was already the new one.
def test_sync_manifest_from_the_cli_waits_for_the_operator(make_host):
    host = make_host()
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    host.release_manifest["spec"]["components"]["k4all-operator"] = dict(
        NEW_MANIFEST["spec"]["components"]["k4all-operator"])
    host.operator_adopts = False
    host._refresh_status()
    host.operator_running = "v0.1.5"    # the Deployment still runs the old one
    assert run_cli(host, "sync-manifest") == 2
    assert host.applied_manifests == [] and host.rm_patches == []
    assert any("k4all-operator v0.2.0 not running" in m for m in host.logs)

    host.operator_adopts = True
    host._refresh_status()
    assert run_cli(host, "sync-manifest") == 0
    assert len(host.applied_manifests) == 1


# Review 2: with the operator Unmanaged its state is never Installed, and
# every sync went to HOLD after 45 minutes.
@pytest.mark.parametrize("where", ["cluster", "manifest"])
def test_an_unmanaged_operator_is_not_waited_for(make_host, where):
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    manifest = json.loads(json.dumps(NEW_MANIFEST))
    comp = (host.release_manifest if where == "cluster" else manifest)[
        "spec"]["components"]["k4all-operator"]
    comp["management"] = "Unmanaged"
    host._refresh_status()
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(manifest))
    started = host.clock
    upgrader = ku.Upgrader(host, ku.load_config(host))
    upgrader.sync_manifest()
    assert host.release_manifest["status"]["components"]["k4all-operator"][
        "state"] == "Unmanaged"
    assert len(host.applied_manifests) == 1
    assert host.clock - started < datetime.timedelta(minutes=1)
    assert any("k4all-operator is Unmanaged, not waited for" in m
               for m in host.logs)


def test_the_operator_must_run_the_pinned_tag(make_host):
    host = make_host()
    host.release_manifest = json.loads(json.dumps(CLUSTER_CR))
    host._refresh_status()
    upgrader = ku.Upgrader(host, ku.load_config(host))
    host.operator_running = "v0.1.5"
    assert upgrader._operator_image_is(ku.ADMIN_KUBECONFIG, "v0.1.5")
    assert not upgrader._operator_image_is(ku.ADMIN_KUBECONFIG, "v0.2.0")
    assert upgrader._operator_image_is(ku.ADMIN_KUBECONFIG, "latest")


def test_without_a_release_manifest_step_1_creates_it(make_host):
    host = make_host()
    assert sync_once(host, "v0.2.0") is None
    assert host.rm_patches == []
    first, second = host.applied_manifests
    assert list(first["spec"]["components"]) == ["k4all-operator"]
    assert set(host.release_manifest["spec"]["components"]) == {
        "k4all-operator", "cert-manager", "calico"}


def test_failed_component_after_sync_holds_without_rollback(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(NEW_MANIFEST))
    # the operator is already the new one: only the components step runs
    host.release_manifest = {"metadata": {"name": "k4all"}, "spec": {"components": {
        "k4all-operator": dict(NEW_MANIFEST["spec"]["components"]["k4all-operator"])}}}
    host.components_after_sync = "Failed"
    host._refresh_status()              # the operator runs and has adopted

    run_cli(host, "run", "--to", "v2.4.0", "--yes")
    started = host.clock
    st = finish(host)
    assert "components failed after the sync" in st["hold"]["reason"]
    assert len(host.applied_manifests) == 1
    assert st["phase"] == "SYNC"
    assert not commands(host, ["bootc", "rollback"])
    # a Failed component is retried by the operator: HOLD only at the deadline
    assert host.clock - started >= datetime.timedelta(minutes=45)


# --- pure helpers -------------------------------------------------------------
def test_operator_only_step_is_skipped_when_the_operator_does_not_change():
    cluster = {"spec": {"components": {"k4all-operator": {"version": "v0.2.0",
                                                          "source": "s"}}}}
    merged = {"apiVersion": "a", "kind": "k", "spec": {"components": {
        "k4all-operator": {"version": "v0.2.0", "source": "s"}}}}
    assert ku.operator_only_manifest(cluster, merged) is None


@pytest.mark.parametrize("status,settled,failed", [
    ({"components": {"a": {"state": "Installed", "installedVersion": "v1.0"}}},
     True, []),
    ({"components": {"a": {"state": "Installed", "installedVersion": "v0.9"}}},
     False, []),
    ({"components": {"a": {"state": "Upgrading"}}}, False, []),
    ({"components": {"a": {"state": "Failed"}}}, False, ["a"]),
    ({"components": {"a": {"state": "Installed", "installedVersion": "1.0"}},
      "conditions": [{"type": "Ready", "status": "False",
                      "reason": "UpgradeInProgress", "message": "node x"}]},
     False, []),
])
def test_components_settled(status, settled, failed):
    cr = {"spec": {"components": {"a": {"version": "v1.0"},
                                  "b": {"version": "latest", "management":
                                        "Unmanaged"}}},
          "status": status}
    got = ku.components_settled(cr)
    assert (got[0], got[1]) == (settled, failed)


def test_drop_flexvolume_handles_both_kubeadm_api_shapes():
    v1beta4 = {"controllerManager": {"extraArgs": [
        {"name": "flex-volume-plugin-dir", "value": "/x"},
        {"name": "bind-address", "value": "0.0.0.0"}]}}
    assert ku.drop_flexvolume(v1beta4)
    assert v1beta4["controllerManager"]["extraArgs"] == [
        {"name": "bind-address", "value": "0.0.0.0"}]
    v1beta3 = {"controllerManager": {"extraArgs": {"flex-volume-plugin-dir": "/x"}}}
    assert ku.drop_flexvolume(v1beta3)
    assert v1beta3["controllerManager"]["extraArgs"] == {}
    assert not ku.drop_flexvolume({"controllerManager": {}})


def test_status_reports_hold(make_host, capsys):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.staged = {"version": "v9.9.9", "kubernetes": "1.35.10",
                   "image": "quay.io/someone/else:1"}
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    out = capsys.readouterr().out
    assert "Release:   v2.3.0" in out and "HOLD:" in out


def test_status_after_a_finished_plan(make_host, capsys):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    finish(host)
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    out = capsys.readouterr().out
    assert "Release:   v2.3.1" in out
    assert "Upgrade:   none in progress (the last plan, to v2.3.1, is over)" in out
    assert "phase DONE" not in out and "Rollback:" not in out


# Lab (VM 953): after `bootc rollback` from v2.5.0 to v2.4.0, status showed
# "Release: v2.4.0" above "Upgrade: target v2.5.0, phase DONE".
def test_status_after_a_rollback_by_hand(make_host, capsys):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    finish(host)
    host.write(ku.VERSION_FILE, "v2.3.0\n")         # bootc rollback + reboot
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    out = capsys.readouterr().out
    assert "Release:   v2.3.0" in out
    assert "target v2.3.1" not in out and "phase DONE" not in out
    assert ("Rollback:  the last hop committed v2.3.1, the node runs v2.3.0 "
            "(a rollback by hand?); plan and run start from v2.3.0") in out
    capsys.readouterr()
    run_cli(host, "plan", "--to", "v2.3.1")
    assert capsys.readouterr().out.startswith("v2.3.0 -> v2.3.1")


# --- bootc under systemd ------------------------------------------------------
def test_deployment_changes_run_bootc_as_a_transient_unit():
    # Started from this tool bootc would stay in unconfined_service_t, which
    # cannot set labels a newer SELinux policy brings (F43 -> F45 failed so).
    argv = ku.via_systemd(["bootc", "switch", "--download-only", "img:v1"], 3600)
    assert argv[0] == "systemd-run"
    assert {"--wait", "--collect"} <= set(argv)
    assert "--pipe" not in argv     # refused by systemd from a service
    assert "RuntimeMaxSec=3600" in argv
    assert argv[argv.index("--"):] == ["--", "/usr/bin/bootc", "switch",
                                       "--download-only", "img:v1"]
    for sub in (["upgrade", "--from-downloaded", "--apply"], ["rollback"]):
        wrapped = ku.via_systemd(["bootc"] + sub)
        assert wrapped[0] == "systemd-run"
        assert wrapped[-len(sub):] == sub
        assert not any(a.startswith("RuntimeMaxSec") for a in wrapped)


def test_read_only_and_other_commands_run_directly():
    for argv in (["bootc", "status", "--json"], ["kubectl", "get", "nodes"],
                 ["bootc"], []):
        assert ku.via_systemd(argv) == argv


def test_a_failed_bootc_unit_reports_its_journal(monkeypatch):
    calls = []

    class Proc:
        def __init__(self, rc, out=""):
            self.returncode, self.stdout, self.stderr = rc, out, ""

    def fake_run(argv, **kwargs):
        calls.append(argv)
        if argv[0] == "journalctl":
            return Proc(0, "error: Switching: fsetxattr: Invalid argument\n")
        return Proc(1)

    monkeypatch.setattr(ku.subprocess, "run", fake_run)
    with pytest.raises(ku.UpgradeError, match="fsetxattr: Invalid argument"):
        ku.Host().run(["bootc", "switch", "--download-only", "img:v1"])
    unit = calls[0][calls[0].index("--unit") + 1]
    assert calls[1][:3] == ["journalctl", "-u", unit]

