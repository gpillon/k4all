# K4All Anaconda Addon - TUI Spoke
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""K4All configuration spoke for Anaconda's text user interface."""

import logging

from simpleline.render.prompt import Prompt
from simpleline.render.screen import InputState
from simpleline.render.containers import ListColumnContainer
from simpleline.render.widgets import CheckboxWidget, EntryWidget

from pyanaconda.ui.tui.spokes import NormalTUISpoke
from pyanaconda.ui.common import FirstbootSpokeMixIn

from com_k4all_installer.categories.k4all import K4AllCategory
from com_k4all_installer.constants import K4ALL, VALID_ROLES, VALID_CNI_TYPES, VALID_HA_TYPES

log = logging.getLogger(__name__)

__all__ = ["K4AllSpoke"]

_ = lambda x: x
N_ = lambda x: x


class K4AllSpoke(FirstbootSpokeMixIn, NormalTUISpoke):
    """K4All configuration spoke for the text installer.
    
    This spoke allows users to configure:
    - Node role (bootstrap/control/worker)
    - CNI plugin (calico/cilium)  
    - HA type (none/keepalived/kubevip)
    - Features (virt, argocd)
    - Firewall settings
    """

    category = K4AllCategory

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.title = N_("K4All Kubernetes")
        self._k4all_module = K4ALL.get_proxy()
        self._container = None
        
        # Local state
        self._role = "bootstrap"
        self._cni = "calico"
        self._ha = "none"
        self._virt = False
        self._argocd = False
        self._firewalld = False

    def initialize(self):
        """Initialize the spoke."""
        super().initialize()

    def setup(self, args=None):
        """Set up the spoke with current values from D-Bus module."""
        super().setup(args)
        
        self._role = self._k4all_module.Role
        self._cni = self._k4all_module.CniType
        self._ha = self._k4all_module.HaType
        self._virt = self._k4all_module.VirtEnabled
        self._argocd = self._k4all_module.ArgocdEnabled
        self._firewalld = self._k4all_module.FirewalldEnabled
        
        return True

    def refresh(self, args=None):
        """Refresh the spoke UI."""
        super().refresh(args)

        self._container = ListColumnContainer(columns=1)
        
        # Node Role selection
        self._container.add(
            EntryWidget(
                title=_("Node Role"),
                value=self._role
            ),
            callback=self._change_role
        )
        
        # CNI selection
        self._container.add(
            EntryWidget(
                title=_("CNI Plugin"),
                value=self._cni
            ),
            callback=self._change_cni
        )
        
        # HA selection
        self._container.add(
            EntryWidget(
                title=_("High Availability"),
                value=self._ha
            ),
            callback=self._change_ha
        )
        
        # Features
        self._container.add(
            CheckboxWidget(
                title=_("Enable KubeVirt (virtualization)"),
                completed=self._virt
            ),
            callback=self._toggle_virt
        )
        
        self._container.add(
            CheckboxWidget(
                title=_("Enable ArgoCD (GitOps)"),
                completed=self._argocd
            ),
            callback=self._toggle_argocd
        )
        
        self._container.add(
            CheckboxWidget(
                title=_("Enable firewalld"),
                completed=self._firewalld
            ),
            callback=self._toggle_firewalld
        )

        self.window.add_with_separator(self._container)

    def apply(self):
        """Apply values to D-Bus module."""
        self._k4all_module.SetRole(self._role)
        self._k4all_module.SetCniType(self._cni)
        self._k4all_module.SetHaType(self._ha)
        self._k4all_module.SetVirtEnabled(self._virt)
        self._k4all_module.SetArgocdEnabled(self._argocd)
        self._k4all_module.SetFirewalldEnabled(self._firewalld)

    def execute(self):
        """Execute runtime changes (not needed)."""
        pass

    @property
    def completed(self):
        """Spoke is completed when role is set."""
        return bool(self._k4all_module.Role)

    @property
    def status(self):
        """Brief status string."""
        role = self._k4all_module.Role
        cni = self._k4all_module.CniType
        ha = self._k4all_module.HaType
        
        status = f"Role: {role}, CNI: {cni}"
        if ha != "none":
            status += f", HA: {ha}"
        
        features = []
        if self._k4all_module.VirtEnabled:
            features.append("virt")
        if self._k4all_module.ArgocdEnabled:
            features.append("argocd")
        if features:
            status += f", Features: {', '.join(features)}"
        
        return status

    @property
    def mandatory(self):
        """The spoke is mandatory."""
        return True

    def input(self, args, key):
        """Handle user input."""
        if self._container.process_user_input(key):
            return InputState.PROCESSED_AND_REDRAW

        if key.lower() == Prompt.CONTINUE:
            self.apply()
            self.execute()
            return InputState.PROCESSED_AND_CLOSE

        return super().input(args, key)

    def _change_role(self, data):
        """Cycle through roles."""
        roles = list(VALID_ROLES)
        try:
            idx = roles.index(self._role)
            self._role = roles[(idx + 1) % len(roles)]
        except ValueError:
            self._role = roles[0]

    def _change_cni(self, data):
        """Cycle through CNI options."""
        cnis = list(VALID_CNI_TYPES)
        try:
            idx = cnis.index(self._cni)
            self._cni = cnis[(idx + 1) % len(cnis)]
        except ValueError:
            self._cni = cnis[0]

    def _change_ha(self, data):
        """Cycle through HA options."""
        has = list(VALID_HA_TYPES)
        try:
            idx = has.index(self._ha)
            self._ha = has[(idx + 1) % len(has)]
        except ValueError:
            self._ha = has[0]

    def _toggle_virt(self, data):
        """Toggle virt checkbox."""
        self._virt = not self._virt

    def _toggle_argocd(self, data):
        """Toggle argocd checkbox."""
        self._argocd = not self._argocd

    def _toggle_firewalld(self, data):
        """Toggle firewalld checkbox."""
        self._firewalld = not self._firewalld

