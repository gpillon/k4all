# K4All Anaconda Addon - TUI Spoke
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""K4All configuration spoke for Anaconda's text user interface."""

import logging
import os
import json as _json
import tarfile

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

_API_HOST_VALUES = ("false", "true", "short")


class K4AllSpoke(FirstbootSpokeMixIn, NormalTUISpoke):
    """K4All configuration spoke for the text installer."""

    category = K4AllCategory

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.title = N_("K4All Kubernetes")
        self._k4all_module = None
        try:
            self._k4all_module = K4ALL.get_proxy()
            log.info("K4All TUI spoke: D-Bus proxy acquired")
        except Exception:
            log.error("K4All TUI spoke: failed to get D-Bus proxy", exc_info=True)
        self._container = None

        self._role = ""
        self._cni = "calico"
        self._ha = "none"
        self._virt = False
        self._argocd = False
        self._firewalld = False
        self._api_hostname = "false"
        self._custom_endpoint = ""
        self._api_control_ep = ""
        self._api_control_subnet = ""
        self._pod_network = "10.100.0.1/18"
        self._service_network = "10.96.0.0/16"
        self._cilium_devices = ""
        self._cilium_gateway = False
        self._cilium_l2 = False
        self._cilium_hubble = False
        # Ingress
        self._ingress_nginx = True
        self._ingress_nginx_ip = ""
        self._ingress_cilium = False
        self._ingress_cilium_ip = ""
        self._ingress_default = "nginx"
        # Backup/restore
        self._restore_enabled = False
        self._found_backups = []
        self._selected_backup_idx = -1

    def initialize(self):
        super().initialize()
        log.info("K4All TUI spoke: initialized")

    def setup(self, args=None):
        super().setup(args)
        if self._k4all_module is None:
            return True
        try:
            self._role = self._k4all_module.Role
            self._cni = self._k4all_module.CniType
            self._ha = self._k4all_module.HaType
            self._virt = self._k4all_module.VirtEnabled
            self._argocd = self._k4all_module.ArgocdEnabled
            self._firewalld = self._k4all_module.FirewalldEnabled
            self._api_hostname = self._k4all_module.ApiEndPointUseHostName
            self._custom_endpoint = self._k4all_module.CustomApiEndPoint
            self._api_control_ep = self._k4all_module.ApiControlEndpoint
            self._api_control_subnet = self._k4all_module.ApiControlEndpointSubnetSize
            self._pod_network = self._k4all_module.PodNetwork
            self._service_network = self._k4all_module.ServiceNetwork
            self._cilium_devices = self._k4all_module.CiliumAdditionalDevices
            self._cilium_gateway = self._k4all_module.CiliumGatewayApi
            self._cilium_l2 = self._k4all_module.CiliumL2Announcements
            self._cilium_hubble = self._k4all_module.CiliumHubble
            self._ingress_nginx = self._k4all_module.IngressNginxEnabled
            self._ingress_nginx_ip = self._k4all_module.IngressNginxDedicatedIP
            self._ingress_cilium = self._k4all_module.IngressCiliumEnabled
            self._ingress_cilium_ip = self._k4all_module.IngressCiliumDedicatedIP
            self._ingress_default = "cilium" if self._k4all_module.IngressCiliumDefault else "nginx"
            self._restore_enabled = self._k4all_module.RestoreEnabled
        except Exception:
            log.error("K4All TUI spoke: error during setup", exc_info=True)
        self._scan_for_backups()
        return True

    def refresh(self, args=None):
        super().refresh(args)
        self._container = ListColumnContainer(columns=1)

        self._container.add(
            EntryWidget(title=_("Node Role"),
                        value=self._role if self._role else _("(not configured)")),
            callback=self._change_role)

        if self._role == "bootstrap":
            self._container.add(
                EntryWidget(title=_("CNI Plugin"), value=self._cni),
                callback=self._change_cni)
            self._container.add(
                EntryWidget(title=_("High Availability"), value=self._ha),
                callback=self._change_ha)

        if self._role == "bootstrap" and self._ha != "none":
            self._container.add(
                EntryWidget(title=_("Control Plane VIP"),
                            value=self._api_control_ep if self._api_control_ep else _("(required!)")),
                callback=self._change_api_control_ep)
            self._container.add(
                EntryWidget(title=_("VIP Subnet Size"),
                            value=self._api_control_subnet if self._api_control_subnet else _("(required!)")),
                callback=self._change_api_control_subnet)

        if self._role == "bootstrap":
            self._container.add(
                EntryWidget(title=_("Pod Network CIDR"), value=self._pod_network),
                callback=self._change_pod_network)
            self._container.add(
                EntryWidget(title=_("Service Network CIDR"), value=self._service_network),
                callback=self._change_service_network)

        if self._role == "bootstrap" and self._cni == "cilium":
            self._container.add(
                EntryWidget(title=_("Cilium Additional Devices"),
                            value=self._cilium_devices if self._cilium_devices else _("(none)")),
                callback=self._change_cilium_devices)
            self._container.add(
                CheckboxWidget(title=_("Cilium Gateway API"), completed=self._cilium_gateway),
                callback=self._toggle_cilium_gateway)
            self._container.add(
                CheckboxWidget(title=_("Cilium L2 Announcements"), completed=self._cilium_l2),
                callback=self._toggle_cilium_l2)
            self._container.add(
                CheckboxWidget(title=_("Cilium Hubble (observability)"), completed=self._cilium_hubble),
                callback=self._toggle_cilium_hubble)

        # Ingress section (bootstrap only)
        if self._role == "bootstrap":
            self._container.add(
                CheckboxWidget(title=_("NGINX Ingress Controller"), completed=self._ingress_nginx),
                callback=self._toggle_ingress_nginx)
            if self._ingress_nginx:
                self._container.add(
                    EntryWidget(title=_("  NGINX Dedicated IP"),
                                value=self._ingress_nginx_ip if self._ingress_nginx_ip else _("(cluster IP)")),
                    callback=self._change_ingress_nginx_ip)

            if self._cni == "cilium":
                self._container.add(
                    CheckboxWidget(title=_("Cilium Ingress Controller"), completed=self._ingress_cilium),
                    callback=self._toggle_ingress_cilium)
                if self._ingress_cilium:
                    self._container.add(
                        EntryWidget(title=_("  Cilium Dedicated IP"),
                                    value=self._ingress_cilium_ip if self._ingress_cilium_ip else _("(cluster IP)")),
                        callback=self._change_ingress_cilium_ip)

            if self._ingress_nginx and self._ingress_cilium:
                self._container.add(
                    EntryWidget(title=_("Default Controller"), value=self._ingress_default),
                    callback=self._change_ingress_default)

        if self._role in ("bootstrap", "control"):
            self._container.add(
                EntryWidget(title=_("API endpoint hostname"), value=self._api_hostname),
                callback=self._change_api_hostname)
            self._container.add(
                EntryWidget(title=_("Custom API endpoint"),
                            value=self._custom_endpoint if self._custom_endpoint else _("(auto-detect)")),
                callback=self._change_custom_endpoint)

        # Features
        self._container.add(
            CheckboxWidget(title=_("Enable KubeVirt (virtualization)"), completed=self._virt),
            callback=self._toggle_virt)
        self._container.add(
            CheckboxWidget(title=_("Enable ArgoCD (GitOps)"), completed=self._argocd),
            callback=self._toggle_argocd)
        if self._cni != "cilium":
            self._container.add(
                CheckboxWidget(title=_("Enable firewalld"), completed=self._firewalld),
                callback=self._toggle_firewalld)

        # Backup/restore section
        if self._found_backups:
            backup_desc = f"{len(self._found_backups)} backup(s) found"
            if 0 <= self._selected_backup_idx < len(self._found_backups):
                info = self._found_backups[self._selected_backup_idx]["info"]
                backup_desc = f"{info.get('hostname')} ({info.get('node_type')})"
            self._container.add(
                EntryWidget(title=_("Backup to restore"), value=backup_desc),
                callback=self._cycle_backup)
            self._container.add(
                CheckboxWidget(title=_("Restore from backup"), completed=self._restore_enabled),
                callback=self._toggle_restore)

        self.window.add_with_separator(self._container)

    def apply(self):
        if self._k4all_module is None:
            return
        try:
            self._k4all_module.SetRole(self._role)
            self._k4all_module.SetCniType(self._cni)
            self._k4all_module.SetHaType(self._ha)
            self._k4all_module.SetVirtEnabled(self._virt)
            self._k4all_module.SetArgocdEnabled(self._argocd)
            self._k4all_module.SetFirewalldEnabled(self._firewalld)
            self._k4all_module.SetApiEndPointUseHostName(self._api_hostname)
            self._k4all_module.SetCustomApiEndPoint(self._custom_endpoint)
            self._k4all_module.SetApiControlEndpoint(self._api_control_ep)
            self._k4all_module.SetApiControlEndpointSubnetSize(self._api_control_subnet)
            self._k4all_module.SetPodNetwork(self._pod_network)
            self._k4all_module.SetServiceNetwork(self._service_network)
            self._k4all_module.SetCiliumAdditionalDevices(self._cilium_devices)
            self._k4all_module.SetCiliumGatewayApi(self._cilium_gateway)
            self._k4all_module.SetCiliumL2Announcements(self._cilium_l2)
            self._k4all_module.SetCiliumHubble(self._cilium_hubble)
            # Ingress
            self._k4all_module.SetIngressNginxEnabled(self._ingress_nginx)
            self._k4all_module.SetIngressNginxDedicatedIP(self._ingress_nginx_ip)
            self._k4all_module.SetIngressCiliumEnabled(self._ingress_cilium)
            self._k4all_module.SetIngressCiliumDedicatedIP(self._ingress_cilium_ip)
            is_cilium_default = self._ingress_default == "cilium"
            self._k4all_module.SetIngressNginxDefault(not is_cilium_default)
            self._k4all_module.SetIngressCiliumDefault(is_cilium_default)
            # Backup/restore
            self._k4all_module.SetRestoreEnabled(self._restore_enabled)
            if self._restore_enabled and 0 <= self._selected_backup_idx < len(self._found_backups):
                self._k4all_module.SetBackupArchivePath(self._found_backups[self._selected_backup_idx]["path"])
        except Exception:
            log.error("K4All TUI spoke: error during apply", exc_info=True)

    def execute(self):
        pass

    @property
    def completed(self):
        role = self._get_role()
        if role not in ("bootstrap", "control", "worker"):
            return False
        if self._k4all_module:
            try:
                ha = self._k4all_module.HaType
                if ha != "none":
                    if not self._k4all_module.ApiControlEndpoint or not self._k4all_module.ApiControlEndpointSubnetSize:
                        return False
                if role == "bootstrap":
                    nginx_on = self._k4all_module.IngressNginxEnabled
                    cilium_on = self._k4all_module.IngressCiliumEnabled
                    if not nginx_on and not cilium_on:
                        return False
                    if nginx_on and cilium_on:
                        n_ip = self._k4all_module.IngressNginxDedicatedIP
                        c_ip = self._k4all_module.IngressCiliumDedicatedIP
                        if not n_ip and not c_ip:
                            return False
                        if n_ip and c_ip and n_ip == c_ip:
                            return False
            except Exception:
                pass
        return True

    def _get_role(self):
        if self._k4all_module is None:
            return ""
        try:
            return self._k4all_module.Role
        except Exception:
            return ""

    @property
    def status(self):
        role = self._get_role()
        if not role or role not in ("bootstrap", "control", "worker"):
            return _("Not configured — select a node role")
        try:
            cni = self._k4all_module.CniType
            ha = self._k4all_module.HaType
            status = f"Role: {role}, CNI: {cni}"
            if ha != "none":
                vip = self._k4all_module.ApiControlEndpoint
                subnet = self._k4all_module.ApiControlEndpointSubnetSize
                if vip and subnet:
                    status += f", HA: {ha} (VIP: {vip}/{subnet})"
                else:
                    status += f", HA: {ha} — VIP required!"
            return status
        except Exception:
            return f"Role: {role} (details unavailable)"

    @property
    def mandatory(self):
        return True

    def input(self, args, key):
        if self._container.process_user_input(key):
            return InputState.PROCESSED_AND_REDRAW
        if key.lower() == Prompt.CONTINUE:
            self.apply()
            self.execute()
            return InputState.PROCESSED_AND_CLOSE
        return super().input(args, key)

    # --- Callbacks ---

    def _change_role(self, data):
        all_roles = [""] + list(VALID_ROLES)
        try:
            idx = all_roles.index(self._role)
            self._role = all_roles[(idx + 1) % len(all_roles)]
        except ValueError:
            self._role = all_roles[0]

    def _change_cni(self, data):
        cnis = list(VALID_CNI_TYPES)
        try:
            self._cni = cnis[(cnis.index(self._cni) + 1) % len(cnis)]
        except ValueError:
            self._cni = cnis[0]
        if self._cni == "cilium":
            self._firewalld = False

    def _change_ha(self, data):
        has = list(VALID_HA_TYPES)
        try:
            self._ha = has[(has.index(self._ha) + 1) % len(has)]
        except ValueError:
            self._ha = has[0]

    def _change_api_hostname(self, data):
        vals = list(_API_HOST_VALUES)
        try:
            self._api_hostname = vals[(vals.index(self._api_hostname) + 1) % len(vals)]
        except ValueError:
            self._api_hostname = vals[0]

    def _change_custom_endpoint(self, data):
        self._custom_endpoint = ""

    def _change_api_control_ep(self, data):
        self._api_control_ep = ""

    def _change_api_control_subnet(self, data):
        self._api_control_subnet = ""

    def _change_pod_network(self, data):
        self._pod_network = "10.100.0.1/18"

    def _change_service_network(self, data):
        self._service_network = "10.96.0.0/16"

    def _change_cilium_devices(self, data):
        self._cilium_devices = ""

    def _toggle_cilium_gateway(self, data):
        self._cilium_gateway = not self._cilium_gateway

    def _toggle_cilium_l2(self, data):
        self._cilium_l2 = not self._cilium_l2

    def _toggle_cilium_hubble(self, data):
        self._cilium_hubble = not self._cilium_hubble

    def _toggle_ingress_nginx(self, data):
        self._ingress_nginx = not self._ingress_nginx

    def _change_ingress_nginx_ip(self, data):
        self._ingress_nginx_ip = ""

    def _toggle_ingress_cilium(self, data):
        self._ingress_cilium = not self._ingress_cilium

    def _change_ingress_cilium_ip(self, data):
        self._ingress_cilium_ip = ""

    def _change_ingress_default(self, data):
        self._ingress_default = "cilium" if self._ingress_default == "nginx" else "nginx"

    def _toggle_virt(self, data):
        self._virt = not self._virt

    def _toggle_argocd(self, data):
        self._argocd = not self._argocd

    def _toggle_firewalld(self, data):
        self._firewalld = not self._firewalld

    def _cycle_backup(self, data):
        if self._found_backups:
            self._selected_backup_idx = (self._selected_backup_idx + 1) % len(self._found_backups)

    def _toggle_restore(self, data):
        self._restore_enabled = not self._restore_enabled

    def _scan_for_backups(self):
        """Scan mounted media for K4All backup archives."""
        self._found_backups = []
        for base_dir in ["/run/media", "/mnt", "/tmp"]:
            if not os.path.isdir(base_dir):
                continue
            try:
                for root, dirs, files in os.walk(base_dir):
                    if root.count(os.sep) - base_dir.count(os.sep) > 3:
                        continue
                    for f in files:
                        if f.startswith("k4all-backup-") and f.endswith(".tar.gz"):
                            full_path = os.path.join(root, f)
                            try:
                                with tarfile.open(full_path, "r:gz") as tf:
                                    info_member = tf.getmember("metadata/backup-info.json")
                                    info_file = tf.extractfile(info_member)
                                    if info_file:
                                        info = _json.loads(info_file.read())
                                        if info.get("marker") == "K4ALL_BACKUP_V2":
                                            self._found_backups.append({"path": full_path, "info": info})
                            except Exception:
                                pass
            except Exception:
                pass
        if self._found_backups:
            self._selected_backup_idx = 0
