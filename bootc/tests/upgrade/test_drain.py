"""The drain of a hop, as k4all-upgrade runs it.

- #86: the node being drained carries `k4all.magesgate.com/draining=true`
  from the cordon to the uncordon, so the k4all-operator, which tolerates the
  cordon, prefers any other node when its pod is evicted.
- #87: a PodDisruptionBudget that allows no disruption although its pods are
  healthy (the primary of a single-instance CloudNativePG cluster) refuses
  every eviction: the hop stops in HOLD before STAGE and names it, instead of
  a drain that never ends.
- #99: a pod that declares no controller (`kubectl run`, a `kubectl debug
  node/...` pod left running) makes `kubectl drain` without --force refuse
  the whole drain. Up to v2.6.6 a control plane found out at DRAIN, after
  STAGE and PRE_REBOOT, cordoned: now the hop stops in HOLD before STAGE and
  names the pods. A worker names them while it waits for its drain.
"""

import pytest

from conftest import ku, release, run_cli, write_graph

DRAINING = "k4all.magesgate.com/draining"

STREAM_23 = [
    release("v2.2.4", "patch", "v2.0.0-beta1", "1.35.6", "1.32", 43),
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 43),
]

GRAPH = STREAM_23 + [
    release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
            syncManifest=True),
    release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
    release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
]

CNPG_PRIMARY = {"cnpg.io/cluster": "kubone-pg", "cnpg.io/instanceRole": "primary"}


def state(host):
    return ku.load_state(host)


def kubectl_calls(host, verb):
    return [c for c in host.calls if c[:1] == ["kubectl"] and c[3:4] == [verb]]


def index_of(host, predicate):
    for i, call in enumerate(host.calls):
        if predicate(call):
            return i
    raise AssertionError("command not run")


def finish(host, limit=10):
    for _ in range(limit):
        st = state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


def control_plane(make_host):
    """A control plane with admin.conf in a two-node cluster: it drains
    itself."""
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="control")
    host.node_count = 2
    write_graph(host, STREAM_23)
    return host


def pdb(name="kubone-pg-primary", namespace="kubone-data", selector=None,
        allowed=0, healthy=1, desired=1, expected=1, generation=1, observed=1):
    """A PodDisruptionBudget as the disruption controller reports it; by
    default CNPG's primary budget of a single-instance cluster."""
    return {"metadata": {"namespace": namespace, "name": name,
                         "generation": generation},
            "spec": {"minAvailable": 1,
                     "selector": {"matchLabels": dict(CNPG_PRIMARY)}
                     if selector is None else selector},
            "status": {"observedGeneration": observed,
                       "disruptionsAllowed": allowed, "currentHealthy": healthy,
                       "desiredHealthy": desired, "expectedPods": expected}}


def pod(name="kubone-pg-1", node="k4all-node-1", namespace="kubone-data",
        labels=None, phase="Running", owner="Cluster", terminating=False,
        mirror=False, ready=True, controller=True):
    """A pod; by default the primary of a CNPG cluster, its controller."""
    meta = {"namespace": namespace, "name": name,
            "labels": dict(CNPG_PRIMARY) if labels is None else labels}
    if owner:
        meta["ownerReferences"] = [{"apiVersion": "apps/v1", "kind": owner,
                                    "name": "x", "uid": "u",
                                    "controller": controller}]
    if terminating:
        meta["deletionTimestamp"] = "2026-11-21T02:40:00Z"
    if mirror:
        meta["annotations"] = {"kubernetes.io/config.mirror": "abc"}
    return {"metadata": meta, "spec": {"nodeName": node},
            "status": {"phase": phase, "conditions": [
                {"type": "Ready", "status": "True" if ready else "False"}]}}


def replica(name="kubone-pg-2", node="k4all-node-2", **kwargs):
    """A CNPG replica of kubone-pg."""
    return pod(name, node=node, labels={"cnpg.io/cluster": "kubone-pg",
                                        "cnpg.io/instanceRole": "replica"},
               **kwargs)


