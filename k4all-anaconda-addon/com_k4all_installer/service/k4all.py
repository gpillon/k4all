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
        
        # Node role
        self._role = "bootstrap"
        
        # Full configuration dict
        self._config = copy.deepcopy(DEFAULT_CONFIG)
        
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

    def configure_with_tasks(self):
        """Return configuration tasks (run at start of installation)."""
        task = K4AllConfigurationTask()
        return [task]

    def install_with_tasks(self):
        """Return installation tasks (run at end of installation)."""
        task = K4AllInstallationTask(
            sysroot=conf.target.system_root,
            role=self._role,
            config=self._config
        )
        return [task]

