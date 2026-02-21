# K4All Anaconda Addon - D-Bus Interface
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""The D-Bus interface for the K4All addon."""

import logging
import json

from dasbus.server.interface import dbus_interface
from dasbus.server.property import emits_properties_changed
from dasbus.typing import Str, Bool

from pyanaconda.modules.common.base import KickstartModuleInterface

from com_k4all_installer.constants import K4ALL

log = logging.getLogger(__name__)


@dbus_interface(K4ALL.interface_name)
class K4AllInterface(KickstartModuleInterface):
    """The D-Bus interface for K4All.

    This interface exposes the K4All configuration to Anaconda's UI.
    """

    def connect_signals(self):
        super().connect_signals()
        self.watch_property("Role", self.implementation.role_changed)
        self.watch_property("ConfigJSON", self.implementation.config_changed)

    # Role property
    @property
    def Role(self) -> Str:
        """The node role (bootstrap/control/worker)."""
        return self.implementation.role

    @emits_properties_changed
    def SetRole(self, role: Str):
        """Set the node role."""
        self.implementation.set_role(role)

    # Config as JSON string (for D-Bus transport)
    @property
    def ConfigJSON(self) -> Str:
        """The full configuration as JSON string."""
        return json.dumps(self.implementation.config)

    @emits_properties_changed
    def SetConfigJSON(self, config_json: Str):
        """Set the configuration from JSON string."""
        config = json.loads(config_json)
        self.implementation.set_config(config)

    # Convenience properties for common options
    @property
    def CniType(self) -> Str:
        """The CNI plugin type (calico/cilium)."""
        return self.implementation.cni_type

    @emits_properties_changed
    def SetCniType(self, cni_type: Str):
        """Set the CNI plugin type."""
        self.implementation.set_cni_type(cni_type)

    @property
    def HaType(self) -> Str:
        """The HA type (none/keepalived/kubevip)."""
        return self.implementation.ha_type

    @emits_properties_changed
    def SetHaType(self, ha_type: Str):
        """Set the HA type."""
        self.implementation.set_ha_type(ha_type)

    @property
    def VirtEnabled(self) -> Bool:
        """Whether KubeVirt is enabled."""
        return self.implementation.virt_enabled

    @emits_properties_changed
    def SetVirtEnabled(self, enabled: Bool):
        """Enable or disable KubeVirt."""
        self.implementation.set_virt_enabled(enabled)

    @property
    def ArgocdEnabled(self) -> Bool:
        """Whether ArgoCD is enabled."""
        return self.implementation.argocd_enabled

    @emits_properties_changed
    def SetArgocdEnabled(self, enabled: Bool):
        """Enable or disable ArgoCD."""
        self.implementation.set_argocd_enabled(enabled)

    @property
    def FirewalldEnabled(self) -> Bool:
        """Whether firewalld is enabled."""
        return self.implementation.firewalld_enabled

    @emits_properties_changed
    def SetFirewalldEnabled(self, enabled: Bool):
        """Enable or disable firewalld."""
        self.implementation.set_firewalld_enabled(enabled)

