# =============================================================================
# A kickstart sets at install every ClusterConfig field of k4all v2.7.0
# (spec §3), checked as the ClusterConfig CRD checks it: a value the CRD
# would refuse when the node applies its config at first boot is refused at
# install, with the field in the message.
# =============================================================================

import copy
import json
import os
import shutil
import tempfile
from unittest.mock import MagicMock, patch

import pytest

try:
    import yaml
except ImportError:
    yaml = None


# Every v2.7.0 field, set as the spec's example sets it.
FULL_V270 = {
    "features": {
        "virt": {
            "enabled": True,
            "kubevirt": {
                "featureGates": ["Sidecar", "HostDevices"],
                "disabledFeatureGates": ["VMExport"],
                "vmStateStorageClass": "ceph-rbd",
            },
            "hangar": {"nodeAgent": False},
            "metadata": {
                "enabled": True,
                "scope": "All",
                "tokens": {"audiences": ["k4all-metadata", "vault"], "expirationSeconds": 3600},
                "vendorDataConfigMap": "k4all-vendor-data",
            },
        },
        "rook": {"enabled": True, "storage": {"deviceFilter": "^sdb$"}, "smallCluster": "Allow"},
    },
    "nodes": {
        "kubelet": {
            "maxPods": 200,
            "cpuManagerPolicy": "static",
            "reservedSystemCPUs": "0-1",
            "topologyManagerPolicy": "single-numa-node",
            "topologyManagerScope": "pod",
        },
        "hugepages": {"1Gi": 4, "2Mi": 0},
        "iommu": True,
        "rollout": {"paused": True},
    },
}


def finalize(body):
    from com_k4all_installer.service.kickstart import K4AllData
    data = K4AllData()
    data.handle_header(["--role=bootstrap"])
    data.handle_line(json.dumps(body) + "\n")
    data.finalize()
    return data


def with_field(path, value):
    """FULL_V270 with the field at path (dotted) set to value."""
    body = copy.deepcopy(FULL_V270)
    node = body
    keys = path.split(".")
    for key in keys[:-1]:
        node = node.setdefault(key, {})
    node[keys[-1]] = value
    return body


def test_every_v270_field_is_accepted():
    cfg = finalize(FULL_V270).cluster_config
    for section in ("kubevirt", "hangar", "metadata"):
        assert cfg["features"]["virt"][section] == FULL_V270["features"]["virt"][section]
    assert cfg["features"]["rook"] == FULL_V270["features"]["rook"]
    assert cfg["nodes"] == FULL_V270["nodes"]


@pytest.mark.parametrize("path, value, message", [
    # features.virt.kubevirt
    ("features.virt.kubevirt.featureGates", "Sidecar", "featureGates must be a list"),
    ("features.virt.kubevirt.featureGates", ["Sidecar", 3], "featureGates must be a list of strings"),
    ("features.virt.kubevirt.featureGates", ["Sidecar", "Sidecar"], "featureGates lists Sidecar twice"),
    ("features.virt.kubevirt.featureGates", ["G%d" % i for i in range(65)], "featureGates: at most 64"),
    ("features.virt.kubevirt.disabledFeatureGates", ["VMExport", "VMExport"], "disabledFeatureGates lists VMExport twice"),
    ("features.virt.kubevirt.disabledFeatureGates", ["Sidecar"], "a gate cannot be both on and off: Sidecar"),
    ("features.virt.kubevirt.featureGates", ["HotplugVolumes", "DeclarativeHotplugVolumes"],
     "HotplugVolumes turns DeclarativeHotplugVolumes off: set one"),
    ("features.virt.kubevirt.vmStateStorageClass", 7, "vmStateStorageClass must be a string"),
    ("features.virt.kubevirt.cpuModel", "host-passthrough", "Unknown ClusterConfig field(s) below features.virt.kubevirt: cpuModel"),
    # features.virt.hangar, metadata
    ("features.virt.hangar.nodeAgent", "maybe", "nodeAgent must be a boolean"),
    ("features.virt.metadata.scope", "Everyone", "features.virt.metadata.scope: Everyone (one of Labelled, All)"),
    ("features.virt.metadata.tokens.audiences", ["vault", "vault"], "audiences lists vault twice"),
    ("features.virt.metadata.tokens.expirationSeconds", 599, "expirationSeconds: 599 (at least 600)"),
    ("features.virt.metadata.tokens.expirationSeconds", "3600", "expirationSeconds must be an integer"),
    ("features.virt.metadata.vendorDataConfigMap", ["a"], "vendorDataConfigMap must be a string"),
    # features.rook
    ("features.rook.smallCluster", "Maybe", "features.rook.smallCluster: Maybe (one of Refuse, Allow)"),
    ("features.rook.storage.deviceFilter", True, "deviceFilter must be a string"),
    # nodes
    ("nodes.kubelet.maxPods", 9, "nodes.kubelet.maxPods: 9 (from 10 to 1000)"),
    ("nodes.kubelet.maxPods", 1001, "nodes.kubelet.maxPods: 1001 (from 10 to 1000)"),
    ("nodes.kubelet.maxPods", True, "maxPods must be an integer"),
    ("nodes.kubelet.cpuManagerPolicy", "dynamic", "cpuManagerPolicy: dynamic (one of none, static)"),
    ("nodes.kubelet.reservedSystemCPUs", "", "the static CPU manager needs reservedSystemCPUs"),
    ("nodes.kubelet.topologyManagerPolicy", "strict",
     "topologyManagerPolicy: strict (one of none, best-effort, restricted, single-numa-node)"),
    ("nodes.kubelet.topologyManagerScope", "node", "topologyManagerScope: node (one of container, pod)"),
    ("nodes.hugepages", {"1Gi": 4, "1Mi": 2}, "hugepages page sizes are 1Gi and 2Mi: 1Mi"),
    ("nodes.hugepages", {"1Gi": -1}, "hugepage counts are 0 or more: 1Gi"),
    ("nodes.hugepages", {"2Mi": "512"}, "nodes.hugepages.2Mi must be an integer"),
    ("nodes.hugepages", ["1Gi"], "nodes.hugepages must be a mapping"),
    ("nodes.iommu", "on", "iommu must be a boolean"),
    ("nodes.rollout.paused", 1, "paused must be a boolean"),
    ("nodes.kubelet.evictionHard", {}, "Unknown ClusterConfig field(s) below nodes.kubelet: evictionHard"),
])
def test_a_value_the_crd_refuses_is_refused_at_install(path, value, message):
    with pytest.raises(ValueError) as err:
        finalize(with_field(path, value))
    assert message in str(err.value)


