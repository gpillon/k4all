"""A k4all patch that changes the Kubernetes patch (k4all#132).

v2.7.2 moves Kubernetes 1.36.6 -> 1.36.7: the first k4all patch whose hop
runs kubeadm before its reboot. Every check compares the full version
(k8s_key), so the patch hop runs the same steps as the minor hops that
changed Kubernetes (v2.3.0: 1.35.6 -> 1.35.10, test_driver.py):
- the bootstrap node runs `kubeadm upgrade apply v1.36.7` with the staged
  image's kubeadm; the other control planes and the workers run
  `kubeadm upgrade node`;
- a worker waits (NotYet) until the apiserver runs 1.36.7, a control plane
  until the cluster does;
- POST_BOOT checks the kubelet's full version;
- no version hook runs: they are per Kubernetes minor.
"""

import os

import pytest
import yaml

from conftest import REPO, ku, release, run_cli, write_graph

STREAM_27 = [
    release("v2.7.0", "minor", "v2.6.0", "1.36.6", "1.36", 45),
    release("v2.7.1", "patch", "v2.7.0", "1.36.6", "1.36", 45),
    release("v2.7.2", "patch", "v2.7.0", "1.36.7", "1.36", 45),
]

TARGET, CORDONED = ku.ANNOTATION_TARGET, ku.ANNOTATION_CORDONED


def state(host):
    return ku.load_state(host)


def commands(host, prefix):
    return [c for c in host.calls if c[:len(prefix)] == prefix]


def index_of(host, predicate):
    for i, call in enumerate(host.calls):
        if predicate(call):
            return i
    raise AssertionError("command not run")


def kubeadm_calls(host, verb):
    return [c for c in host.calls if c[1:3] == ["upgrade", verb]]


def reboot_at(host):
    return index_of(host, lambda c: c[:3] == ["bootc", "upgrade", "--from-downloaded"])


def finish(host, limit=10):
    for _ in range(limit):
        st = state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


def on_271(make_host, role="bootstrap", nodes=1, mode=None, version="v2.7.1"):
    host = make_host(version=version, kubernetes="1.36.6", role=role, nodes=nodes)
    write_graph(host, STREAM_27)
    if mode:
        host.write(ku.CONFIG_FILE, "mode: %s\n" % mode)
    return host


@pytest.fixture
def no_hooks(monkeypatch):
    """Every version hook, recorded instead of run."""
    ran = []
    monkeypatch.setattr(ku, "HOOKS_BEFORE_MINOR", {
        minor: [lambda upgrader, role, minor=minor: ran.append(minor)]
        for minor in ku.HOOKS_BEFORE_MINOR})
    return ran


# --- the graph ----------------------------------------------------------------
def test_a_kubernetes_patch_inside_a_k4all_patch_is_a_valid_step():
    releases = ku.load_graph(STREAM_27)
    assert ku.validate_graph(releases) == []
    assert ku._validate_step(releases[1], releases[2]) == []
    assert [r.version for r in ku.plan_path(releases, "v2.7.0")] == ["v2.7.2"], \
        "v2.7.0 hops straight to the latest patch"


def test_a_patch_that_changes_the_kubernetes_minor_is_still_refused():
    releases = ku.load_graph(STREAM_27[:2] + [
        release("v2.7.2", "patch", "v2.7.0", "1.37.1", "1.36", 45)])
    assert any("a patch cannot change Kubernetes minor" in e
               for e in ku.validate_graph(releases))


def test_the_repo_graph_moves_v2_7_2_to_kubernetes_1_36_7():
    with open(os.path.join(REPO, "bootc", "upgrade", "releases.yaml"),
              encoding="utf-8") as fh:
        releases = ku.load_graph(yaml.safe_load(fh))
    by_version = {r.version: r for r in releases}
    prev, rel = by_version["v2.7.1"], by_version["v2.7.2"]
    assert rel.kind == "patch" and rel.kubernetes == "1.36.7"
    assert prev.kubernetes == "1.36.6"
    assert ku._validate_step(prev, rel) == []


# --- the bootstrap node: kubeadm upgrade apply ---------------------------------
@pytest.mark.parametrize("start", ["v2.7.0", "v2.7.1"])
def test_the_bootstrap_runs_kubeadm_upgrade_apply_before_its_reboot(
        make_host, no_hooks, start):
    host = on_271(make_host, version=start)

    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 0
    apply, = kubeadm_calls(host, "apply")
    assert apply[0].endswith("/var/lib/k4all/upgrade/bin/kubeadm-1.36.7"), \
        "kubeadm comes from the staged image"
    assert apply[3:] == ["v1.36.7", "--yes"]
    assert host.calls.index(apply) < reboot_at(host)
    assert host.apiserver == "1.36.7", "before the reboot"
    # no image cache in the staged deployment here: kubeadm pulls them
    assert commands(host, [apply[0], "config", "images", "pull",
                           "--kubernetes-version", "v1.36.7"])
    assert no_hooks == [], "the version hooks are per minor"
    assert host.operator_scale_history == [0], \
        "a hop by hand pauses an operator older than the pause gate"

    st = finish(host)
    assert st["current"] == "v2.7.2" and not st.get("hold")
    assert host.booted["kubernetes"] == "1.36.7"
    assert host.operator_scale_history == [0, 1]
    logs = os.listdir(host.path(ku.STATE_DIR + "/logs"))
    assert any(name.startswith("kubeadm-") for name in logs), \
        "the kubeadm output is kept"


def test_a_bootstrap_whose_control_plane_already_runs_1_36_7_skips_the_apply(
        make_host):
    # a PRE_REBOOT run again after kubeadm went through
    host = on_271(make_host)
    host.cluster_config["kubernetesVersion"] = "v1.36.7"
    host.apiserver = host.cluster_version = "1.36.7"
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 0
    assert not kubeadm_calls(host, "apply")
    assert "control plane already at 1.36.7" in host.logs


