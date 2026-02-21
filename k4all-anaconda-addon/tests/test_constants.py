# =============================================================================
# Tests for com_k4all_installer.constants
# =============================================================================

import json
import copy
import pytest


class TestConstants:
    """Test that constants and DEFAULT_CONFIG are correctly defined."""

    def test_import(self):
        """Test that the constants module can be imported."""
        from com_k4all_installer.constants import (
            K4ALL, K4ALL_CONFIG_PATH, K4ALL_NODE_TYPE_PATH,
            VALID_ROLES, VALID_CNI_TYPES, VALID_HA_TYPES, DEFAULT_CONFIG
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
        # Paths should be relative, no leading slash
        assert not K4ALL_CONFIG_PATH.startswith("/")
        assert not K4ALL_NODE_TYPE_PATH.startswith("/")
        assert K4ALL_CONFIG_PATH == "etc/k4all-config.json"
        assert K4ALL_NODE_TYPE_PATH == "etc/node-type"

    def test_default_config_structure(self):
        from com_k4all_installer.constants import DEFAULT_CONFIG
        # Top-level keys
        assert "version" in DEFAULT_CONFIG
        assert "networking" in DEFAULT_CONFIG
        assert "disk" in DEFAULT_CONFIG
        assert "storage" in DEFAULT_CONFIG
        assert "features" in DEFAULT_CONFIG
        assert "cluster" in DEFAULT_CONFIG
        assert "proxy" in DEFAULT_CONFIG

    def test_default_config_networking(self):
        from com_k4all_installer.constants import DEFAULT_CONFIG
        net = DEFAULT_CONFIG["networking"]
        assert net["cni"]["type"] == "calico"
        assert net["firewalld"]["enabled"] == "false"
        assert net["iface"]["dev"] == "auto"
        assert net["iface"]["ipconfig"] == "dhcp"

    def test_default_config_storage(self):
        from com_k4all_installer.constants import DEFAULT_CONFIG
        storage = DEFAULT_CONFIG["storage"]
        assert "vg_data" in storage
        assert storage["vg_data"]["enabled"] == "true"
        assert storage["vg_data"]["disk"] == "auto"
        assert storage["vg_data"]["size"] == "remaining"

    def test_default_config_features(self):
        from com_k4all_installer.constants import DEFAULT_CONFIG
        features = DEFAULT_CONFIG["features"]
        assert features["virt"]["enabled"] == "false"
        assert features["argocd"]["enabled"] == "false"

    def test_default_config_cluster(self):
        from com_k4all_installer.constants import DEFAULT_CONFIG
        cluster = DEFAULT_CONFIG["cluster"]
        assert cluster["ha"]["type"] == "none"
        assert "customApiEndPoint" in cluster

    def test_default_config_is_json_serializable(self):
        from com_k4all_installer.constants import DEFAULT_CONFIG
        # Must be JSON serializable
        json_str = json.dumps(DEFAULT_CONFIG)
        parsed = json.loads(json_str)
        assert parsed == DEFAULT_CONFIG

    def test_default_config_deep_copy_safe(self):
        """Ensure DEFAULT_CONFIG can be deep copied without issues."""
        from com_k4all_installer.constants import DEFAULT_CONFIG
        config_copy = copy.deepcopy(DEFAULT_CONFIG)
        config_copy["networking"]["cni"]["type"] = "cilium"
        # Original should not be affected
        assert DEFAULT_CONFIG["networking"]["cni"]["type"] == "calico"

    def test_default_config_matches_json_file(self):
        """Ensure DEFAULT_CONFIG matches the k4all-config.json.default file."""
        import os
        from com_k4all_installer.constants import DEFAULT_CONFIG

        # Find the default config file
        config_file = os.path.join(
            os.path.dirname(__file__), "..", "..",
            "bootc", "overlay", "etc", "k4all-config.json.default"
        )
        if not os.path.exists(config_file):
            pytest.skip("k4all-config.json.default not found (run from project root)")

        with open(config_file) as f:
            file_config = json.load(f)

        assert file_config == DEFAULT_CONFIG, \
            "DEFAULT_CONFIG in constants.py does not match k4all-config.json.default"
