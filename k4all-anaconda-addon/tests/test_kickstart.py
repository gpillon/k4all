# =============================================================================
# Tests for com_k4all_installer.service.kickstart
# =============================================================================

import json
import copy
import pytest


class TestK4AllData:
    """Test the K4AllData kickstart parsing class."""

    def _make_data(self):
        from com_k4all_installer.service.kickstart import K4AllData
        return K4AllData()

    def test_defaults(self):
        """Test default values for K4AllData."""
        data = self._make_data()
        assert data.role == "bootstrap"
        assert data.config["networking"]["cni"]["type"] == "calico"
        assert data.config["cluster"]["ha"]["type"] == "none"
        assert data.config["features"]["virt"]["enabled"] == "false"
        assert data.config["features"]["argocd"]["enabled"] == "false"
        assert data.config["networking"]["firewalld"]["enabled"] == "false"
        assert data.config["storage"]["vg_data"]["enabled"] == "true"

    # -------------------------------------------------------------------------
    # handle_header tests
    # -------------------------------------------------------------------------
    def test_parse_role_bootstrap(self):
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        assert data.role == "bootstrap"

    def test_parse_role_control(self):
        data = self._make_data()
        data.handle_header(["--role=control"])
        assert data.role == "control"

    def test_parse_role_worker(self):
        data = self._make_data()
        data.handle_header(["--role=worker"])
        assert data.role == "worker"

    def test_parse_cni_cilium(self):
        data = self._make_data()
        data.handle_header(["--cni=cilium"])
        assert data.config["networking"]["cni"]["type"] == "cilium"

    def test_parse_ha_keepalived(self):
        data = self._make_data()
        data.handle_header(["--ha=keepalived"])
        assert data.config["cluster"]["ha"]["type"] == "keepalived"

    def test_parse_ha_kubevip(self):
        data = self._make_data()
        data.handle_header(["--ha=kubevip"])
        assert data.config["cluster"]["ha"]["type"] == "kubevip"

    def test_parse_virt_flag(self):
        data = self._make_data()
        data.handle_header(["--virt"])
        assert data.config["features"]["virt"]["enabled"] == "true"

    def test_parse_argocd_flag(self):
        data = self._make_data()
        data.handle_header(["--argocd"])
        assert data.config["features"]["argocd"]["enabled"] == "true"

    def test_parse_firewalld_flag(self):
        data = self._make_data()
        data.handle_header(["--firewalld"])
        assert data.config["networking"]["firewalld"]["enabled"] == "true"

    def test_parse_no_vg_data(self):
        data = self._make_data()
        data.handle_header(["--no-vg-data"])
        assert data.config["storage"]["vg_data"]["enabled"] == "false"

    def test_parse_vg_data_disk(self):
        data = self._make_data()
        data.handle_header(["--vg-data-disk=sdb"])
        assert data.config["storage"]["vg_data"]["disk"] == "sdb"

    def test_parse_combined_args(self):
        data = self._make_data()
        data.handle_header([
            "--role=worker", "--cni=cilium", "--ha=kubevip",
            "--virt", "--argocd", "--firewalld",
            "--vg-data-disk=nvme0n1"
        ])
        assert data.role == "worker"
        assert data.config["networking"]["cni"]["type"] == "cilium"
        assert data.config["cluster"]["ha"]["type"] == "kubevip"
        assert data.config["features"]["virt"]["enabled"] == "true"
        assert data.config["features"]["argocd"]["enabled"] == "true"
        assert data.config["networking"]["firewalld"]["enabled"] == "true"
        assert data.config["storage"]["vg_data"]["disk"] == "nvme0n1"

    def test_parse_empty_args(self):
        """Empty args should use all defaults."""
        data = self._make_data()
        data.handle_header([])
        assert data.role == "bootstrap"
        assert data.config["networking"]["cni"]["type"] == "calico"
        assert data.config["cluster"]["ha"]["type"] == "none"

    # -------------------------------------------------------------------------
    # handle_line + finalize tests (JSON body)
    # -------------------------------------------------------------------------
    def test_json_body_merge(self):
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        data.handle_line('{\n')
        data.handle_line('  "cluster": { "ha": { "type": "keepalived" } }\n')
        data.handle_line('}\n')
        data.finalize()
        # JSON body should override header args
        assert data.config["cluster"]["ha"]["type"] == "keepalived"

    def test_json_body_deep_merge(self):
        """JSON body should deep merge, not replace entire sub-dicts."""
        data = self._make_data()
        data.handle_header([])
        data.handle_line('{"features": {"virt": {"enabled": "true"}}}\n')
        data.finalize()
        # virt should be updated
        assert data.config["features"]["virt"]["enabled"] == "true"
        # argocd should still have default
        assert data.config["features"]["argocd"]["enabled"] == "false"

    def test_json_body_extra_fields(self):
        """JSON body with extra fields should be preserved."""
        data = self._make_data()
        data.handle_header([])
        data.handle_line('{"custom_field": "custom_value"}\n')
        data.finalize()
        assert data.config["custom_field"] == "custom_value"

    def test_empty_json_body(self):
        """No JSON body should leave config unchanged."""
        data = self._make_data()
        data.handle_header(["--role=worker", "--cni=cilium"])
        data.finalize()
        assert data.role == "worker"
        assert data.config["networking"]["cni"]["type"] == "cilium"

    def test_invalid_json_body(self):
        """Invalid JSON should be silently ignored (logged warning)."""
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        data.handle_line("this is not valid json\n")
        data.finalize()
        # Config should still be intact
        assert data.config["networking"]["cni"]["type"] == "calico"

    # -------------------------------------------------------------------------
    # __str__ roundtrip tests
    # -------------------------------------------------------------------------
    def test_str_contains_addon_directive(self):
        data = self._make_data()
        data.handle_header(["--role=bootstrap", "--cni=calico", "--ha=none"])
        data.finalize()
        s = str(data)
        assert "%addon com_k4all_installer" in s
        assert "--role=bootstrap" in s
        assert "--cni=calico" in s
        assert "--ha=none" in s
        assert "%end" in s

    def test_str_includes_flags(self):
        data = self._make_data()
        data.handle_header(["--virt", "--argocd", "--firewalld"])
        data.finalize()
        s = str(data)
        assert "--virt" in s
        assert "--argocd" in s
        assert "--firewalld" in s

    def test_str_no_vg_data(self):
        data = self._make_data()
        data.handle_header(["--no-vg-data"])
        data.finalize()
        s = str(data)
        assert "--no-vg-data" in s

    def test_str_vg_data_disk(self):
        data = self._make_data()
        data.handle_header(["--vg-data-disk=sdb"])
        data.finalize()
        s = str(data)
        assert "--vg-data-disk=sdb" in s

    def test_str_includes_json_body(self):
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        data.finalize()
        s = str(data)
        # The JSON body should be valid JSON
        lines = s.split("\n")
        # Find the JSON part (between header line and %end)
        json_lines = []
        in_json = False
        for line in lines:
            if line.startswith("%addon"):
                in_json = True
                continue
            if line.startswith("%end"):
                break
            if in_json:
                json_lines.append(line)
        json_text = "\n".join(json_lines).strip()
        if json_text:
            parsed = json.loads(json_text)
            assert isinstance(parsed, dict)

    # -------------------------------------------------------------------------
    # Deep merge helper
    # -------------------------------------------------------------------------
    def test_deep_merge_preserves_siblings(self):
        data = self._make_data()
        base = {"a": {"x": 1, "y": 2}, "b": 3}
        data._deep_merge(base, {"a": {"x": 99}})
        assert base == {"a": {"x": 99, "y": 2}, "b": 3}

    def test_deep_merge_adds_keys(self):
        data = self._make_data()
        base = {"a": 1}
        data._deep_merge(base, {"b": 2})
        assert base == {"a": 1, "b": 2}

    def test_deep_merge_replaces_non_dict(self):
        data = self._make_data()
        base = {"a": "string"}
        data._deep_merge(base, {"a": {"nested": True}})
        assert base == {"a": {"nested": True}}


class TestK4AllKickstartSpecification:
    """Test the KickstartSpecification class."""

    def test_addons_registered(self):
        from com_k4all_installer.service.kickstart import K4AllKickstartSpecification
        assert "com_k4all_installer" in K4AllKickstartSpecification.addons

    def test_addons_class(self):
        from com_k4all_installer.service.kickstart import (
            K4AllKickstartSpecification, K4AllData
        )
        assert K4AllKickstartSpecification.addons["com_k4all_installer"] is K4AllData
