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

    @property
    def ApiEndPointUseHostName(self) -> Str:
        """API endpoint hostname mode (false/true/short)."""
        return self.implementation.api_endpoint_use_hostname

    @emits_properties_changed
    def SetApiEndPointUseHostName(self, value: Str):
        """Set API endpoint hostname mode."""
        self.implementation.set_api_endpoint_use_hostname(value)

    @property
    def CustomApiEndPoint(self) -> Str:
        """Custom API endpoint."""
        return self.implementation.custom_api_endpoint

    @emits_properties_changed
    def SetCustomApiEndPoint(self, value: Str):
        """Set custom API endpoint."""
        self.implementation.set_custom_api_endpoint(value)

    @property
    def PodNetwork(self) -> Str:
        """Pod network CIDR (e.g. 10.100.0.1/18)."""
        return self.implementation.pod_network

    @emits_properties_changed
    def SetPodNetwork(self, value: Str):
        """Set the pod network CIDR."""
        self.implementation.set_pod_network(value)

    @property
    def ServiceNetwork(self) -> Str:
        """Service network CIDR (e.g. 10.96.0.0/16)."""
        return self.implementation.service_network

    @emits_properties_changed
    def SetServiceNetwork(self, value: Str):
        """Set the service network CIDR."""
        self.implementation.set_service_network(value)

    @property
    def ApiControlEndpoint(self) -> Str:
        """HA control plane VIP address."""
        return self.implementation.api_control_endpoint

    @emits_properties_changed
    def SetApiControlEndpoint(self, value: Str):
        """Set HA control plane VIP address."""
        self.implementation.set_api_control_endpoint(value)

    @property
    def ApiControlEndpointSubnetSize(self) -> Str:
        """HA control plane VIP subnet size (e.g. 24)."""
        return self.implementation.api_control_endpoint_subnet_size

    @emits_properties_changed
    def SetApiControlEndpointSubnetSize(self, value: Str):
        """Set HA control plane VIP subnet size."""
        self.implementation.set_api_control_endpoint_subnet_size(value)

    # Cilium-specific options (bootstrap only, when CNI == cilium)
    @property
    def CiliumAdditionalDevices(self) -> Str:
        """Additional network devices for Cilium (comma-separated)."""
        return self.implementation.cilium_additional_devices

    @emits_properties_changed
    def SetCiliumAdditionalDevices(self, value: Str):
        """Set additional Cilium devices."""
        self.implementation.set_cilium_additional_devices(value)

    @property
    def CiliumGatewayApi(self) -> Bool:
        """Whether Cilium Gateway API is enabled."""
        return self.implementation.cilium_gateway_api

    @emits_properties_changed
    def SetCiliumGatewayApi(self, enabled: Bool):
        """Enable or disable Cilium Gateway API."""
        self.implementation.set_cilium_gateway_api(enabled)

    @property
    def CiliumL2Announcements(self) -> Bool:
        """Whether Cilium L2 Announcements are enabled."""
        return self.implementation.cilium_l2_announcements

    @emits_properties_changed
    def SetCiliumL2Announcements(self, enabled: Bool):
        """Enable or disable Cilium L2 Announcements."""
        self.implementation.set_cilium_l2_announcements(enabled)

    @property
    def CiliumHubble(self) -> Bool:
        """Whether Cilium Hubble UI is enabled."""
        return self.implementation.cilium_hubble

    @emits_properties_changed
    def SetCiliumHubble(self, enabled: Bool):
        """Enable or disable Cilium Hubble."""
        self.implementation.set_cilium_hubble(enabled)

    # --- Ingress configuration ---

    @property
    def IngressNginxEnabled(self) -> Bool:
        return self.implementation.ingress_nginx_enabled

    @emits_properties_changed
    def SetIngressNginxEnabled(self, enabled: Bool):
        self.implementation.set_ingress_nginx_enabled(enabled)

    @property
    def IngressNginxDefault(self) -> Bool:
        return self.implementation.ingress_nginx_default

    @emits_properties_changed
    def SetIngressNginxDefault(self, is_default: Bool):
        self.implementation.set_ingress_nginx_default(is_default)

    @property
    def IngressNginxDedicatedIP(self) -> Str:
        return self.implementation.ingress_nginx_dedicated_ip

    @emits_properties_changed
    def SetIngressNginxDedicatedIP(self, value: Str):
        self.implementation.set_ingress_nginx_dedicated_ip(value)

    @property
    def IngressCiliumEnabled(self) -> Bool:
        return self.implementation.ingress_cilium_enabled

    @emits_properties_changed
    def SetIngressCiliumEnabled(self, enabled: Bool):
        self.implementation.set_ingress_cilium_enabled(enabled)

    @property
    def IngressCiliumDefault(self) -> Bool:
        return self.implementation.ingress_cilium_default

    @emits_properties_changed
    def SetIngressCiliumDefault(self, is_default: Bool):
        self.implementation.set_ingress_cilium_default(is_default)

    @property
    def IngressCiliumDedicatedIP(self) -> Str:
        return self.implementation.ingress_cilium_dedicated_ip

    @emits_properties_changed
    def SetIngressCiliumDedicatedIP(self, value: Str):
        self.implementation.set_ingress_cilium_dedicated_ip(value)

    # --- Disk layout (attended mode) ---

    @property
    def DiskLayoutApplied(self) -> Bool:
        return self.implementation.disk_layout_applied

    @emits_properties_changed
    def SetDiskLayoutApplied(self, applied: Bool):
        self.implementation.set_disk_layout_applied(applied)

    @property
    def DiskLayoutKickstart(self) -> Str:
        return self.implementation.disk_layout_kickstart

    @emits_properties_changed
    def SetDiskLayoutKickstart(self, ks: Str):
        self.implementation.set_disk_layout_kickstart(ks)

    # --- Backup/restore ---

    @property
    def BackupArchivePath(self) -> Str:
        return self.implementation.backup_archive_path

    @emits_properties_changed
    def SetBackupArchivePath(self, path: Str):
        self.implementation.set_backup_archive_path(path)

    @property
    def RestoreEnabled(self) -> Bool:
        return self.implementation.restore_enabled

    @emits_properties_changed
    def SetRestoreEnabled(self, enabled: Bool):
        self.implementation.set_restore_enabled(enabled)

