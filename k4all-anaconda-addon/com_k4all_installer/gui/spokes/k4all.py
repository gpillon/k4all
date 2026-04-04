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
    """K4All configuration spoke for the graphical installer."""

    builderObjects = ["k4allSpokeWindow"]
    mainWidgetName = "k4allSpokeWindow"
    uiFile = "k4all.glade"
    category = K4AllCategory
    icon = "network-server-symbolic"
    title = N_("_K4All Kubernetes")

    _ROLE_IDX = {"": -1, "bootstrap": 1, "control": 2, "worker": 3}
    _IDX_ROLE = {0: "", 1: "bootstrap", 2: "control", 3: "worker"}

    _API_HOST_IDX = {"false": 0, "true": 1, "short": 2}
    _IDX_API_HOST = {0: "false", 1: "true", 2: "short"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._k4all_module = None
        try:
            self._k4all_module = K4ALL.get_proxy()
            log.info("K4All spoke: D-Bus proxy acquired successfully")
        except Exception:
            log.error("K4All spoke: failed to get D-Bus proxy", exc_info=True)

    def initialize(self):
        super().initialize()
        log.info("K4All spoke: initializing GUI widgets")

        self._role_combo = self.builder.get_object("roleComboBox")
        self._cni_combo = self.builder.get_object("cniComboBox")
        self._ha_combo = self.builder.get_object("haComboBox")
        self._virt_check = self.builder.get_object("virtCheckButton")
        self._argocd_check = self.builder.get_object("argocdCheckButton")
        self._firewalld_check = self.builder.get_object("firewalldCheckButton")
        self._api_hostname_combo = self.builder.get_object("apiHostnameComboBox")
        self._custom_endpoint_entry = self.builder.get_object("customEndpointEntry")
        self._cluster_frame = self.builder.get_object("clusterSettingsFrame")
        self._ha_frame = self.builder.get_object("haSettingsFrame")
        self._api_control_ep_entry = self.builder.get_object("apiControlEndpointEntry")
        self._api_control_subnet_entry = self.builder.get_object("apiControlEndpointSubnetEntry")
        self._network_frame = self.builder.get_object("networkSettingsFrame")
        self._pod_network_entry = self.builder.get_object("podNetworkEntry")
        self._service_network_entry = self.builder.get_object("serviceNetworkEntry")
        self._cilium_frame = self.builder.get_object("ciliumOptionsFrame")
        self._cilium_devices_entry = self.builder.get_object("ciliumDevicesEntry")
        self._cilium_gateway_check = self.builder.get_object("ciliumGatewayApiCheck")
        self._cilium_l2_check = self.builder.get_object("ciliumL2AnnouncementsCheck")
        self._cilium_hubble_check = self.builder.get_object("ciliumHubbleCheck")

        # Ingress widgets
        self._ingress_frame = self.builder.get_object("ingressFrame")
        self._ingress_nginx_check = self.builder.get_object("ingressNginxCheck")
        self._ingress_nginx_ip = self.builder.get_object("ingressNginxIpEntry")
        self._ingress_cilium_check = self.builder.get_object("ingressCiliumCheck")
        self._ingress_cilium_ip = self.builder.get_object("ingressCiliumIpEntry")
        self._ingress_default_label = self.builder.get_object("ingressDefaultLabel")
        self._ingress_default_combo = self.builder.get_object("ingressDefaultCombo")
        self._ingress_l2_info = self.builder.get_object("ingressL2InfoLabel")

        if self._role_combo:
            self._role_combo.connect("changed", self._on_role_changed)
        if self._ha_combo:
            self._ha_combo.connect("changed", self._on_ha_changed)
        if self._cni_combo:
            self._cni_combo.connect("changed", self._on_cni_changed)
        if self._cilium_l2_check:
            self._cilium_l2_check.connect("toggled", self._on_ingress_state_changed)
        if self._ingress_nginx_check:
            self._ingress_nginx_check.connect("toggled", self._on_ingress_state_changed)
        if self._ingress_cilium_check:
            self._ingress_cilium_check.connect("toggled", self._on_ingress_state_changed)

        self._update_role_dependent_widgets("")

    # --- Helpers ---

    def _current_role(self):
        return self._IDX_ROLE.get(self._role_combo.get_active(), "") if self._role_combo else ""

    def _current_cni(self):
        cni_map = {0: "calico", 1: "cilium"}
        return cni_map.get(self._cni_combo.get_active(), "calico") if self._cni_combo else "calico"

    def _current_ha(self):
        ha_map = {0: "none", 1: "keepalived", 2: "kubevip"}
        return ha_map.get(self._ha_combo.get_active(), "none") if self._ha_combo else "none"

    # --- Signal handlers ---

    def _on_role_changed(self, combo):
        self._update_role_dependent_widgets(self._current_role())

    def _on_ha_changed(self, combo):
        role = self._current_role()
        ha = self._current_ha()
        if self._ha_frame:
            self._ha_frame.set_visible(role == "bootstrap" and ha != "none")

    def _on_cni_changed(self, combo):
        role = self._current_role()
        cni = self._current_cni()
        is_cilium = cni == "cilium"
        is_bootstrap = role == "bootstrap"
        if self._cilium_frame:
            self._cilium_frame.set_visible(is_bootstrap and is_cilium)
        if self._ingress_cilium_check:
            self._ingress_cilium_check.set_sensitive(is_cilium)
            if not is_cilium:
                self._ingress_cilium_check.set_active(False)
        self._enforce_firewalld_for_cni(cni)
        self._update_ingress_widgets()

    def _enforce_firewalld_for_cni(self, cni):
        """Cilium requires firewalld to be disabled."""
        if self._firewalld_check:
            if cni == "cilium":
                self._firewalld_check.set_active(False)
                self._firewalld_check.set_sensitive(False)
            else:
                self._firewalld_check.set_sensitive(True)

    def _on_ingress_state_changed(self, widget):
        self._update_ingress_widgets()

    def _update_ingress_widgets(self):
        """Update ingress frame sub-widgets based on current state."""
        nginx_on = self._ingress_nginx_check.get_active() if self._ingress_nginx_check else True
        cilium_on = self._ingress_cilium_check.get_active() if self._ingress_cilium_check else False
        both = nginx_on and cilium_on

        if self._ingress_nginx_ip:
            self._ingress_nginx_ip.set_sensitive(nginx_on)
        if self._ingress_cilium_ip:
            self._ingress_cilium_ip.set_sensitive(cilium_on)

        if self._ingress_default_combo:
            self._ingress_default_combo.set_visible(both)
        if self._ingress_default_label:
            self._ingress_default_label.set_visible(both)

        # L2 info label
        if self._ingress_l2_info:
            cni = self._current_cni()
            cilium_l2 = self._cilium_l2_check.get_active() if self._cilium_l2_check else False
            if cni == "cilium" and cilium_l2:
                self._ingress_l2_info.set_text(
                    "L2 Announcer: Cilium (MetalLB will NOT be installed)")
            else:
                self._ingress_l2_info.set_text(
                    "L2 Announcer: MetalLB (auto-installed when dedicated IPs are used)")

    def _update_role_dependent_widgets(self, role):
        is_bootstrap = role == "bootstrap"
        is_bootstrap_or_control = role in ("bootstrap", "control")

        if self._cni_combo:
            self._cni_combo.set_sensitive(is_bootstrap)
        if self._ha_combo:
            self._ha_combo.set_sensitive(is_bootstrap)
        if self._cluster_frame:
            self._cluster_frame.set_visible(is_bootstrap_or_control)
        if self._ha_frame:
            self._ha_frame.set_visible(is_bootstrap and self._current_ha() != "none")
        if self._network_frame:
            self._network_frame.set_visible(is_bootstrap)
        if self._cilium_frame:
            self._cilium_frame.set_visible(is_bootstrap and self._current_cni() == "cilium")
        if self._ingress_frame:
            self._ingress_frame.set_visible(is_bootstrap)

        self._enforce_firewalld_for_cni(self._current_cni())

        if is_bootstrap:
            is_cilium = self._current_cni() == "cilium"
            if self._ingress_cilium_check:
                self._ingress_cilium_check.set_sensitive(is_cilium)
                if not is_cilium:
                    self._ingress_cilium_check.set_active(False)
            self._update_ingress_widgets()

    # --- D-Bus safe read ---

    def _get_role(self):
        if self._k4all_module is None:
            return ""
        try:
            return self._k4all_module.Role
        except Exception:
            log.warning("K4All spoke: failed to read Role from D-Bus", exc_info=True)
            return ""

    # --- Lifecycle ---

    def refresh(self):
        if self._k4all_module is None:
            log.warning("K4All spoke: no D-Bus proxy, skipping refresh")
            return

        try:
            role = self._k4all_module.Role
            self._role_combo.set_active(max(self._ROLE_IDX.get(role, -1), 0))

            cni = self._k4all_module.CniType
            self._cni_combo.set_active({"calico": 0, "cilium": 1}.get(cni, 0))

            ha = self._k4all_module.HaType
            self._ha_combo.set_active({"none": 0, "keepalived": 1, "kubevip": 2}.get(ha, 0))

            self._virt_check.set_active(self._k4all_module.VirtEnabled)
            self._argocd_check.set_active(self._k4all_module.ArgocdEnabled)
            self._firewalld_check.set_active(self._k4all_module.FirewalldEnabled)

            self._api_hostname_combo.set_active(self._API_HOST_IDX.get(
                self._k4all_module.ApiEndPointUseHostName, 0))
            self._custom_endpoint_entry.set_text(self._k4all_module.CustomApiEndPoint)

            if self._api_control_ep_entry:
                self._api_control_ep_entry.set_text(self._k4all_module.ApiControlEndpoint)
            if self._api_control_subnet_entry:
                self._api_control_subnet_entry.set_text(self._k4all_module.ApiControlEndpointSubnetSize)
            if self._pod_network_entry:
                self._pod_network_entry.set_text(self._k4all_module.PodNetwork)
            if self._service_network_entry:
                self._service_network_entry.set_text(self._k4all_module.ServiceNetwork)

            # Cilium options
            if self._cilium_devices_entry:
                self._cilium_devices_entry.set_text(self._k4all_module.CiliumAdditionalDevices)
            if self._cilium_gateway_check:
                self._cilium_gateway_check.set_active(self._k4all_module.CiliumGatewayApi)
            if self._cilium_l2_check:
                self._cilium_l2_check.set_active(self._k4all_module.CiliumL2Announcements)
            if self._cilium_hubble_check:
                self._cilium_hubble_check.set_active(self._k4all_module.CiliumHubble)

            # Ingress
            if self._ingress_nginx_check:
                self._ingress_nginx_check.set_active(self._k4all_module.IngressNginxEnabled)
            if self._ingress_nginx_ip:
                self._ingress_nginx_ip.set_text(self._k4all_module.IngressNginxDedicatedIP)
            if self._ingress_cilium_check:
                self._ingress_cilium_check.set_active(self._k4all_module.IngressCiliumEnabled)
            if self._ingress_cilium_ip:
                self._ingress_cilium_ip.set_text(self._k4all_module.IngressCiliumDedicatedIP)
            if self._ingress_default_combo:
                self._ingress_default_combo.set_active(
                    1 if self._k4all_module.IngressCiliumDefault else 0)

            self._update_role_dependent_widgets(role)
        except Exception:
            log.error("K4All spoke: error during refresh", exc_info=True)

    def apply(self):
        if self._k4all_module is None:
            return
        try:
            role = self._IDX_ROLE.get(self._role_combo.get_active(), "")
            self._k4all_module.SetRole(role)

            cni_map = {0: "calico", 1: "cilium"}
            self._k4all_module.SetCniType(cni_map.get(self._cni_combo.get_active(), "calico"))

            ha_map = {0: "none", 1: "keepalived", 2: "kubevip"}
            self._k4all_module.SetHaType(ha_map.get(self._ha_combo.get_active(), "none"))

            self._k4all_module.SetVirtEnabled(self._virt_check.get_active())
            self._k4all_module.SetArgocdEnabled(self._argocd_check.get_active())
            self._k4all_module.SetFirewalldEnabled(self._firewalld_check.get_active())

            self._k4all_module.SetApiEndPointUseHostName(
                self._IDX_API_HOST.get(self._api_hostname_combo.get_active(), "false"))
            self._k4all_module.SetCustomApiEndPoint(self._custom_endpoint_entry.get_text().strip())

            if self._api_control_ep_entry:
                self._k4all_module.SetApiControlEndpoint(self._api_control_ep_entry.get_text().strip())
            if self._api_control_subnet_entry:
                self._k4all_module.SetApiControlEndpointSubnetSize(self._api_control_subnet_entry.get_text().strip())
            if self._pod_network_entry:
                self._k4all_module.SetPodNetwork(self._pod_network_entry.get_text().strip())
            if self._service_network_entry:
                self._k4all_module.SetServiceNetwork(self._service_network_entry.get_text().strip())

            # Cilium
            if self._cilium_devices_entry:
                self._k4all_module.SetCiliumAdditionalDevices(self._cilium_devices_entry.get_text().strip())
            if self._cilium_gateway_check:
                self._k4all_module.SetCiliumGatewayApi(self._cilium_gateway_check.get_active())
            if self._cilium_l2_check:
                self._k4all_module.SetCiliumL2Announcements(self._cilium_l2_check.get_active())
            if self._cilium_hubble_check:
                self._k4all_module.SetCiliumHubble(self._cilium_hubble_check.get_active())

            # Ingress
            nginx_on = self._ingress_nginx_check.get_active() if self._ingress_nginx_check else True
            cilium_on = self._ingress_cilium_check.get_active() if self._ingress_cilium_check else False
            self._k4all_module.SetIngressNginxEnabled(nginx_on)
            self._k4all_module.SetIngressCiliumEnabled(cilium_on)

            default_idx = self._ingress_default_combo.get_active() if self._ingress_default_combo else 0
            if nginx_on and cilium_on:
                self._k4all_module.SetIngressNginxDefault(default_idx == 0)
                self._k4all_module.SetIngressCiliumDefault(default_idx == 1)
            elif nginx_on:
                self._k4all_module.SetIngressNginxDefault(True)
                self._k4all_module.SetIngressCiliumDefault(False)
            elif cilium_on:
                self._k4all_module.SetIngressNginxDefault(False)
                self._k4all_module.SetIngressCiliumDefault(True)

            if self._ingress_nginx_ip:
                self._k4all_module.SetIngressNginxDedicatedIP(self._ingress_nginx_ip.get_text().strip())
            if self._ingress_cilium_ip:
                self._k4all_module.SetIngressCiliumDedicatedIP(self._ingress_cilium_ip.get_text().strip())

        except Exception:
            log.error("K4All spoke: error during apply", exc_info=True)

    def execute(self):
        pass

    @property
    def ready(self):
        return True

    @property
    def completed(self):
        role = self._get_role()
        if role not in ("bootstrap", "control", "worker"):
            return False

        if self._k4all_module:
            try:
                ha = self._k4all_module.HaType
                if ha != "none":
                    vip = self._k4all_module.ApiControlEndpoint
                    subnet = self._k4all_module.ApiControlEndpointSubnetSize
                    if not vip or not subnet:
                        return False

                # Both ingress controllers can't use the same empty IP (cluster IP conflict on ports 80/443)
                if role == "bootstrap":
                    nginx_on = self._k4all_module.IngressNginxEnabled
                    cilium_on = self._k4all_module.IngressCiliumEnabled
                    if not nginx_on and not cilium_on:
                        return False
                    if nginx_on and cilium_on:
                        nginx_ip = self._k4all_module.IngressNginxDedicatedIP
                        cilium_ip = self._k4all_module.IngressCiliumDedicatedIP
                        if not nginx_ip and not cilium_ip:
                            return False
                        if nginx_ip and cilium_ip and nginx_ip == cilium_ip:
                            return False
            except Exception:
                pass

        return True

    @property
    def mandatory(self):
        return True

    @property
    def status(self):
        role = self._get_role()
        if not role or role not in ("bootstrap", "control", "worker"):
            return _("Not configured — select a node role")

        try:
            cni = self._k4all_module.CniType
            ha = self._k4all_module.HaType

            parts = [f"Role: {role}", f"CNI: {cni}"]
            if ha != "none":
                vip = self._k4all_module.ApiControlEndpoint
                subnet = self._k4all_module.ApiControlEndpointSubnetSize
                if vip and subnet:
                    parts.append(f"HA: {ha} (VIP: {vip}/{subnet})")
                else:
                    parts.append(f"HA: {ha} — VIP required!")

            if role == "bootstrap":
                nginx_on = self._k4all_module.IngressNginxEnabled
                cilium_on = self._k4all_module.IngressCiliumEnabled
                if nginx_on and cilium_on:
                    if not self._k4all_module.IngressNginxDedicatedIP and not self._k4all_module.IngressCiliumDedicatedIP:
                        parts.append("Ingress: CONFLICT — need dedicated IP!")
                    else:
                        parts.append("Ingress: nginx + cilium")
                elif nginx_on:
                    parts.append("Ingress: nginx")
                elif cilium_on:
                    parts.append("Ingress: cilium")
                else:
                    parts.append("Ingress: NONE — select at least one!")

            features = []
            if self._k4all_module.VirtEnabled:
                features.append("virt")
            if self._k4all_module.ArgocdEnabled:
                features.append("argocd")
            if features:
                parts.append(f"Features: {', '.join(features)}")

            return " | ".join(parts)
        except Exception:
            return f"Role: {role} (details unavailable)"
