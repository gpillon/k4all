# K4All Anaconda Addon - D-Bus Service
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""The K4All D-Bus service."""

import logging
import copy

from pyanaconda.core.configuration.anaconda import conf
from pyanaconda.core.dbus import DBus
from pyanaconda.core.signal import Signal
from pyanaconda.modules.common.base import KickstartService
from pyanaconda.modules.common.containers import TaskContainer

from com_k4all_installer.constants import (
    K4ALL, DEFAULT_CLUSTER_CONFIG, DEFAULT_INSTALL_CONFIG,
)
from com_k4all_installer.service.k4all_interface import K4AllInterface
from com_k4all_installer.service.installation import (
    K4AllConfigurationTask,
    K4AllInstallationTask
)
from com_k4all_installer.service.kickstart import K4AllKickstartSpecification

log = logging.getLogger(__name__)


class K4All(KickstartService):
    """The K4All D-Bus service.

    This class parses and stores data for the K4All addon.
    """

    def __init__(self):
        super().__init__()

        self._role = ""

        # ClusterConfig spec fields (written into the CR)
        self._config = copy.deepcopy(DEFAULT_CLUSTER_CONFIG)

        # Installer-only fields (disk/storage; not written into the CR)
        self._install_config = copy.deepcopy(DEFAULT_INSTALL_CONFIG)

        self._disk_layout_applied = False
        self._disk_layout_kickstart = ""

        self._backup_archive_path = ""
        self._restore_enabled = False

        self.role_changed = Signal()
        self.config_changed = Signal()

    def publish(self):
        """Publish the module."""
        TaskContainer.set_namespace(K4ALL.namespace)
        DBus.publish_object(K4ALL.object_path, K4AllInterface(self))
        DBus.register_service(K4ALL.service_name)

    @property
    def kickstart_specification(self):
        return K4AllKickstartSpecification

    def process_kickstart(self, data):
        """Process the kickstart data."""
        log.debug("Processing K4All kickstart data...")
        addon_data = data.addons.com_k4all_installer

        addon_data.finalize()

        self._role = addon_data.role
        self._config = addon_data.cluster_config
        self._install_config = addon_data.install_config

        log.info("K4All kickstart: role=%s, cni=%s, ha=%s",
                 self._role,
                 self._config["networking"]["cni"]["type"],
                 self._config["cluster"]["ha"]["type"])

    def setup_kickstart(self, data):
        """Set the given kickstart data."""
        log.debug("Generating K4All kickstart data...")
        addon_data = data.addons.com_k4all_installer
        addon_data.role = self._role
        addon_data.cluster_config = self._config
        addon_data.install_config = self._install_config

    # --- Role ---
    @property
    def role(self):
        return self._role

    def set_role(self, role):
        self._role = role
        self.role_changed.emit()
        log.debug("Role set to %s", role)

    # --- Full config ---
    @property
    def config(self):
        """The full cluster configuration dict (ClusterConfig spec)."""
        return self._config

    def set_config(self, config):
        self._config = config
        self.config_changed.emit()

    # --- Convenience properties ---
    @property
    def cni_type(self):
        return self._config["networking"]["cni"]["type"]

    def set_cni_type(self, cni_type):
        self._config["networking"]["cni"]["type"] = cni_type
        self.config_changed.emit()

    @property
    def ha_type(self):
        return self._config["cluster"]["ha"]["type"]

    def set_ha_type(self, ha_type):
        self._config["cluster"]["ha"]["type"] = ha_type
        self.config_changed.emit()

    @property
    def virt_enabled(self):
        return bool(self._config["features"]["virt"]["enabled"])

    def set_virt_enabled(self, enabled):
        self._config["features"]["virt"]["enabled"] = bool(enabled)
        self.config_changed.emit()

    @property
    def argocd_enabled(self):
        return bool(self._config["features"]["argocd"]["enabled"])

    def set_argocd_enabled(self, enabled):
        self._config["features"]["argocd"]["enabled"] = bool(enabled)
        self.config_changed.emit()

    @property
    def firewalld_enabled(self):
        return bool(self._config["networking"]["firewalld"]["enabled"])

    def set_firewalld_enabled(self, enabled):
        self._config["networking"]["firewalld"]["enabled"] = bool(enabled)
        self.config_changed.emit()

    @property
    def api_endpoint_use_hostname(self):
        v = self._config["cluster"].get("apiEndPointUseHostName", False)
        if v is True:
            return "true"
        if v is False:
            return "false"
        return str(v)

    def set_api_endpoint_use_hostname(self, value):
        if value == "true":
            self._config["cluster"]["apiEndPointUseHostName"] = True
        elif value == "false":
            self._config["cluster"]["apiEndPointUseHostName"] = False
        else:
            self._config["cluster"]["apiEndPointUseHostName"] = value
        self.config_changed.emit()

    @property
    def custom_api_endpoint(self):
        return self._config["cluster"].get("customApiEndPoint", "")

    def set_custom_api_endpoint(self, value):
        self._config["cluster"]["customApiEndPoint"] = value
        self.config_changed.emit()

    @property
    def pod_network(self):
        return self._config["cluster"].get("podNetwork", "10.100.0.1/18")

    def set_pod_network(self, value):
        self._config["cluster"]["podNetwork"] = value
        self.config_changed.emit()

    @property
    def service_network(self):
        return self._config["cluster"].get("serviceNetwork", "10.96.0.0/16")

    def set_service_network(self, value):
        self._config["cluster"]["serviceNetwork"] = value
        self.config_changed.emit()

    @property
    def api_control_endpoint(self):
        return self._config["cluster"]["ha"].get("apiControlEndpoint", "")

    def set_api_control_endpoint(self, value):
        self._config["cluster"]["ha"]["apiControlEndpoint"] = value
        self.config_changed.emit()

    @property
    def api_control_endpoint_subnet_size(self):
        return self._config["cluster"]["ha"].get("apiControlEndpointSubnetSize", "")

    def set_api_control_endpoint_subnet_size(self, value):
        self._config["cluster"]["ha"]["apiControlEndpointSubnetSize"] = value
        self.config_changed.emit()

    # --- Cilium-specific (stored in componentOverrides) ---
    def _cilium_overrides(self):
        co = self._config.setdefault("componentOverrides", {})
        cil = co.setdefault("cilium", {})
        return cil.setdefault("values", {})

    @property
    def cilium_additional_devices(self):
        return self._cilium_overrides().get("additionalDevices", "")

    def set_cilium_additional_devices(self, value):
        self._cilium_overrides()["additionalDevices"] = value
        self.config_changed.emit()

    @property
    def cilium_gateway_api(self):
        return bool(self._cilium_overrides().get("gatewayApi", False))

    def set_cilium_gateway_api(self, enabled):
        self._cilium_overrides()["gatewayApi"] = bool(enabled)
        self.config_changed.emit()

    @property
    def cilium_l2_announcements(self):
        return bool(self._cilium_overrides().get("l2announcements", False))

    def set_cilium_l2_announcements(self, enabled):
        self._cilium_overrides()["l2announcements"] = bool(enabled)
        self.config_changed.emit()

    @property
    def cilium_hubble(self):
        return bool(self._cilium_overrides().get("hubble", False))

    def set_cilium_hubble(self, enabled):
        self._cilium_overrides()["hubble"] = bool(enabled)
        self.config_changed.emit()

    # --- Ingress configuration ---
    @property
    def ingress_nginx_enabled(self):
        return self._config.get("ingress", {}).get("nginx", {}).get("isDefault", True)

    def set_ingress_nginx_enabled(self, enabled):
        self._config.setdefault("ingress", {}).setdefault("nginx", {})["isDefault"] = bool(enabled)
        self.config_changed.emit()

    @property
    def ingress_nginx_default(self):
        return bool(self._config.get("ingress", {}).get("nginx", {}).get("isDefault", True))

    def set_ingress_nginx_default(self, is_default):
        self._config.setdefault("ingress", {}).setdefault("nginx", {})["isDefault"] = bool(is_default)
        self.config_changed.emit()

    @property
    def ingress_nginx_dedicated_ip(self):
        return self._config.get("ingress", {}).get("nginx", {}).get("dedicatedIP", "")

    def set_ingress_nginx_dedicated_ip(self, value):
        self._config.setdefault("ingress", {}).setdefault("nginx", {})["dedicatedIP"] = value
        self.config_changed.emit()

    @property
    def ingress_cilium_enabled(self):
        return bool(self._config.get("ingress", {}).get("cilium", {}).get("dedicatedIP", ""))

    def set_ingress_cilium_enabled(self, enabled):
        # Cilium ingress presence is implied by having a dedicated IP or by CNI choice
        self.config_changed.emit()

    @property
    def ingress_cilium_default(self):
        return not self.ingress_nginx_default

    def set_ingress_cilium_default(self, is_default):
        self._config.setdefault("ingress", {}).setdefault("nginx", {})["isDefault"] = not is_default
        self.config_changed.emit()

    @property
    def ingress_cilium_dedicated_ip(self):
        return self._config.get("ingress", {}).get("cilium", {}).get("dedicatedIP", "")

    def set_ingress_cilium_dedicated_ip(self, value):
        self._config.setdefault("ingress", {}).setdefault("cilium", {})["dedicatedIP"] = value
        self.config_changed.emit()

    # --- Disk layout (attended mode) ---
    @property
    def disk_layout_applied(self):
        return self._disk_layout_applied

    def set_disk_layout_applied(self, applied):
        self._disk_layout_applied = applied

    @property
    def disk_layout_kickstart(self):
        return self._disk_layout_kickstart

    def set_disk_layout_kickstart(self, ks):
        self._disk_layout_kickstart = ks

    # --- Backup/restore ---
    @property
    def backup_archive_path(self):
        return self._backup_archive_path

    def set_backup_archive_path(self, path):
        self._backup_archive_path = path
        self.config_changed.emit()

    @property
    def restore_enabled(self):
        return self._restore_enabled

    def set_restore_enabled(self, enabled):
        self._restore_enabled = enabled
        self.config_changed.emit()

    def configure_with_tasks(self):
        """Return configuration tasks (run at start of installation)."""
        return [K4AllConfigurationTask()]

    def install_with_tasks(self):
        """Return installation tasks (run at end of installation)."""
        task = K4AllInstallationTask(
            sysroot=conf.target.system_root,
            role=self._role,
            cluster_config=self._config,
            install_config=self._install_config,
            backup_archive_path=self._backup_archive_path,
            restore_enabled=self._restore_enabled
        )
        return [task]
