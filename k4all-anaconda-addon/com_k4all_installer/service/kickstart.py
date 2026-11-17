# K4All Anaconda Addon - Kickstart Support
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""This module defines the parts needed for handling Kickstart data in the service."""

import json
import logging
import copy

try:
    import yaml
except ImportError:
    yaml = None

from pykickstart.options import KSOptionParser

from pyanaconda.core.kickstart import VERSION, KickstartSpecification
from pyanaconda.core.kickstart.addon import AddonData

from com_k4all_installer.constants import (
    VALID_ROLES, VALID_CNI_TYPES, VALID_HA_TYPES,
    VALID_EMULATION_VALUES,
    DEFAULT_CLUSTER_CONFIG, DEFAULT_INSTALL_CONFIG,
)

log = logging.getLogger(__name__)


class K4AllData(AddonData):
    """The kickstart data for the K4All addon.

    Example kickstart syntax (JSON is always available; YAML requires PyYAML):

    %addon com_k4all_installer --role=bootstrap --cni=calico
    {
      "networking": {"cni": {"type": "calico"}},
      "features": {"virt": {"enabled": true}}
    }
    %end
    """

    def __init__(self):
        super().__init__()
        self.role = ""
        self.cluster_config = copy.deepcopy(DEFAULT_CLUSTER_CONFIG)
        self.install_config = copy.deepcopy(DEFAULT_INSTALL_CONFIG)
        self._body_lines = []

    # ------------------------------------------------------------------
    # Backward compat: keep .config as an alias for .cluster_config
    # ------------------------------------------------------------------
    @property
    def config(self):
        return self.cluster_config

    @config.setter
    def config(self, value):
        self.cluster_config = value

    def handle_header(self, args, line_number=None):
        """Parse arguments from the %addon line."""
        op = KSOptionParser(
            prog="%addon com_k4all_installer",
            version=VERSION,
            description="Configure K4All Kubernetes cluster"
        )

        op.add_argument("--role", choices=list(VALID_ROLES), default="",
                         dest="role", version=VERSION, help="")
        op.add_argument("--cni", choices=VALID_CNI_TYPES, default="calico",
                         dest="cni", version=VERSION, help="")
        op.add_argument("--ha", choices=VALID_HA_TYPES, default="none",
                         dest="ha", version=VERSION, help="")
        op.add_argument("--virt", action="store_true", default=False,
                         dest="virt", version=VERSION, help="")
        op.add_argument("--argocd", action="store_true", default=False,
                         dest="argocd", version=VERSION, help="")
        op.add_argument("--firewalld", action="store_true", default=False,
                         dest="firewalld", version=VERSION, help="")
        op.add_argument("--vg-data-disk", default="auto",
                         dest="vg_data_disk", version=VERSION, help="")
        op.add_argument("--no-vg-data", action="store_true", default=False,
                         dest="no_vg_data", version=VERSION, help="")
        op.add_argument("--api-hostname", choices=["false", "true", "short"],
                         default="false", dest="api_hostname", version=VERSION, help="")
        op.add_argument("--custom-api-endpoint", default="",
                         dest="custom_api_endpoint", version=VERSION, help="")
        op.add_argument("--pod-network", default="10.100.0.1/18",
                         dest="pod_network", version=VERSION, help="")
        op.add_argument("--service-network", default="10.96.0.0/16",
                         dest="service_network", version=VERSION, help="")
        # Traefik replaced ingress-nginx in v2.4.0. The --*ingress-nginx*
        # options and --ingress-default=nginx are kept as aliases, so older
        # kickstarts keep working.
        op.add_argument("--ingress-traefik", "--ingress-nginx", action="store_true",
                         default=True, dest="ingress_traefik", version=VERSION, help="")
        op.add_argument("--no-ingress-traefik", "--no-ingress-nginx", action="store_true",
                         default=False, dest="no_ingress_traefik", version=VERSION, help="")
        op.add_argument("--ingress-cilium", action="store_true", default=False,
                         dest="ingress_cilium", version=VERSION, help="")
        op.add_argument("--ingress-default", choices=["traefik", "nginx", "cilium"],
                         default="traefik", dest="ingress_default", version=VERSION, help="")
        op.add_argument("--ingress-traefik-ip", "--ingress-nginx-ip", default="",
                         dest="ingress_traefik_ip", version=VERSION, help="")
        op.add_argument("--ingress-cilium-ip", default="",
                         dest="ingress_cilium_ip", version=VERSION, help="")
        op.add_argument("--api-control-endpoint", default="",
                         dest="api_control_endpoint", version=VERSION, help="")
        op.add_argument("--api-control-endpoint-subnet", default="",
                         dest="api_control_endpoint_subnet", version=VERSION, help="")

        ns = op.parse_args(args=args, lineno=line_number)

        self.role = ns.role

        # Cluster config (CRD spec fields)
        cfg = self.cluster_config
        cfg["networking"]["cni"]["type"] = ns.cni
        cfg["networking"]["firewalld"]["enabled"] = ns.firewalld
        cfg["cluster"]["ha"]["type"] = ns.ha
        cfg["features"]["virt"]["enabled"] = ns.virt
        cfg["features"]["argocd"]["enabled"] = ns.argocd
        cfg["cluster"]["apiEndPointUseHostName"] = ns.api_hostname != "false"
        cfg["cluster"]["customApiEndPoint"] = ns.custom_api_endpoint
        cfg["cluster"]["podNetwork"] = ns.pod_network
        cfg["cluster"]["serviceNetwork"] = ns.service_network

        # Ingress
        cfg["ingress"]["traefik"]["isDefault"] = (
            ns.ingress_default in ("traefik", "nginx") and not ns.no_ingress_traefik)
        cfg["ingress"]["traefik"]["dedicatedIP"] = ns.ingress_traefik_ip
        cfg["ingress"]["cilium"]["dedicatedIP"] = ns.ingress_cilium_ip

        # HA
        cfg["cluster"]["ha"]["apiControlEndpoint"] = ns.api_control_endpoint
        cfg["cluster"]["ha"]["apiControlEndpointSubnetSize"] = ns.api_control_endpoint_subnet

        # Install config (not in CR)
        icfg = self.install_config
        icfg["storage"]["vg_data"]["enabled"] = "false" if ns.no_vg_data else "true"
        icfg["storage"]["vg_data"]["disk"] = ns.vg_data_disk

    def handle_line(self, line, line_number=None):
        """Collect body lines (YAML or JSON to merge into the cluster config)."""
        self._body_lines.append(line)

    def finalize(self):
        """Parse, merge, normalize, and validate the ClusterConfig body."""
        if self._body_lines:
            body_text = "".join(self._body_lines)
            user_config = None
            parse_error = None

            # Try YAML first, then JSON.
            if yaml is not None:
                try:
                    user_config = yaml.safe_load(body_text)
                except Exception as e:
                    parse_error = e

            if user_config is None:
                try:
                    user_config = json.loads(body_text)
                except (json.JSONDecodeError, ValueError) as e:
                    parse_error = e

            if not isinstance(user_config, dict):
                raise ValueError(
                    "K4All kickstart body must be a valid JSON mapping "
                    "(YAML also works when PyYAML is installed)"
                ) from parse_error

            self._deep_merge(self.cluster_config, user_config)
            log.debug("Merged user config from kickstart body")

        self._normalize_and_validate_cluster_config(
            self.cluster_config, DEFAULT_CLUSTER_CONFIG
        )

        cni_type = self.cluster_config["networking"]["cni"]["type"]
        if cni_type not in VALID_CNI_TYPES:
            raise ValueError(f"Invalid ClusterConfig CNI type: {cni_type}")

        ha_type = self.cluster_config["cluster"]["ha"]["type"]
        if ha_type not in VALID_HA_TYPES:
            raise ValueError(f"Invalid ClusterConfig HA type: {ha_type}")

        emulation = self.cluster_config["features"]["virt"]["emulation"]
        if emulation not in VALID_EMULATION_VALUES:
            raise ValueError(
                f"Invalid ClusterConfig virtualization emulation value: {emulation}"
            )

    def _normalize_and_validate_cluster_config(self, config, schema, path=()):
        """Validate against the built-in CRD shape and normalize legacy booleans.

        Older kickstarts represented booleans as the strings ``"true"`` and
        ``"false"``.  Accept those exact values for backward compatibility,
        but reject other type mismatches and fields unknown to the CRD.  The
        componentOverrides map is intentionally open-ended.
        """
        if not isinstance(config, dict):
            dotted = ".".join(path) or "spec"
            raise ValueError(f"ClusterConfig field {dotted} must be a mapping")

        if path == ("componentOverrides",):
            return

        unknown = sorted(set(config) - set(schema))
        if unknown:
            dotted = ".".join(path) or "spec"
            raise ValueError(
                f"Unknown ClusterConfig field(s) below {dotted}: "
                + ", ".join(unknown)
            )

        for key, value in config.items():
            expected = schema[key]
            field_path = (*path, key)
            dotted = ".".join(field_path)

            if isinstance(expected, bool):
                if isinstance(value, str) and value.lower() in ("true", "false"):
                    config[key] = value.lower() == "true"
                elif not isinstance(value, bool):
                    raise ValueError(
                        f"ClusterConfig field {dotted} must be a boolean"
                    )
            elif isinstance(expected, dict):
                self._normalize_and_validate_cluster_config(
                    value, expected, field_path
                )
            elif isinstance(expected, str) and not isinstance(value, str):
                raise ValueError(
                    f"ClusterConfig field {dotted} must be a string"
                )

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

        cfg = self.cluster_config
        section += f" --cni={cfg['networking']['cni']['type']}"
        section += f" --ha={cfg['cluster']['ha']['type']}"

        if cfg["features"]["virt"]["enabled"]:
            section += " --virt"
        if cfg["features"]["argocd"]["enabled"]:
            section += " --argocd"
        if cfg["networking"]["firewalld"]["enabled"]:
            section += " --firewalld"

        # Install-only settings
        icfg = self.install_config
        if icfg.get("storage", {}).get("vg_data", {}).get("enabled") == "false":
            section += " --no-vg-data"
        elif icfg.get("storage", {}).get("vg_data", {}).get("disk", "auto") != "auto":
            section += f" --vg-data-disk={icfg['storage']['vg_data']['disk']}"

        api_host = cfg["cluster"].get("apiEndPointUseHostName", False)
        if api_host and api_host is not False:
            section += f" --api-hostname={'true' if api_host is True else api_host}"

        custom_ep = cfg["cluster"].get("customApiEndPoint", "")
        if custom_ep:
            section += f" --custom-api-endpoint={custom_ep}"

        pod_net = cfg["cluster"].get("podNetwork", "10.100.0.1/18")
        if pod_net != "10.100.0.1/18":
            section += f" --pod-network={pod_net}"

        svc_net = cfg["cluster"].get("serviceNetwork", "10.96.0.0/16")
        if svc_net != "10.96.0.0/16":
            section += f" --service-network={svc_net}"

        # Ingress flags
        traefik = cfg.get("ingress", {}).get("traefik", {})
        if not traefik.get("isDefault", True):
            section += " --no-ingress-traefik"
        if cfg.get("ingress", {}).get("cilium", {}).get("dedicatedIP"):
            section += " --ingress-cilium"
        if not traefik.get("isDefault", True):
            section += " --ingress-default=cilium"
        traefik_ip = traefik.get("dedicatedIP", "")
        if traefik_ip:
            section += f" --ingress-traefik-ip={traefik_ip}"
        cilium_ip = cfg.get("ingress", {}).get("cilium", {}).get("dedicatedIP", "")
        if cilium_ip:
            section += f" --ingress-cilium-ip={cilium_ip}"

        ha_vip = cfg["cluster"]["ha"].get("apiControlEndpoint", "")
        if ha_vip:
            section += f" --api-control-endpoint={ha_vip}"
        ha_subnet = cfg["cluster"]["ha"].get("apiControlEndpointSubnetSize", "")
        if ha_subnet:
            section += f" --api-control-endpoint-subnet={ha_subnet}"

        # Body: dump the cluster config as YAML
        section += "\n"
        if yaml is not None:
            section += yaml.safe_dump(cfg, default_flow_style=False, sort_keys=False)
        else:
            section += json.dumps(cfg, indent=2)
            section += "\n"
        section += "%end\n"

        return section


class K4AllKickstartSpecification(KickstartSpecification):
    """Kickstart specification of the K4All addon."""

    addons = {
        "com_k4all_installer": K4AllData
    }