def test_static_cpu_manager_without_reserved_cpus_is_refused():
    body = copy.deepcopy(FULL_V270)
    del body["nodes"]["kubelet"]["reservedSystemCPUs"]
    with pytest.raises(ValueError, match="the static CPU manager needs reservedSystemCPUs"):
        finalize(body)


@pytest.mark.parametrize("path, value", [
    ("nodes.kubelet.cpuManagerPolicy", "none"),             # no reservedSystemCPUs needed
    ("nodes.hugepages", {}),                                  # owns no size
    ("features.virt.kubevirt.featureGates", []),
    ("features.virt.kubevirt.featureGates", ["HotplugVolumes"]),
    ("features.virt.metadata.tokens.expirationSeconds", 600),
    ("nodes.kubelet.maxPods", 1000),
])
def test_valid_values_are_accepted(path, value):
    body = with_field(path, value)
    if path == "nodes.kubelet.cpuManagerPolicy":
        del body["nodes"]["kubelet"]["reservedSystemCPUs"]
    finalize(body)


@pytest.mark.skipif(yaml is None, reason="needs PyYAML")
def test_the_kickstart_settings_land_in_the_clusterconfig():
    # The installer writes them as the ClusterConfig expects: page sizes as
    # string keys, gate lists as lists, integers as integers.
    from com_k4all_installer.service.installation import K4AllInstallationTask
    data = finalize(FULL_V270)
    sysroot = tempfile.mkdtemp(prefix="k4all-test-sysroot-")
    try:
        task = K4AllInstallationTask(sysroot=sysroot, role="bootstrap",
                                     cluster_config=data.cluster_config,
                                     install_config=data.install_config)
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()
        with open(os.path.join(sysroot, "etc", "k4all-config.yaml")) as fh:
            spec = yaml.safe_load(fh)["spec"]
    finally:
        shutil.rmtree(sysroot, ignore_errors=True)
    assert spec["nodes"] == FULL_V270["nodes"]
    assert list(spec["nodes"]["hugepages"]) == ["1Gi", "2Mi"]
    assert spec["features"]["virt"]["kubevirt"] == FULL_V270["features"]["virt"]["kubevirt"]
    assert spec["features"]["virt"]["metadata"] == FULL_V270["features"]["virt"]["metadata"]
    assert spec["features"]["virt"]["hangar"] == {"nodeAgent": False}
    assert spec["features"]["rook"] == FULL_V270["features"]["rook"]


def test_the_kickstart_text_carries_the_settings_back():
    # __str__ writes the body back: the same settings come out of it.
    from com_k4all_installer.service.kickstart import K4AllData
    data = finalize(FULL_V270)
    text = str(data)
    body = text[text.index("\n", text.index("%addon")) + 1:text.index("%end")]
    again = K4AllData()
    again.handle_header(["--role=bootstrap"])
    again.handle_line(body)
    again.finalize()
    assert again.cluster_config["nodes"] == FULL_V270["nodes"]
    assert again.cluster_config["features"]["virt"]["kubevirt"] == FULL_V270["features"]["virt"]["kubevirt"]
