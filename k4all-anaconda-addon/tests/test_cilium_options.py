# =============================================================================
# Cilium installer options -> ClusterConfig spec.networking.cni.cilium
# =============================================================================
# The operator reads these typed fields and turns them into Cilium Helm values;
# componentOverrides.cilium.values is passed to Helm as-is, so the installer
# must not put its options there.

import pytest


def _make_service():
    from com_k4all_installer.service.k4all import K4All
    return K4All()


def _cilium(svc):
    return svc.config["networking"]["cni"]["cilium"]


@pytest.mark.parametrize("setter, field", [
    ("set_cilium_l2_announcements", "l2announcements"),
    ("set_cilium_hubble", "hubble"),
])
def test_cilium_switch_lands_in_networking_cni_cilium(setter, field):
    svc = _make_service()
    getattr(svc, setter)(True)
    assert _cilium(svc)[field] is True
    assert "cilium" not in svc.config.get("componentOverrides", {})


def test_gateway_api_uses_operator_field_name():
    svc = _make_service()
    svc.set_cilium_gateway_api(True)
    assert _cilium(svc) == {"gatewayAPI": True}
    assert svc.cilium_gateway_api is True


def test_additional_devices_text_becomes_a_list():
    svc = _make_service()
    svc.set_cilium_additional_devices("eth1, eth2,,")
    assert _cilium(svc)["additionalDevices"] == ["eth1", "eth2"]
    assert svc.cilium_additional_devices == "eth1,eth2"


def test_clearing_additional_devices_drops_the_field():
    svc = _make_service()
    svc.set_cilium_additional_devices("eth1")
    svc.set_cilium_additional_devices("")
    assert "additionalDevices" not in _cilium(svc)
    assert svc.cilium_additional_devices == ""
