"""Cilium during a hop, on clusters with the OVS bridge.

Cilium 1.20 skips the OVS bridge in its device detection: after the hop's
reboot, the agent of a cluster synced by an older k4all-operator cannot start
on a node whose IP is on ovs-bridge. POST_BOOT writes the keys k4all-operator
v0.5.3 renders and restarts the node's agent; after the sync the bootstrap
restarts its agent (and Multus) when cilium-config changed.
"""

import json

import pytest

from conftest import FakeHost, Proc, ku


class CiliumHost(FakeHost):
    """FakeHost with cilium-config and the DaemonSet pods of this node."""

    def __init__(self, root, management="Managed", cilium=True, bridge=True, **kw):
        super().__init__(root, **kw)
        self.cilium_data = {"kube-proxy-replacement": "true", "devices": ""} if cilium else None
        self.cm_patches = []
        self.deleted = []           # label selectors of `delete pod`
        self.api_answers = True     # cilium-config readable
        self.release_manifest = {"spec": {"components": {
            "cilium": {"type": "helm", "management": management, "version": "1.20.4"}}}}
        if bridge:
            self.write(ku.OVS_BRIDGE_SYSFS + "/type", "1\n")

    def _kubectl(self, args, input_text, kubeconfig=""):
        if args[:5] == ["-n", "kube-system", "get", "configmap", "cilium-config"]:
            if not self.api_answers:
                return Proc(returncode=1, stderr="The connection to the server was refused")
            if self.cilium_data is None:
                return Proc(returncode=1, stderr='Error from server (NotFound): '
                            'configmaps "cilium-config" not found')
            return Proc(json.dumps({"data": dict(self.cilium_data)}))
        if args[:5] == ["-n", "kube-system", "patch", "configmap", "cilium-config"]:
            body = json.loads(args[args.index("-p") + 1])
            self.cm_patches.append(body)
            self.cilium_data.update(body["data"])
            return Proc()
        if args[:4] == ["-n", "kube-system", "delete", "pod"]:
            assert "spec.nodeName=" + self.node_name() in args
            self.deleted.append(args[args.index("-l") + 1])
            return Proc()
        return super()._kubectl(args, input_text, kubeconfig)


def upgrader(host):
    return ku.Upgrader(host, ku.load_config(host))


@pytest.fixture
def make(tmp_path):
    def factory(**kw):
        return CiliumHost(tmp_path / "root", **kw)
    return factory


def test_the_bootstrap_names_ovs_bridge_and_restarts_its_agent(make):
    host = make()
    hop = {}
    upgrader(host)._cilium_devices_in_hop(hop)
    assert host.cm_patches == [{"data": {"devices": "ovs-bridge",
                                         "force-device-detection": "true"}}]
    assert host.deleted == ["k8s-app=cilium"]
    assert hop["ciliumDevices"] == "patched"


def test_devices_already_listed_are_kept_after_ovs_bridge(make):
    host = make()
    host.cilium_data["devices"] = "eth1"
    upgrader(host)._cilium_devices_in_hop({})
    assert host.cm_patches[0]["data"]["devices"] == "ovs-bridge eth1"


def test_nothing_to_do_when_ovs_bridge_is_named(make):
    host = make()
    host.cilium_data["devices"] = "ovs-bridge"
    hop = {}
    upgrader(host)._cilium_devices_in_hop(hop)
    assert host.cm_patches == [] and host.deleted == []
    assert hop["ciliumDevices"] == "skip"


@pytest.mark.parametrize("kw", [{"management": "Unmanaged"}, {"cilium": False},
                                {"bridge": False}, {"role": "worker"}])
def test_left_alone(make, kw):
    """Unmanaged Cilium (the admin's, 1.19 on restored clusters), no Cilium,
    no OVS bridge, a worker (no rights on cilium-config)."""
    host = make(**kw)
    hop = {}
    upgrader(host)._cilium_devices_in_hop(hop)
    assert host.cm_patches == [] and host.deleted == []
    assert hop["ciliumDevices"] == "skip"


def test_retried_until_the_api_answers(make):
    host = make()
    host.api_answers = False
    hop = {}
    up = upgrader(host)
    up._cilium_devices_in_hop(hop)
    assert "ciliumDevices" not in hop and host.cm_patches == []
    host.api_answers = True
    up._cilium_devices_in_hop(hop)
    assert hop["ciliumDevices"] == "patched"
    up._cilium_devices_in_hop(hop)
    assert len(host.cm_patches) == 1, "once per hop"


def test_post_boot_fixes_cilium_before_the_health_check(make, monkeypatch):
    host = make()
    up = upgrader(host)
    order = []
    monkeypatch.setattr(up, "_cilium_devices_in_hop", lambda hop: order.append("cilium"))
    monkeypatch.setattr(up, "_node_healthy", lambda hop: (order.append("health"), (True, ""))[1])
    monkeypatch.setattr(up, "_kube_vip_in_hop", lambda hop, wait: None)
    host.write(ku.VERSION_FILE, "v2.6.4\n")
    up.post_boot({"hop": {"from": "v2.6.3", "to": "v2.6.4", "kubernetes": "1.35.6"}})
    assert order[:2] == ["cilium", "health"]


def test_after_the_sync_a_changed_config_restarts_cilium_then_multus(make):
    host = make()
    before = {"devices": "ovs-bridge"}
    host.cilium_data = {"devices": "ovs-bridge", "bpf-lb-sock-hostns-only": "true"}
    upgrader(host)._cilium_after_sync(before)
    assert host.deleted == ["k8s-app=cilium", "name=multus"]


@pytest.mark.parametrize("before,data", [
    ({"devices": "ovs-bridge"}, {"devices": "ovs-bridge"}),   # unchanged
    (None, {"devices": "ovs-bridge"}),                         # unreadable before
    ({"devices": ""}, None),                                   # no Cilium
])
def test_after_the_sync_nothing_restarts(make, before, data):
    host = make(cilium=data is not None)
    if data is not None:
        host.cilium_data = data
    upgrader(host)._cilium_after_sync(before)
    assert host.deleted == []


def test_after_the_sync_unmanaged_cilium_is_not_restarted(make):
    host = make(management="Unmanaged")
    host.cilium_data = {"devices": "x"}
    upgrader(host)._cilium_after_sync({"devices": ""})
    assert host.deleted == []


def test_the_sync_phase_restarts_cilium_when_the_operator_changed_it(make, monkeypatch):
    host = make()
    up = upgrader(host)
    monkeypatch.setattr(up, "resume_operator_or_fail", lambda hop: None)

    def sync_manifest(state=None):
        host.cilium_data["cni-exclusive"] = "false"
    monkeypatch.setattr(up, "sync_manifest", sync_manifest)
    up.sync({"hop": {"syncManifest": True}})
    assert host.deleted == ["k8s-app=cilium", "name=multus"]