# --- the other nodes: kubeadm upgrade node --------------------------------------
def bootstrap_node(release, kubelet):
    return {"metadata": {"name": "kube-bootstrap-1", "annotations": {
        ku.ANNOTATION_RELEASE: release, ku.ANNOTATION_NODE_TYPE: "bootstrap"}},
        "status": {"nodeInfo": {"kubeletVersion": kubelet},
                   "conditions": [{"type": "Ready", "status": "True"}]}}


def control_plane(make_host, bootstrap_done):
    host = on_271(make_host, role="control", nodes=3)
    if bootstrap_done:
        host.apiserver = host.cluster_version = "1.36.7"
        host.cluster_config["kubernetesVersion"] = "v1.36.7"
        host.extra_nodes = [bootstrap_node("v2.7.2", "v1.36.7")]
    else:
        host.extra_nodes = [bootstrap_node("v2.7.1", "v1.36.6")]
    return host


def test_a_control_plane_waits_until_the_cluster_runs_1_36_7(make_host):
    host = control_plane(make_host, bootstrap_done=False)
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 3
    assert state(host) is None, "not yet: no plan, no HOLD"
    assert ("not yet: the cluster is at 1.36.6; run the upgrade on the "
            "bootstrap node first") in host.logs
    assert not commands(host, ["bootc", "switch"])


def test_a_control_plane_runs_kubeadm_upgrade_node(make_host, no_hooks):
    host = control_plane(make_host, bootstrap_done=True)
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 0
    assert not kubeadm_calls(host, "apply")
    node, = kubeadm_calls(host, "node")
    assert node[0].endswith("/kubeadm-1.36.7") and node[3:] == []
    assert host.calls.index(node) < reboot_at(host)
    assert commands(host, [node[0], "config", "images", "pull",
                           "--kubernetes-version", "v1.36.7"]), \
        "a control plane runs the control-plane images too"
    assert no_hooks == []
    assert finish(host)["current"] == "v2.7.2"


def worker(make_host, apiserver, cordoned=True):
    host = on_271(make_host, role="worker", nodes=3)
    host.apiserver = apiserver
    host.unschedulable = cordoned       # drained from a control plane
    return host


def test_a_worker_waits_until_the_apiserver_runs_1_36_7(make_host):
    host = worker(make_host, "1.36.6")
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 3
    assert state(host) is None
    assert ("not yet: the apiserver is at 1.36.6; upgrade the control plane "
            "to 1.36.7 first") in host.logs
    assert not commands(host, ["bootc", "switch"])


def test_a_worker_runs_kubeadm_upgrade_node_once_the_apiserver_is_ahead(make_host):
    host = worker(make_host, "1.36.7")
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 0
    node, = kubeadm_calls(host, "node")
    assert node[0].endswith("/kubeadm-1.36.7")
    assert host.calls.index(node) < reboot_at(host)
    assert not commands(host, [node[0], "config", "images"]), \
        "a worker runs no control-plane image"
    assert finish(host)["current"] == "v2.7.2"
    assert host.booted["kubernetes"] == "1.36.7"


# --- the hop the k4all-operator asks for ----------------------------------------
def test_the_agent_runs_the_apply_on_the_bootstrap_without_pausing_the_operator(
        make_host):
    host = on_271(make_host, nodes=3, mode="managed")
    host.annotations[TARGET] = "v2.7.2"
    assert run_cli(host, "agent") == 0
    apply, = kubeadm_calls(host, "apply")
    assert apply[3] == "v1.36.7"
    assert host.operator_scale_history == [], \
        "an operator that writes upgrade-target knows the pause gate"
    assert host.annotations[ku.ANNOTATION_IN_PROGRESS] == "v2.7.1->v2.7.2"
    assert finish(host)["current"] == "v2.7.2"
    assert host.annotations[ku.ANNOTATION_DONE] == "v2.7.2"
    assert host.operator_scale_history == []


def test_the_agent_on_a_worker_waits_for_the_apiserver_then_runs_upgrade_node(
        make_host):
    host = worker(make_host, "1.36.6", cordoned=False)
    host.write(ku.CONFIG_FILE, "mode: managed\n")
    host.annotations[CORDONED] = "true"
    host.annotations[TARGET] = "v2.7.2"
    assert run_cli(host, "agent") == 0
    st = state(host)
    assert st["phase"] == "PREFLIGHT" and st["hold"] is None
    assert st["waiting"].startswith("the apiserver is at 1.36.6")
    assert not kubeadm_calls(host, "node")

    host.apiserver = "1.36.7"           # the bootstrap's hop went through
    assert run_cli(host, "agent") == 0
    assert kubeadm_calls(host, "node")
    assert host.operator_scale_history == []
    assert finish(host)["current"] == "v2.7.2"
    assert host.annotations[ku.ANNOTATION_DONE] == "v2.7.2"


# --- POST_BOOT: the kubelet's full version ---------------------------------------
def test_post_boot_wants_kubelet_1_36_7_not_only_the_minor(make_host):
    host = on_271(make_host)
    assert run_cli(host, "run", "--to", "v2.7.2", "--yes") == 0
    assert host.booted["version"] == "v2.7.2"
    host.booted["kubernetes"] = "1.36.6"    # an image whose kubelet stayed behind
    run_cli(host, "resume")
    st = state(host)
    assert st["phase"] == "ROLLBACK_REBOOT"
    assert "kubelet is 1.36.6, expected 1.36.7" in st["rollbackReason"]
    assert commands(host, ["bootc", "rollback"])
