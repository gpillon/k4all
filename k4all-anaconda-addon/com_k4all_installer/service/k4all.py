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

from com_k4all_installer.constants import K4ALL, DEFAULT_CONFIG
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
        
        # Node role (empty = not yet configured)
        self._role = ""
        
        # Full configuration dict
        self._config = copy.deepcopy(DEFAULT_CONFIG)
        
        # Disk layout (attended mode)
        self._disk_layout_applied = False
        self._disk_layout_kickstart = ""
        
        # Backup/restore
        self._backup_archive_path = ""
        self._restore_enabled = False
        
        # Signals for property changes
        self.role_changed = Signal()
        self.config_changed = Signal()

    def publish(self):
        """Publish the module."""
        TaskContainer.set_namespace(K4ALL.namespace)
        DBus.publish_object(K4ALL.object_path, K4AllInterface(self))
        DBus.register_service(K4ALL.service_name)

    @property
    def kickstart_specification(self):
        """Return the kickstart specification."""
        return K4AllKickstartSpecification

    def process_kickstart(self, data):
        """Process the kickstart data."""
        log.debug("Processing K4All kickstart data...")
        addon_data = data.addons.com_k4all_installer
        
        # Finalize to parse JSON body
        addon_data.finalize()
        
        self._role = addon_data.role
        self._config = addon_data.config
        
        log.info("K4All kickstart: role=%s, cni=%s, ha=%s",
                 self._role,
                 self._config["networking"]["cni"]["type"],
                 self._config["cluster"]["ha"]["type"])

    def setup_kickstart(self, data):
        """Set the given kickstart data."""
        log.debug("Generating K4All kickstart data...")
        addon_data = data.addons.com_k4all_installer
        addon_data.role = self._role
        addon_data.config = self._config

    # Properties for role
    @property
    def role(self):
        """The node role (bootstrap/control/worker)."""
        return self._role

    def set_role(self, role):
        self._role = role
        self.role_changed.emit()
        log.debug("Role set to %s", role)

    # Properties for config
    @property
    def config(self):
        """The full K4All configuration dict."""
        return self._config

    def set_config(self, config):
        self._config = config
        self.config_changed.emit()
        log.debug("Config updated")

    # Convenience methods for common config options
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
        return self._config["features"]["virt"]["enabled"] == "true"

    def set_virt_enabled(self, enabled):
        self._config["features"]["virt"]["enabled"] = "true" if enabled else "false"
        self.config_changed.emit()

    @property
    def argocd_enabled(self):
        return self._config["features"]["argocd"]["enabled"] == "true"

    def set_argocd_enabled(self, enabled):
        self._config["features"]["argocd"]["enabled"] = "true" if enabled else "false"
        self.config_changed.emit()

    @property
    def firewalld_enabled(self):
        return self._config["networking"]["firewalld"]["enabled"] == "true"

    def set_firewalld_enabled(self, enabled):
        self._config["networking"]["firewalld"]["enabled"] = "true" if enabled else "false"
        self.config_changed.emit()

    @property
    def api_endpoint_use_hostname(self):
        return self._config["cluster"].get("apiEndPointUseHostName", "false")

    def set_api_endpoint_use_hostname(self, value):
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

    @property
    def cilium_additional_devices(self):
        return self._config.get("cni", {}).get("cilium", {}).get("additionalDevices", "")

    def set_cilium_additional_devices(self, value):
        self._config.setdefault("cni", {}).setdefault("cilium", {})["additionalDevices"] = value
        self.config_changed.emit()

    @property
    def cilium_gateway_api(self):
        return self._config.get("cni", {}).get("cilium", {}).get("gatewayApi", "false") == "true"

    def set_cilium_gateway_api(self, enabled):
        self._config.setdefault("cni", {}).setdefault("cilium", {})["gatewayApi"] = "true" if enabled else "false"
        self.config_changed.emit()

    @property
    def cilium_l2_announcements(self):
        return self._config.get("cni", {}).get("cilium", {}).get("l2announcements", "false") == "true"

    def set_cilium_l2_announcements(self, enabled):
        self._config.setdefault("cni", {}).setdefault("cilium", {})["l2announcements"] = "true" if enabled else "false"
        self.config_changed.emit()

    @property
    def cilium_hubble(self):
        return self._config.get("cni", {}).get("cilium", {}).get("hubble", "false") == "true"

    def set_cilium_hubble(self, enabled):
        self._config.setdefault("cni", {}).setdefault("cilium", {})["hubble"] = "true" if enabled else "false"
        self.config_changed.emit()

    # --- Ingress configuration ---

    def _ingress(self):
        return self._config.setdefault("ingress", {})

    @property
    def ingress_nginx_enabled(self):
        return self._config.get("ingress", {}).get("nginx", {}).get("enabled", "true") == "true"

    def set_ingress_nginx_enabled(self, enabled):
        self._ingress().setdefault("nginx", {})["enabled"] = "true" if enabled else "false"
        self.config_changed.emit()

    @property
    def ingress_nginx_default(self):
        return self._config.get("ingress", {}).get("nginx", {}).get("isDefault", "true") == "true"

    def set_ingress_nginx_default(self, is_default):
        self._ingress().setdefault("nginx", {})["isDefault"] = "true" if is_default else "false"
        self.config_changed.emit()

    @property
    def ingress_nginx_dedicated_ip(self):
        return self._config.get("ingress", {}).get("nginx", {}).get("dedicatedIP", "")

    def set_ingress_nginx_dedicated_ip(self, value):
        self._ingress().setdefault("nginx", {})["dedicatedIP"] = value
        self.config_changed.emit()

    @property
    def ingress_cilium_enabled(self):
        return self._config.get("ingress", {}).get("cilium", {}).get("enabled", "false") == "true"

    def set_ingress_cilium_enabled(self, enabled):
        self._ingress().setdefault("cilium", {})["enabled"] = "true" if enabled else "false"
        self.config_changed.emit()

    @property
    def ingress_cilium_default(self):
        return self._config.get("ingress", {}).get("cilium", {}).get("isDefault", "false") == "true"

    def set_ingress_cilium_default(self, is_default):
        self._ingress().setdefault("cilium", {})["isDefault"] = "true" if is_default else "false"
        self.config_changed.emit()

    @property
    def ingress_cilium_dedicated_ip(self):
        return self._config.get("ingress", {}).get("cilium", {}).get("dedicatedIP", "")

    def set_ingress_cilium_dedicated_ip(self, value):
        self._ingress().setdefault("cilium", {})["dedicatedIP"] = value
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
        task = K4AllConfigurationTask()
        return [task]

    def install_with_tasks(self):
        """Return installation tasks (run at end of installation)."""
        task = K4AllInstallationTask(
            sysroot=conf.target.system_root,
            role=self._role,
            config=self._config,
            backup_archive_path=self._backup_archive_path,
            restore_enabled=self._restore_enabled
        )
        return [task]