# --- #86: the draining label -------------------------------------------------
def test_a_control_plane_labels_the_node_it_drains_until_the_uncordon(make_host):
    host = control_plane(make_host)

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    label_at = index_of(host, lambda c: c[3:5] == ["label", "node"]
                        and DRAINING + "=true" in c)
    drain_at = index_of(host, lambda c: c[3:4] == ["drain"])
    assert label_at < drain_at, "labelled before the drain evicts anything"
    assert host.unschedulable and host.labels.get(DRAINING) == "true", \
        "cordoned and labelled through the reboot"

    assert finish(host)["current"] == "v2.3.1"
    assert not host.unschedulable
    assert DRAINING not in host.labels, "removed with the uncordon"
    unlabel_at = index_of(host, lambda c: c[3:5] == ["label", "node"]
                          and DRAINING + "-" in c)
    uncordon_at = index_of(host, lambda c: c[3:4] == ["uncordon"])
    assert abs(unlabel_at - uncordon_at) == 1, "together with the uncordon"


def test_a_lone_bootstrap_node_is_neither_drained_nor_labelled(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    finish(host)
    assert not kubectl_calls(host, "drain") and not kubectl_calls(host, "label")
    assert host.labels == {}


def test_a_worker_says_to_label_the_node_with_its_drain(make_host):
    # kubelet.conf may not cordon its own Node: whoever drains it from a
    # control plane sets the label, and removes it with the uncordon.
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    reason = [m for m in host.logs if m.startswith("not yet: ")][0]
    assert "`kubectl label node k4all-node-1 %s=true`" % DRAINING in reason
    assert "kubectl drain k4all-node-1 --ignore-daemonsets " \
           "--delete-emptydir-data" in reason
    assert "kubectl uncordon k4all-node-1" in reason
    assert "kubectl label node k4all-node-1 %s-" % DRAINING in reason
    assert not kubectl_calls(host, "label")


def test_a_worker_drained_from_outside_reminds_to_remove_the_label(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.unschedulable = True
    host.labels[DRAINING] = "true"      # set by the admin with the drain

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert finish(host)["current"] == "v2.3.1"
    assert host.labels == {DRAINING: "true"}, "the admin's, like the cordon"
    assert not kubectl_calls(host, "label")
    assert any("Node k4all-node-1 is still cordoned" in m
               and "kubectl label node k4all-node-1 %s-" % DRAINING in m
               for m in host.logs)


# --- #87: budgets that never let a pod go ---------------------------------
def test_a_budget_that_allows_no_disruption_holds_the_hop_before_stage(make_host):
    host = control_plane(make_host)
    host.pdbs = [pdb()]
    host.pods = [pod()]

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PREFLIGHT"
    reason = st["hold"]["reason"]
    assert "the drain of k4all-node-1 would never end" in reason
    assert "PDB kubone-data/kubone-pg-primary allows no disruption of " \
           "pod kubone-data/kubone-pg-1" in reason
    assert "CloudNativePG" in reason and "docs/upgrades.md" in reason
    assert host.annotations[ku.ANNOTATION_PHASE] == "HOLD"
    assert "kubone-data/kubone-pg-primary" in host.annotations[ku.ANNOTATION_MESSAGE]
    # Nothing changed: nothing backed up, staged, cordoned or labelled.
    assert not [c for c in host.calls if c[0].endswith("k4all-backup.sh")]
    assert not [c for c in host.calls if c[:2] == ["bootc", "switch"]]
    assert not kubectl_calls(host, "drain") and not kubectl_calls(host, "label")
    assert not host.unschedulable and host.operator_replicas == 1
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations

    # The admin lets the database go for the hop (CNPG removes the budget).
    host.pdbs = []
    assert run_cli(host, "clear-hold") == 0
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "REBOOT"
    assert kubectl_calls(host, "drain")


def test_the_hold_names_every_budget_that_blocks(make_host):
    host = control_plane(make_host)
    host.pdbs = [pdb(), pdb("web", namespace="shop",
                            selector={"matchLabels": {"app": "web"}})]
    host.pods = [pod(), pod("web-0", namespace="shop", labels={"app": "web"})]

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    reason = state(host)["hold"]["reason"]
    assert "PDB kubone-data/kubone-pg-primary allows no disruption of pod " \
           "kubone-data/kubone-pg-1" in reason
    assert "PDB shop/web allows no disruption of pod shop/web-0" in reason


def test_a_bootstrap_node_with_other_nodes_checks_its_budgets(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", nodes=2)
    write_graph(host, STREAM_23)
    host.pdbs, host.pods = [pdb()], [pod()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "kubone-data/kubone-pg-primary" in state(host)["hold"]["reason"]


@pytest.mark.parametrize("budget,on_node", [
    # pods the drain does not evict, or evicts whatever the budget says
    (pdb(), pod(owner="DaemonSet")),
    (pdb(), pod(terminating=True)),
    (pdb(), pod(mirror=True)),
    (pdb(), pod(phase="Pending")),
    (pdb(), pod(phase="Succeeded")),
    # the budget's pods are on other nodes, or it selects none here
    (pdb(), pod(node="k4all-node-2")),
    (pdb(), pod(namespace="other")),
    (pdb(), pod(labels={"cnpg.io/cluster": "kubone-pg",
                        "cnpg.io/instanceRole": "replica"})),
    (pdb(selector={"matchExpressions": [{"key": "app", "operator": "Exists"}]}),
     pod()),
    # budgets that let it go, or will once their pods are back
    (pdb(allowed=1, expected=2, healthy=2), pod()),
    (pdb(healthy=0), pod()),
    (pdb(observed=0), pod()),
], ids=["daemonset", "terminating", "mirror", "pending", "succeeded",
        "other-node", "other-namespace", "not-selected", "selector-misses",
        "allows-one", "pods-starting", "not-observed-yet"])
def test_what_does_not_block_the_drain(make_host, budget, on_node):
    host = control_plane(make_host)
    host.pdbs, host.pods = [budget], [on_node]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"


# CNPG switches a primary over to a replica when its node is cordoned (CNPG
# docs, Kubernetes upgrade): with a ready replica on another node the drain
# ends, although the primary budget allows no disruption.
def test_a_cnpg_primary_with_a_replica_elsewhere_does_not_block(make_host):
    host = control_plane(make_host)
    host.pdbs = [pdb()]
    host.pods = [pod(), replica()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"


@pytest.mark.parametrize("other", [
    replica(node="k4all-node-1"),       # on the same node: no switchover off it
    replica(ready=False),               # not ready to take over
    replica(terminating=True),
    replica(namespace="other"),         # another cluster of the same name
], ids=["same-node", "not-ready", "terminating", "other-namespace"])
def test_a_cnpg_primary_without_a_replica_to_take_over_blocks(make_host, other):
    host = control_plane(make_host)
    host.pdbs = [pdb()]
    host.pods = [pod(), other]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "PDB kubone-data/kubone-pg-primary" in state(host)["hold"]["reason"]


def test_a_lone_bootstrap_node_does_not_check_budgets(make_host):
    # Not drained: a single-node cluster keeps working as before.
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.pdbs, host.pods = [pdb()], [pod()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert not [c for c in host.calls if "poddisruptionbudgets" in c]


def test_a_worker_does_not_check_budgets(make_host):
    # kubelet.conf may not read them; whoever drains it sees the drain hang.
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.unschedulable = True
    host.pdbs, host.pods = [pdb()], [pod()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert not [c for c in host.calls if "poddisruptionbudgets" in c]


def test_an_operator_hop_does_not_check_budgets(make_host):
    # The k4all-operator checked them before its cordon, and drained the node.
    host = make_host(version="v2.5.0", kubernetes="1.35.10", nodes=3)
    write_graph(host, GRAPH)
    host.pdbs, host.pods = [pdb()], [pod()]
    host.annotations[ku.ANNOTATION_TARGET] = "v2.6.0"
    assert run_cli(host, "agent") == 0
    assert not state(host).get("hold")
    assert not [c for c in host.calls if "poddisruptionbudgets" in c]


def test_budgets_that_cannot_be_read_do_not_hold_the_hop(make_host):
    host = control_plane(make_host)
    host.pdbs = None                    # the list fails
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert any(m.startswith("WARNING: cannot check the PodDisruptionBudgets")
               for m in host.logs)


@pytest.mark.parametrize("selector,labels,selected", [
    ({}, {"a": "1"}, True),             # policy/v1: empty selects every pod
    (None, {"a": "1"}, False),          # ...and none selects none
    ({"matchLabels": {"a": "1"}}, {"a": "1", "b": "2"}, True),
    ({"matchLabels": {"a": "1"}}, {"a": "2"}, False),
    ({"matchLabels": {"a": "1"}}, None, False),
    ({"matchExpressions": [{"key": "a", "operator": "In", "values": ["1", "2"]}]},
     {"a": "2"}, True),
    ({"matchExpressions": [{"key": "a", "operator": "In", "values": ["1"]}]},
     {}, False),
    ({"matchExpressions": [{"key": "a", "operator": "NotIn", "values": ["1"]}]},
     {}, True),
    ({"matchExpressions": [{"key": "a", "operator": "NotIn", "values": ["1"]}]},
     {"a": "1"}, False),
    ({"matchExpressions": [{"key": "a", "operator": "Exists"}]}, {"a": ""}, True),
    ({"matchExpressions": [{"key": "a", "operator": "DoesNotExist"}]},
     {"a": ""}, False),
    ({"matchLabels": {"a": "1"},
      "matchExpressions": [{"key": "b", "operator": "Exists"}]}, {"a": "1"}, False),
    ({"matchExpressions": [{"key": "a", "operator": "Gt", "values": ["1"]}]},
     {"a": "2"}, False),
])
def test_selector_matches(selector, labels, selected):
    assert ku.selector_matches(selector, labels) is selected


# --- #99: pods that declare no controller ------------------------------------
def bare(name="debug-x", namespace="default", **kwargs):
    """A pod nothing recreates: `kubectl run debug-x --image=...`."""
    return pod(name, namespace=namespace, labels={"run": name}, owner=None,
               **kwargs)


def test_a_bare_pod_holds_the_hop_of_a_control_plane_before_stage(make_host):
    host = control_plane(make_host)
    host.pods = [bare(), pod("web-7c9d-x", namespace="shop", owner="ReplicaSet")]

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    st = state(host)
    assert st["phase"] == "PREFLIGHT"
    reason = st["hold"]["reason"]
    assert reason.startswith("the drain of k4all-node-1 would refuse the pods "
                             "that declare no controller: default/debug-x. ")
    assert "web-7c9d-x" not in reason
    assert "Nothing recreates such a pod" in reason
    assert "Delete them" in reason and "docs/upgrades.md" in reason
    assert host.annotations[ku.ANNOTATION_PHASE] == "HOLD"
    assert "default/debug-x" in host.annotations[ku.ANNOTATION_MESSAGE]
    # Nothing changed: nothing backed up, staged, cordoned or labelled.
    assert not [c for c in host.calls if c[0].endswith("k4all-backup.sh")]
    assert not [c for c in host.calls if c[:2] == ["bootc", "switch"]]
    assert not kubectl_calls(host, "drain") and not kubectl_calls(host, "label")
    assert not host.unschedulable and host.operator_replicas == 1
    assert ku.ANNOTATION_IN_PROGRESS not in host.annotations

    # The admin deletes the pod; the hop goes on and drains the node.
    host.pods = host.pods[1:]
    assert run_cli(host, "clear-hold") == 0
    assert run_cli(host, "resume") == 0
    assert state(host)["phase"] == "REBOOT"
    assert kubectl_calls(host, "drain")


def test_the_hold_names_three_bare_pods_and_counts_the_rest(make_host):
    host = control_plane(make_host)
    host.pods = [bare("p%d" % i) for i in range(5)]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "declare no controller: default/p0, default/p1, default/p2 and 2 " \
           "more. " in state(host)["hold"]["reason"]


def test_an_owner_that_is_not_a_controller_does_not_count(make_host):
    # kubectl drain looks for the controller reference (metav1.GetControllerOf)
    host = control_plane(make_host)
    host.pods = [pod("adopted", namespace="default", owner="ConfigMap",
                     controller=False)]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "default/adopted" in state(host)["hold"]["reason"]


@pytest.mark.parametrize("on_node", [
    pod(owner="ReplicaSet"),
    pod(owner="Job"),
    pod(owner="DaemonSet"),
    bare(mirror=True),                  # a static pod's mirror
    bare(phase="Succeeded"),            # finished: the drain deletes it
    bare(phase="Failed"),
    bare(terminating=True),             # going already
    bare(node="k4all-node-2"),
], ids=["replicaset", "job", "daemonset", "mirror", "succeeded", "failed",
        "terminating", "other-node"])
def test_what_is_not_a_bare_pod(make_host, on_node):
    host = control_plane(make_host)
    host.pods = [on_node]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"


def test_a_budget_that_blocks_comes_first(make_host):
    host = control_plane(make_host)
    host.pdbs, host.pods = [pdb()], [pod(), bare()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    reason = state(host)["hold"]["reason"]
    assert "PDB kubone-data/kubone-pg-primary" in reason
    assert "also refuse the pods that declare no controller: default/debug-x" \
        in reason


def test_a_bootstrap_node_with_other_nodes_checks_its_bare_pods(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", nodes=2)
    write_graph(host, STREAM_23)
    host.pods = [bare()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 1
    assert "default/debug-x" in state(host)["hold"]["reason"]


def test_a_lone_bootstrap_node_keeps_its_bare_pods(make_host):
    # Not drained: kubelet starts the pod again after the reboot.
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.pods = [bare()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"


def test_a_worker_names_its_bare_pods_while_it_waits_for_its_drain(make_host):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.pods = [bare()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    reason = [m for m in host.logs if m.startswith("not yet: ")][0]
    assert reason.startswith(
        "not yet: Node k4all-node-1 runs pods that declare no controller: "
        "default/debug-x. Its drain refuses them")
    assert "kubectl drain k4all-node-1 --ignore-daemonsets" in reason


def test_a_worker_drained_from_outside_goes_on(make_host):
    # Cordoned by whoever drains it: kubelet starts a pod that stayed
    # again after the reboot.
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="worker")
    write_graph(host, STREAM_23)
    host.unschedulable = True
    host.pods = [bare()]
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"


def test_an_operator_hop_does_not_check_bare_pods(make_host):
    # The k4all-operator (v0.5.8 on) checked them before its cordon.
    host = make_host(version="v2.5.0", kubernetes="1.35.10", nodes=3)
    write_graph(host, GRAPH)
    host.pods = [bare()]
    host.annotations[ku.ANNOTATION_TARGET] = "v2.6.0"
    assert run_cli(host, "agent") == 0
    assert not state(host).get("hold")


def test_pods_that_cannot_be_read_do_not_hold_the_hop(make_host):
    host = control_plane(make_host)
    host.pods = None                    # the list fails
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert state(host)["phase"] == "REBOOT"
    assert any(m.startswith("cannot check the pods that declare no controller "
                            "on k4all-node-1") for m in host.logs)


@pytest.mark.parametrize("item,is_bare", [
    (bare(), True),
    (bare(phase="Pending"), True),      # bound and starting: still deleted
    (pod(owner="ReplicaSet"), False),
    (pod(owner="ConfigMap", controller=False), True),
    (bare(mirror=True), False),
    (bare(phase="Succeeded"), False),
    (bare(terminating=True), False),
])
def test_declares_no_controller(item, is_bare):
    assert ku.declares_no_controller(item) is is_bare
