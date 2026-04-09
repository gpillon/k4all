# =============================================================================
# Tests for com_k4all_installer.service.k4all (D-Bus service logic)
# =============================================================================

import copy
import json
import pytest
from unittest.mock import MagicMock, patch


class TestK4AllService:
    """Test the K4All D-Bus service logic."""

    def _make_service(self):
        from com_k4all_installer.service.k4all import K4All
        return K4All()

    def test_default_role(self):
        svc = self._make_service()
        assert svc.role == ""

    def test_default_config(self):
        svc = self._make_service()
        assert svc.config["networking"]["cni"]["type"] == "calico"
        assert "version" not in svc.config

    def test_set_role(self):
        svc = self._make_service()
        svc.set_role("worker")
        assert svc.role == "worker"

    def test_set_role_emits_signal(self):
        svc = self._make_service()
        handler = MagicMock()
        svc.role_changed.connect(handler)
        svc.set_role("control")
        handler.assert_called_once()

    def test_set_config(self):
        svc = self._make_service()
        new_config = {"networking": {"cni": {"type": "cilium"}}}
        svc.set_config(new_config)
        assert svc.config == new_config

    def test_set_config_emits_signal(self):
        svc = self._make_service()
        handler = MagicMock()
        svc.config_changed.connect(handler)
        svc.set_config({"test": True})
        handler.assert_called_once()

    # -------------------------------------------------------------------------
    # Convenience property getters/setters
    # -------------------------------------------------------------------------
    def test_cni_type_getter(self):
        svc = self._make_service()
        assert svc.cni_type == "calico"

    def test_cni_type_setter(self):
        svc = self._make_service()
        svc.set_cni_type("cilium")
        assert svc.cni_type == "cilium"

    def test_ha_type_getter(self):
        svc = self._make_service()
        assert svc.ha_type == "none"

    def test_ha_type_setter(self):
        svc = self._make_service()
        svc.set_ha_type("keepalived")
        assert svc.ha_type == "keepalived"

    def test_virt_enabled_getter(self):
        svc = self._make_service()
        assert svc.virt_enabled is False

    def test_virt_enabled_setter(self):
        svc = self._make_service()
        svc.set_virt_enabled(True)
        assert svc.virt_enabled is True

    def test_argocd_enabled_getter(self):
        svc = self._make_service()
        assert svc.argocd_enabled is False

    def test_argocd_enabled_setter(self):
        svc = self._make_service()
        svc.set_argocd_enabled(True)
        assert svc.argocd_enabled is True

    def test_firewalld_enabled_getter(self):
        svc = self._make_service()
        assert svc.firewalld_enabled is False

    def test_firewalld_enabled_setter(self):
        svc = self._make_service()
        svc.set_firewalld_enabled(True)
        assert svc.firewalld_enabled is True

    # -------------------------------------------------------------------------
    # Config isolation
    # -------------------------------------------------------------------------
    def test_config_isolation(self):
        svc1 = self._make_service()
        svc2 = self._make_service()
        svc1.set_cni_type("cilium")
        assert svc2.cni_type == "calico"

    # -------------------------------------------------------------------------
    # process_kickstart
    # -------------------------------------------------------------------------
    def test_process_kickstart(self):
        svc = self._make_service()

        from com_k4all_installer.service.kickstart import K4AllData
        addon_data = K4AllData()
        addon_data.handle_header(["--role=worker", "--cni=cilium", "--ha=kubevip", "--virt"])
        addon_data.finalize()

        data = MagicMock()
        data.addons.com_k4all_installer = addon_data

        svc.process_kickstart(data)

        assert svc.role == "worker"
        assert svc.config["networking"]["cni"]["type"] == "cilium"
        assert svc.config["cluster"]["ha"]["type"] == "kubevip"
        assert svc.config["features"]["virt"]["enabled"] is True

    def test_process_kickstart_with_yaml_body(self):
        svc = self._make_service()

        from com_k4all_installer.service.kickstart import K4AllData
        addon_data = K4AllData()
        addon_data.handle_header(["--role=bootstrap"])
        addon_data.handle_line("proxy:\n")
        addon_data.handle_line("  httpProxy: http://proxy:8080\n")

        data = MagicMock()
        data.addons.com_k4all_installer = addon_data

        svc.process_kickstart(data)
        assert svc.config["proxy"]["httpProxy"] == "http://proxy:8080"

    # -------------------------------------------------------------------------
    # setup_kickstart
    # -------------------------------------------------------------------------
    def test_setup_kickstart(self):
        svc = self._make_service()
        svc.set_role("control")
        svc.set_cni_type("cilium")

        from com_k4all_installer.service.kickstart import K4AllData
        addon_data = K4AllData()
        data = MagicMock()
        data.addons.com_k4all_installer = addon_data

        svc.setup_kickstart(data)
        assert addon_data.role == "control"
        assert addon_data.cluster_config["networking"]["cni"]["type"] == "cilium"

    # -------------------------------------------------------------------------
    # Tasks
    # -------------------------------------------------------------------------
    def test_configure_with_tasks(self):
        svc = self._make_service()
        tasks = svc.configure_with_tasks()
        assert len(tasks) == 1
        assert tasks[0].name == "Configure K4All"

    def test_install_with_tasks(self):
        svc = self._make_service()
        tasks = svc.install_with_tasks()
        assert len(tasks) == 1
        assert tasks[0].name == "Install K4All Configuration"

    def test_kickstart_specification(self):
        svc = self._make_service()
        spec = svc.kickstart_specification
        assert "com_k4all_installer" in spec.addons


class TestK4AllInterface:
    def test_import(self):
        from com_k4all_installer.service.k4all_interface import K4AllInterface

    def test_role_property(self):
        from com_k4all_installer.service.k4all_interface import K4AllInterface
        mock_impl = MagicMock()
        mock_impl.role = "bootstrap"
        iface = K4AllInterface(mock_impl)
        assert iface.Role == "bootstrap"

    def test_set_role(self):
        from com_k4all_installer.service.k4all_interface import K4AllInterface
        mock_impl = MagicMock()
        iface = K4AllInterface(mock_impl)
        iface.SetRole("worker")
        mock_impl.set_role.assert_called_once_with("worker")

    def test_config_json_property(self):
        from com_k4all_installer.service.k4all_interface import K4AllInterface
        mock_impl = MagicMock()
        mock_impl.config = {"networking": {"cni": {"type": "calico"}}}
        iface = K4AllInterface(mock_impl)
        result = iface.ConfigJSON
        parsed = json.loads(result)
        assert parsed["networking"]["cni"]["type"] == "calico"

    def test_set_config_json(self):
        from com_k4all_installer.service.k4all_interface import K4AllInterface
        mock_impl = MagicMock()
        iface = K4AllInterface(mock_impl)
        iface.SetConfigJSON('{"networking": {"cni": {"type": "cilium"}}}')
        mock_impl.set_config.assert_called_once()
