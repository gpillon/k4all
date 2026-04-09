# =============================================================================
# Tests for com_k4all_installer.constants
# =============================================================================

import json
import copy
import pytest


class TestConstants:
    """Test that constants and config defaults are correctly defined."""

    def test_import(self):
        from com_k4all_installer.constants import (
            K4ALL, K4ALL_CONFIG_PATH, K4ALL_NODE_TYPE_PATH,
            VALID_ROLES, VALID_CNI_TYPES, VALID_HA_TYPES,
            DEFAULT_CLUSTER_CONFIG, DEFAULT_INSTALL_CONFIG,
            CR_API_VERSION, CR_KIND, CR_NAME,
        )

    def test_valid_roles(self):
        from com_k4all_installer.constants import VALID_ROLES
        assert "bootstrap" in VALID_ROLES
        assert "control" in VALID_ROLES
        assert "worker" in VALID_ROLES
        assert len(VALID_ROLES) == 3

    def test_valid_cni_types(self):
        from com_k4all_installer.constants import VALID_CNI_TYPES
        assert "calico" in VALID_CNI_TYPES
        assert "cilium" in VALID_CNI_TYPES
        assert len(VALID_CNI_TYPES) == 2

    def test_valid_ha_types(self):
        from com_k4all_installer.constants import VALID_HA_TYPES
        assert "none" in VALID_HA_TYPES
        assert "keepalived" in VALID_HA_TYPES
        assert "kubevip" in VALID_HA_TYPES
        assert len(VALID_HA_TYPES) == 3

    def test_file_paths(self):
        from com_k4all_installer.constants import K4ALL_CONFIG_PATH, K4ALL_NODE_TYPE_PATH
        assert not K4ALL_CONFIG_PATH.startswith("/")
        assert not K4ALL_NODE_TYPE_PATH.startswith("/")
        assert K4ALL_CONFIG_PATH == "etc/k4all-config.yaml"
        assert K4ALL_NODE_TYPE_PATH == "etc/node-type"

    def test_cr_metadata(self):
        from com_k4all_installer.constants import CR_API_VERSION, CR_KIND, CR_NAME
        assert CR_API_VERSION == "k4all.magesgate.com/v1alpha1"
        assert CR_KIND == "ClusterConfig"
        assert CR_NAME == "k4all-cluster-config"

    def test_cluster_config_structure(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        assert "networking" in DEFAULT_CLUSTER_CONFIG
        assert "features" in DEFAULT_CLUSTER_CONFIG
        assert "cluster" in DEFAULT_CLUSTER_CONFIG
        assert "ingress" in DEFAULT_CLUSTER_CONFIG
        assert "proxy" in DEFAULT_CLUSTER_CONFIG
        # Installer-only fields must NOT be in the cluster config
        assert "disk" not in DEFAULT_CLUSTER_CONFIG
        assert "storage" not in DEFAULT_CLUSTER_CONFIG
        assert "version" not in DEFAULT_CLUSTER_CONFIG

    def test_cluster_config_networking(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        net = DEFAULT_CLUSTER_CONFIG["networking"]
        assert net["cni"]["type"] == "calico"
        assert net["firewalld"]["enabled"] is False
        assert net["iface"]["dev"] == "auto"
        assert net["iface"]["ipConfig"] == "dhcp"

    def test_cluster_config_features(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        features = DEFAULT_CLUSTER_CONFIG["features"]
        assert features["virt"]["enabled"] is False
        assert features["argocd"]["enabled"] is False
        assert features["ovsCni"]["enabled"] is False

    def test_cluster_config_cluster(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        cluster = DEFAULT_CLUSTER_CONFIG["cluster"]
        assert cluster["ha"]["type"] == "none"
        assert "customApiEndPoint" in cluster

    def test_cluster_config_ingress(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        ingress = DEFAULT_CLUSTER_CONFIG["ingress"]
        assert ingress["nginx"]["isDefault"] is True
        assert ingress["nginx"]["dedicatedIP"] == ""
        assert ingress["cilium"]["dedicatedIP"] == ""

    def test_cluster_config_proxy(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        proxy = DEFAULT_CLUSTER_CONFIG["proxy"]
        assert proxy["httpProxy"] == ""
        assert proxy["httpsProxy"] == ""
        assert proxy["noProxy"] == ""

    def test_install_config_structure(self):
        from com_k4all_installer.constants import DEFAULT_INSTALL_CONFIG
        assert "disk" in DEFAULT_INSTALL_CONFIG
        assert "storage" in DEFAULT_INSTALL_CONFIG

    def test_install_config_storage(self):
        from com_k4all_installer.constants import DEFAULT_INSTALL_CONFIG
        storage = DEFAULT_INSTALL_CONFIG["storage"]
        assert "vg_data" in storage
        assert storage["vg_data"]["enabled"] == "true"
        assert storage["vg_data"]["disk"] == "auto"
        assert storage["vg_data"]["size"] == "remaining"

    def test_cluster_config_is_json_serializable(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        json_str = json.dumps(DEFAULT_CLUSTER_CONFIG)
        parsed = json.loads(json_str)
        assert parsed == DEFAULT_CLUSTER_CONFIG

    def test_cluster_config_deep_copy_safe(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        config_copy = copy.deepcopy(DEFAULT_CLUSTER_CONFIG)
        config_copy["networking"]["cni"]["type"] = "cilium"
        assert DEFAULT_CLUSTER_CONFIG["networking"]["cni"]["type"] == "calico"

    def test_default_config_matches_yaml_file(self):
        """Ensure DEFAULT_CLUSTER_CONFIG matches the k4all-config.yaml.default file."""
        import os

        try:
            import yaml
        except ImportError:
            pytest.skip("PyYAML not available")

        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG

        config_file = os.path.join(
            os.path.dirname(__file__), "..", "..",
            "bootc", "overlay", "etc", "k4all-config.yaml.default"
        )
        if not os.path.exists(config_file):
            pytest.skip("k4all-config.yaml.default not found (run from project root)")

        with open(config_file) as f:
            file_cr = yaml.safe_load(f)

        assert file_cr["spec"] == DEFAULT_CLUSTER_CONFIG, \
            "DEFAULT_CLUSTER_CONFIG does not match the spec in k4all-config.yaml.default"
