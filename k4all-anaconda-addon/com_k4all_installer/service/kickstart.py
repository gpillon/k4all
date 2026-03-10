# K4All Anaconda Addon - Kickstart Support
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""This module defines the parts needed for handling Kickstart data in the service."""

import json
import logging

from pykickstart.options import KSOptionParser

from pyanaconda.core.kickstart import VERSION, KickstartSpecification
from pyanaconda.core.kickstart.addon import AddonData

from com_k4all_installer.constants import (
    VALID_ROLES, VALID_CNI_TYPES, VALID_HA_TYPES, DEFAULT_CONFIG
)

log = logging.getLogger(__name__)


class K4AllData(AddonData):
    """The kickstart data for the K4All addon.
    
    Example kickstart syntax:
    
    %addon com_k4all_installer --role=bootstrap --cni=calico
    {
      "cluster": { "ha": { "type": "none" } },
      "features": { "virt": { "enabled": "false" } }
    }
    %end
    """

    def __init__(self):
        super().__init__()
        # Node role (empty = not yet configured)
        self.role = ""
        # JSON config (merged with defaults)
        self.config = dict(DEFAULT_CONFIG)
        # Raw JSON lines from kickstart body
        self._json_lines = []

    def handle_header(self, args, line_number=None):
        """Parse arguments from the %addon line.
        
        Supported arguments:
            --role=<bootstrap|control|worker>
            --cni=<calico|cilium>
            --ha=<none|keepalived|kubevip>
            --virt (enable virtualization)
            --argocd (enable ArgoCD)
            --firewalld (enable firewalld)
        """
        op = KSOptionParser(
            prog="%addon com_k4all_installer",
            version=VERSION,
            description="Configure K4All Kubernetes cluster"
        )

        op.add_argument(
            "--role",
            choices=list(VALID_ROLES), # + [""],
            default="",
            dest="role",
            version=VERSION,
            help="Node role: bootstrap, control, or worker (empty = not configured)"
        )

        op.add_argument(
            "--cni",
            choices=VALID_CNI_TYPES,
            default="calico",
            dest="cni",
            version=VERSION,
            help="CNI plugin: calico or cilium"
        )

        op.add_argument(
            "--ha",
            choices=VALID_HA_TYPES,
            default="none",
            dest="ha",
            version=VERSION,
            help="HA type: none, keepalived, or kubevip"
        )

        op.add_argument(
            "--virt",
            action="store_true",
            default=False,
            dest="virt",
            version=VERSION,
            help="Enable KubeVirt virtualization"
        )

        op.add_argument(
            "--argocd",
            action="store_true",
            default=False,
            dest="argocd",
            version=VERSION,
            help="Enable ArgoCD"
        )

        op.add_argument(
            "--firewalld",
            action="store_true",
            default=False,
            dest="firewalld",
            version=VERSION,
            help="Enable firewalld"
        )

        op.add_argument(
            "--vg-data-disk",
            default="auto",
            dest="vg_data_disk",
            version=VERSION,
            help="Disk for vg_data VG (auto, or device like sda)"
        )

        op.add_argument(
            "--no-vg-data",
            action="store_true",
            default=False,
            dest="no_vg_data",
            version=VERSION,
            help="Disable vg_data creation"
        )

        op.add_argument(
            "--api-hostname",
            choices=["false", "true", "short"],
            default="false",
            dest="api_hostname",
            version=VERSION,
            help="Use hostname for API endpoint (false/true/short)"
        )

        op.add_argument(
            "--custom-api-endpoint",
            default="",
            dest="custom_api_endpoint",
            version=VERSION,
            help="Custom API endpoint hostname/IP"
        )

        op.add_argument(
            "--pod-network",
            default="10.100.0.1/18",
            dest="pod_network",
            version=VERSION,
            help="Pod network CIDR (e.g. 10.100.0.1/18)"
        )

        op.add_argument(
            "--service-network",
            default="10.96.0.0/16",
            dest="service_network",
            version=VERSION,
            help="Service network CIDR (e.g. 10.96.0.0/16)"
        )

        op.add_argument(
            "--cilium-additional-devices",
            default="",
            dest="cilium_additional_devices",
            version=VERSION,
            help="Additional network devices for Cilium (comma-separated)"
        )

        op.add_argument(
            "--cilium-gateway-api",
            action="store_true",
            default=False,
            dest="cilium_gateway_api",
            version=VERSION,
            help="Enable Cilium Gateway API"
        )

        op.add_argument(
            "--cilium-l2-announcements",
            action="store_true",
            default=False,
            dest="cilium_l2_announcements",
            version=VERSION,
            help="Enable Cilium L2 Announcements"
        )

        op.add_argument(
            "--cilium-hubble",
            action="store_true",
            default=False,
            dest="cilium_hubble",
            version=VERSION,
            help="Enable Cilium Hubble UI"
        )

        op.add_argument(
            "--ingress-nginx",
            action="store_true",
            default=True,
            dest="ingress_nginx",
            version=VERSION,
            help="Enable NGINX Ingress Controller (default: enabled)"
        )

        op.add_argument(
            "--no-ingress-nginx",
            action="store_true",
            default=False,
            dest="no_ingress_nginx",
            version=VERSION,
            help="Disable NGINX Ingress Controller"
        )

        op.add_argument(
            "--ingress-cilium",
            action="store_true",
            default=False,
            dest="ingress_cilium",
            version=VERSION,
            help="Enable Cilium Ingress Controller"
        )

        op.add_argument(
            "--ingress-default",
            choices=["nginx", "cilium"],
            default="nginx",
            dest="ingress_default",
            version=VERSION,
            help="Default ingress controller (nginx or cilium)"
        )

        op.add_argument(
            "--ingress-nginx-ip",
            default="",
            dest="ingress_nginx_ip",
            version=VERSION,
            help="Dedicated IP for NGINX ingress (empty = cluster IP)"
        )

        op.add_argument(
            "--ingress-cilium-ip",
            default="",
            dest="ingress_cilium_ip",
            version=VERSION,
            help="Dedicated IP for Cilium ingress (empty = cluster IP)"
        )

        op.add_argument(
            "--api-control-endpoint",
            default="",
            dest="api_control_endpoint",
            version=VERSION,
            help="HA control plane VIP address (required when HA != none)"
        )

        op.add_argument(
            "--api-control-endpoint-subnet",
            default="",
            dest="api_control_endpoint_subnet",
            version=VERSION,
            help="HA control plane VIP subnet size, e.g. 24 (required when HA != none)"
        )

        ns = op.parse_args(args=args, lineno=line_number)

        # Store parsed values
        self.role = ns.role
        self.config["networking"]["cni"]["type"] = ns.cni
        self.config["cluster"]["ha"]["type"] = ns.ha
        self.config["features"]["virt"]["enabled"] = "true" if ns.virt else "false"
        self.config["features"]["argocd"]["enabled"] = "true" if ns.argocd else "false"
        self.config["networking"]["firewalld"]["enabled"] = "true" if ns.firewalld else "false"

        # Storage config
        self.config["storage"]["vg_data"]["enabled"] = "false" if ns.no_vg_data else "true"
        self.config["storage"]["vg_data"]["disk"] = ns.vg_data_disk

        # Cluster config (bootstrap/control only)
        self.config["cluster"]["apiEndPointUseHostName"] = ns.api_hostname
        self.config["cluster"]["customApiEndPoint"] = ns.custom_api_endpoint

        # Network CIDRs (bootstrap only, but always stored)
        self.config["cluster"]["podNetwork"] = ns.pod_network
        self.config["cluster"]["serviceNetwork"] = ns.service_network

        # Cilium-specific config
        cilium = self.config.setdefault("cni", {}).setdefault("cilium", {})
        cilium["additionalDevices"] = ns.cilium_additional_devices
        cilium["gatewayApi"] = "true" if ns.cilium_gateway_api else "false"
        cilium["l2announcements"] = "true" if ns.cilium_l2_announcements else "false"
        cilium["hubble"] = "true" if ns.cilium_hubble else "false"

        # Ingress config
        ingress = self.config.setdefault("ingress", {})
        nginx_enabled = not ns.no_ingress_nginx
        ingress.setdefault("nginx", {})["enabled"] = "true" if nginx_enabled else "false"
        ingress.setdefault("cilium", {})["enabled"] = "true" if ns.ingress_cilium else "false"
        ingress["nginx"]["isDefault"] = "true" if ns.ingress_default == "nginx" else "false"
        ingress["cilium"]["isDefault"] = "true" if ns.ingress_default == "cilium" else "false"
        ingress["nginx"]["dedicatedIP"] = ns.ingress_nginx_ip
        ingress["cilium"]["dedicatedIP"] = ns.ingress_cilium_ip

        # HA config
        self.config["cluster"]["ha"]["apiControlEndpoint"] = ns.api_control_endpoint
        self.config["cluster"]["ha"]["apiControlEndpointSubnetSize"] = ns.api_control_endpoint_subnet

    def handle_line(self, line, line_number=None):
        """Handle lines inside the %addon section.
        
        Lines are expected to be JSON that will be merged with the default config.
        """
        self._json_lines.append(line)

    def finalize(self):
        """Called after all lines have been processed.
        
        Merge the JSON body with the config.
        """
        if self._json_lines:
            json_text = "".join(self._json_lines)
            try:
                user_config = json.loads(json_text)
                self._deep_merge(self.config, user_config)
                log.debug("Merged user config from kickstart body")
            except json.JSONDecodeError as e:
                log.warning("Failed to parse JSON in kickstart body: %s", e)

    def _deep_merge(self, base, override):
        """Deep merge override into base dict."""
        for key, value in override.items():
            if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                self._deep_merge(base[key], value)
            else:
                base[key] = value

    def __str__(self):
        """Generate kickstart representation."""
        section = "\n%addon com_k4all_installer"
        if self.role:
            section += f" --role={self.role}"
        section += f" --cni={self.config['networking']['cni']['type']}"
        section += f" --ha={self.config['cluster']['ha']['type']}"
        
        if self.config["features"]["virt"]["enabled"] == "true":
            section += " --virt"
        if self.config["features"]["argocd"]["enabled"] == "true":
            section += " --argocd"
        if self.config["networking"]["firewalld"]["enabled"] == "true":
            section += " --firewalld"
        
        if self.config["storage"]["vg_data"]["enabled"] == "false":
            section += " --no-vg-data"
        elif self.config["storage"]["vg_data"]["disk"] != "auto":
            section += f" --vg-data-disk={self.config['storage']['vg_data']['disk']}"

        api_hostname = self.config["cluster"].get("apiEndPointUseHostName", "false")
        if api_hostname != "false":
            section += f" --api-hostname={api_hostname}"
        
        custom_ep = self.config["cluster"].get("customApiEndPoint", "")
        if custom_ep:
            section += f" --custom-api-endpoint={custom_ep}"

        pod_net = self.config["cluster"].get("podNetwork", "10.100.0.1/18")
        if pod_net != "10.100.0.1/18":
            section += f" --pod-network={pod_net}"

        svc_net = self.config["cluster"].get("serviceNetwork", "10.96.0.0/16")
        if svc_net != "10.96.0.0/16":
            section += f" --service-network={svc_net}"

        cilium = self.config.get("cni", {}).get("cilium", {})
        cilium_devs = cilium.get("additionalDevices", "")
        if cilium_devs:
            section += f" --cilium-additional-devices={cilium_devs}"
        if cilium.get("gatewayApi", "false") == "true":
            section += " --cilium-gateway-api"
        if cilium.get("l2announcements", "false") == "true":
            section += " --cilium-l2-announcements"
        if cilium.get("hubble", "false") == "true":
            section += " --cilium-hubble"

        ingress = self.config.get("ingress", {})
        if ingress.get("nginx", {}).get("enabled", "true") == "false":
            section += " --no-ingress-nginx"
        if ingress.get("cilium", {}).get("enabled", "false") == "true":
            section += " --ingress-cilium"
        ing_default = "cilium" if ingress.get("cilium", {}).get("isDefault", "false") == "true" else "nginx"
        if ing_default != "nginx":
            section += f" --ingress-default={ing_default}"
        nginx_ip = ingress.get("nginx", {}).get("dedicatedIP", "")
        if nginx_ip:
            section += f" --ingress-nginx-ip={nginx_ip}"
        cilium_ip = ingress.get("cilium", {}).get("dedicatedIP", "")
        if cilium_ip:
            section += f" --ingress-cilium-ip={cilium_ip}"

        ha_vip = self.config["cluster"]["ha"].get("apiControlEndpoint", "")
        if ha_vip:
            section += f" --api-control-endpoint={ha_vip}"

        ha_subnet = self.config["cluster"]["ha"].get("apiControlEndpointSubnetSize", "")
        if ha_subnet:
            section += f" --api-control-endpoint-subnet={ha_subnet}"

        section += "\n"
        section += json.dumps(self.config, indent=2)
        section += "\n%end\n"
        
        return section


class K4AllKickstartSpecification(KickstartSpecification):
    """Kickstart specification of the K4All addon."""

    addons = {
        "com_k4all_installer": K4AllData
    }

