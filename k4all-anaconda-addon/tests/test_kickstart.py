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
        data = self._make_data()
        assert data.role == ""
        assert data.cluster_config["networking"]["cni"]["type"] == "calico"
        assert data.cluster_config["cluster"]["ha"]["type"] == "none"
        assert data.cluster_config["features"]["virt"]["enabled"] is False
        assert data.cluster_config["features"]["argocd"]["enabled"] is False
        assert data.cluster_config["networking"]["firewalld"]["enabled"] is False

    def test_install_defaults(self):
        data = self._make_data()
        assert data.install_config["storage"]["vg_data"]["enabled"] == "true"

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
        assert data.cluster_config["networking"]["cni"]["type"] == "cilium"

    def test_parse_ha_keepalived(self):
        data = self._make_data()
        data.handle_header(["--ha=keepalived"])
        assert data.cluster_config["cluster"]["ha"]["type"] == "keepalived"

    def test_parse_ha_kubevip(self):
        data = self._make_data()
        data.handle_header(["--ha=kubevip"])
        assert data.cluster_config["cluster"]["ha"]["type"] == "kubevip"

    def test_parse_virt_flag(self):
        data = self._make_data()
        data.handle_header(["--virt"])
        assert data.cluster_config["features"]["virt"]["enabled"] is True

    def test_parse_argocd_flag(self):
        data = self._make_data()
        data.handle_header(["--argocd"])
        assert data.cluster_config["features"]["argocd"]["enabled"] is True

    def test_parse_firewalld_flag(self):
        data = self._make_data()
        data.handle_header(["--firewalld"])
        assert data.cluster_config["networking"]["firewalld"]["enabled"] is True

    def test_parse_no_vg_data(self):
        data = self._make_data()
        data.handle_header(["--no-vg-data"])
        assert data.install_config["storage"]["vg_data"]["enabled"] == "false"

    def test_parse_vg_data_disk(self):
        data = self._make_data()
        data.handle_header(["--vg-data-disk=sdb"])
        assert data.install_config["storage"]["vg_data"]["disk"] == "sdb"

    def test_parse_combined_args(self):
        data = self._make_data()
        data.handle_header([
            "--role=worker", "--cni=cilium", "--ha=kubevip",
            "--virt", "--argocd", "--firewalld",
            "--vg-data-disk=nvme0n1"
        ])
        assert data.role == "worker"
        assert data.cluster_config["networking"]["cni"]["type"] == "cilium"
        assert data.cluster_config["cluster"]["ha"]["type"] == "kubevip"
        assert data.cluster_config["features"]["virt"]["enabled"] is True
        assert data.cluster_config["features"]["argocd"]["enabled"] is True
        assert data.cluster_config["networking"]["firewalld"]["enabled"] is True
        assert data.install_config["storage"]["vg_data"]["disk"] == "nvme0n1"

    def test_parse_empty_args(self):
        data = self._make_data()
        data.handle_header([])
        assert data.role == ""
        assert data.cluster_config["networking"]["cni"]["type"] == "calico"
        assert data.cluster_config["cluster"]["ha"]["type"] == "none"

    # -------------------------------------------------------------------------
    # handle_line + finalize tests
    # -------------------------------------------------------------------------
    def test_json_body_merge(self):
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        data.handle_line('{\n')
        data.handle_line('  "cluster": { "ha": { "type": "keepalived" } }\n')
        data.handle_line('}\n')
        data.finalize()
        assert data.cluster_config["cluster"]["ha"]["type"] == "keepalived"

    def test_yaml_body_merge(self):
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        data.handle_line("cluster:\n")
        data.handle_line("  ha:\n")
        data.handle_line("    type: kubevip\n")
        data.finalize()
        assert data.cluster_config["cluster"]["ha"]["type"] == "kubevip"

    def test_body_deep_merge(self):
        data = self._make_data()
        data.handle_header([])
        data.handle_line('{"features": {"virt": {"enabled": true}}}\n')
        data.finalize()
        assert data.cluster_config["features"]["virt"]["enabled"] is True
        assert data.cluster_config["features"]["argocd"]["enabled"] is False

    def test_body_extra_fields(self):
        data = self._make_data()
        data.handle_header([])
        data.handle_line('{"custom_field": "custom_value"}\n')
        data.finalize()
        assert data.cluster_config["custom_field"] == "custom_value"

    def test_empty_body(self):
        data = self._make_data()
        data.handle_header(["--role=worker", "--cni=cilium"])
        data.finalize()
        assert data.role == "worker"
        assert data.cluster_config["networking"]["cni"]["type"] == "cilium"

    def test_invalid_body_ignored(self):
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        data.handle_line("this is not valid yaml or json\n")
        data.finalize()
        assert data.cluster_config["networking"]["cni"]["type"] == "calico"

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

    def test_str_body_is_parseable(self):
        """The body between header and %end should be valid YAML or JSON."""
        data = self._make_data()
        data.handle_header(["--role=bootstrap"])
        data.finalize()
        s = str(data)
        lines = s.split("\n")
        body_lines = []
        in_body = False
        for line in lines:
            if line.startswith("%addon"):
                in_body = True
                continue
            if line.startswith("%end"):
                break
            if in_body:
                body_lines.append(line)
        body_text = "\n".join(body_lines).strip()
        if body_text:
            try:
                import yaml as _yaml
                parsed = _yaml.safe_load(body_text)
            except ImportError:
                parsed = json.loads(body_text)
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
    def test_addons_registered(self):
        from com_k4all_installer.service.kickstart import K4AllKickstartSpecification
        assert "com_k4all_installer" in K4AllKickstartSpecification.addons

    def test_addons_class(self):
        from com_k4all_installer.service.kickstart import (
            K4AllKickstartSpecification, K4AllData
        )
        assert K4AllKickstartSpecification.addons["com_k4all_installer"] is K4AllData
