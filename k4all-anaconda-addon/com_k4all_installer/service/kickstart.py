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
        # Node role
        self.role = "bootstrap"
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
            choices=VALID_ROLES,
            default="bootstrap",
            dest="role",
            help="Node role: bootstrap, control, or worker"
        )

        op.add_argument(
            "--cni",
            choices=VALID_CNI_TYPES,
            default="calico",
            dest="cni",
            help="CNI plugin: calico or cilium"
        )

        op.add_argument(
            "--ha",
            choices=VALID_HA_TYPES,
            default="none",
            dest="ha",
            help="HA type: none, keepalived, or kubevip"
        )

        op.add_argument(
            "--virt",
            action="store_true",
            default=False,
            dest="virt",
            help="Enable KubeVirt virtualization"
        )

        op.add_argument(
            "--argocd",
            action="store_true",
            default=False,
            dest="argocd",
            help="Enable ArgoCD"
        )

        op.add_argument(
            "--firewalld",
            action="store_true",
            default=False,
            dest="firewalld",
            help="Enable firewalld"
        )

        op.add_argument(
            "--vg-data-disk",
            default="auto",
            dest="vg_data_disk",
            help="Disk for vg_data VG (auto, or device like sda)"
        )

        op.add_argument(
            "--no-vg-data",
            action="store_true",
            default=False,
            dest="no_vg_data",
            help="Disable vg_data creation"
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
        
        section += "\n"
        
        # Include full config as JSON body
        section += json.dumps(self.config, indent=2)
        section += "\n%end\n"
        
        return section


class K4AllKickstartSpecification(KickstartSpecification):
    """Kickstart specification of the K4All addon."""

    addons = {
        "com_k4all_installer": K4AllData
    }

