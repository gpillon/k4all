# K4All Anaconda Addon - GUI Spoke
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""K4All configuration spoke for Anaconda's graphical interface."""

import logging

from pyanaconda.ui.gui.spokes import NormalSpoke
from pyanaconda.ui.common import FirstbootSpokeMixIn

from com_k4all_installer.categories.k4all import K4AllCategory
from com_k4all_installer.constants import K4ALL

log = logging.getLogger(__name__)

__all__ = ["K4AllSpoke"]

_ = lambda x: x
N_ = lambda x: x


class K4AllSpoke(FirstbootSpokeMixIn, NormalSpoke):
    """K4All configuration spoke for the graphical installer.
    
    This spoke allows users to configure:
    - Node role (bootstrap/control/worker)
    - CNI plugin (calico/cilium)
    - HA type (none/keepalived/kubevip)
    - Features (virt, argocd)
    - Firewall settings
    """

    # List top-level objects from the .glade file
    builderObjects = ["k4allSpokeWindow"]

    # Name of the main window widget
    mainWidgetName = "k4allSpokeWindow"

    # Name of the .glade file
    uiFile = "k4all.glade"

    # Category this spoke belongs to
    category = K4AllCategory

    # Icon for the spoke (displayed on the hub)
    icon = "network-server-symbolic"

    # Title of the spoke
    title = N_("_K4All Kubernetes")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._k4all_module = K4ALL.get_proxy()

    def initialize(self):
        """Initialize the spoke."""
        super().initialize()
        
        # Get UI elements
        self._role_combo = self.builder.get_object("roleComboBox")
        self._cni_combo = self.builder.get_object("cniComboBox")
        self._ha_combo = self.builder.get_object("haComboBox")
        self._virt_check = self.builder.get_object("virtCheckButton")
        self._argocd_check = self.builder.get_object("argocdCheckButton")
        self._firewalld_check = self.builder.get_object("firewalldCheckButton")

    def refresh(self):
        """Refresh the spoke with current values from the D-Bus module."""
        # Role
        role = self._k4all_module.Role
        role_map = {"bootstrap": 0, "control": 1, "worker": 2}
        self._role_combo.set_active(role_map.get(role, 0))

        # CNI
        cni = self._k4all_module.CniType
        cni_map = {"calico": 0, "cilium": 1}
        self._cni_combo.set_active(cni_map.get(cni, 0))

        # HA
        ha = self._k4all_module.HaType
        ha_map = {"none": 0, "keepalived": 1, "kubevip": 2}
        self._ha_combo.set_active(ha_map.get(ha, 0))

        # Features
        self._virt_check.set_active(self._k4all_module.VirtEnabled)
        self._argocd_check.set_active(self._k4all_module.ArgocdEnabled)
        self._firewalld_check.set_active(self._k4all_module.FirewalldEnabled)

    def apply(self):
        """Apply the spoke values to the D-Bus module."""
        # Role
        role_map = {0: "bootstrap", 1: "control", 2: "worker"}
        role = role_map.get(self._role_combo.get_active(), "bootstrap")
        self._k4all_module.SetRole(role)

        # CNI
        cni_map = {0: "calico", 1: "cilium"}
        cni = cni_map.get(self._cni_combo.get_active(), "calico")
        self._k4all_module.SetCniType(cni)

        # HA
        ha_map = {0: "none", 1: "keepalived", 2: "kubevip"}
        ha = ha_map.get(self._ha_combo.get_active(), "none")
        self._k4all_module.SetHaType(ha)

        # Features
        self._k4all_module.SetVirtEnabled(self._virt_check.get_active())
        self._k4all_module.SetArgocdEnabled(self._argocd_check.get_active())
        self._k4all_module.SetFirewalldEnabled(self._firewalld_check.get_active())

    def execute(self):
        """Execute any runtime changes (not needed for K4All)."""
        pass

    @property
    def ready(self):
        """The spoke is always ready."""
        return True

    @property
    def completed(self):
        """The spoke is completed when a role is selected."""
        return bool(self._k4all_module.Role)

    @property
    def mandatory(self):
        """The spoke is mandatory - must select a role."""
        return True

    @property
    def status(self):
        """Brief string describing the spoke state."""
        role = self._k4all_module.Role
        cni = self._k4all_module.CniType
        ha = self._k4all_module.HaType
        
        status_parts = [f"Role: {role}", f"CNI: {cni}"]
        if ha != "none":
            status_parts.append(f"HA: {ha}")
        
        features = []
        if self._k4all_module.VirtEnabled:
            features.append("virt")
        if self._k4all_module.ArgocdEnabled:
            features.append("argocd")
        if features:
            status_parts.append(f"Features: {', '.join(features)}")
        
        return " | ".join(status_parts)

