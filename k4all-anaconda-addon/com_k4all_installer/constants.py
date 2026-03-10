# K4All Anaconda Addon - Constants
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""This module contains constants that are used by various parts of the K4All addon."""

from dasbus.identifier import DBusServiceIdentifier
from pyanaconda.core.dbus import DBus
from pyanaconda.modules.common.constants.namespaces import ADDONS_NAMESPACE

# D-Bus service identifier for the K4All addon
K4ALL_NAMESPACE = (*ADDONS_NAMESPACE, "K4All")

K4ALL = DBusServiceIdentifier(
    namespace=K4ALL_NAMESPACE,
    message_bus=DBus
)

# File paths (relative to sysroot, without leading slash)
K4ALL_CONFIG_PATH = "etc/k4all-config.json"
K4ALL_NODE_TYPE_PATH = "etc/node-type"

# Valid values for configuration options
VALID_ROLES = ("bootstrap", "control", "worker")
VALID_CNI_TYPES = ("calico", "cilium")
VALID_HA_TYPES = ("none", "keepalived", "kubevip")
VALID_EMULATION_VALUES = ("true", "false", "auto")
VALID_INGRESS_CONTROLLERS = ("nginx", "cilium", "both")
VALID_INGRESS_IP_MODES = ("auto", "dedicated")

# Default configuration
DEFAULT_CONFIG = {
    "version": "2.0.0",
    "networking": {
        "cni": {"type": "calico"},
        "firewalld": {"enabled": "false"},
        "iface": {"dev": "auto", "ipconfig": "dhcp"}
    },
    "disk": {
        "root": {"disk": "auto", "size_mib": "20%"},
        "keep_lvm": "true"
    },
    "storage": {
        "vg_data": {
            "enabled": "true",
            "disk": "auto",
            "size": "remaining"
        }
    },
    "features": {
        "virt": {"enabled": "false", "emulation": "auto"},
        "argocd": {"enabled": "false"}
    },
    "cluster": {
        "apiEndPointUseHostName": "false",
        "customApiEndPoint": "",
        "podNetwork": "10.100.0.1/18",
        "serviceNetwork": "10.96.0.0/16",
        "ha": {
            "interface": "auto",
            "type": "none",
            "apiControlEndpoint": "",
            "apiControlEndpointSubnetSize": ""
        }
    },
    "cni": {
        "cilium": {
            "additionalDevices": "",
            "gatewayApi": "false",
            "l2announcements": "false",
            "hubble": "false"
        }
    },
    "ingress": {
        "nginx": {
            "enabled": "true",
            "isDefault": "true",
            "dedicatedIP": ""
        },
        "cilium": {
            "enabled": "false",
            "isDefault": "false",
            "dedicatedIP": ""
        }
    },
    "proxy": {
        "http_proxy": "",
        "https_proxy": "",
        "no_proxy": ""
    }
}

