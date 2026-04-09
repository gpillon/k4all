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

# CRD metadata written around the spec when producing /etc/k4all-config.yaml
CR_API_VERSION = "k4all.magesgate.com/v1alpha1"
CR_KIND = "ClusterConfig"
CR_NAME = "k4all-cluster-config"

# File paths (relative to sysroot, without leading slash)
K4ALL_CONFIG_PATH = "etc/k4all-config.yaml"
K4ALL_NODE_TYPE_PATH = "etc/node-type"

# Valid values for configuration options
VALID_ROLES = ("bootstrap", "control", "worker")
VALID_CNI_TYPES = ("calico", "cilium")
VALID_HA_TYPES = ("none", "keepalived", "kubevip")
VALID_EMULATION_VALUES = ("true", "false", "auto")
VALID_INGRESS_CONTROLLERS = ("nginx", "cilium", "both")
VALID_INGRESS_IP_MODES = ("auto", "dedicated")

# Default cluster configuration -- mirrors ClusterConfigSpec in the CRD.
# This dict is written as `spec:` inside the ClusterConfig CR YAML.
# All field names use camelCase to match the Go CRD exactly.
DEFAULT_CLUSTER_CONFIG = {
    "networking": {
        "cni": {"type": "calico"},
        "firewalld": {"enabled": False},
        "iface": {"dev": "auto", "ipConfig": "dhcp"}
    },
    "features": {
        "virt": {"enabled": False, "emulation": "auto"},
        "argocd": {"enabled": False},
        "ovsCni": {"enabled": False}
    },
    "cluster": {
        "apiEndPointUseHostName": False,
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
    "ingress": {
        "nginx": {
            "dedicatedIP": "",
            "isDefault": True
        },
        "cilium": {
            "dedicatedIP": ""
        }
    },
    "proxy": {
        "httpProxy": "",
        "httpsProxy": "",
        "noProxy": ""
    },
    "componentOverrides": {}
}

# Installer-only settings -- NOT written into the ClusterConfig CR.
# These are consumed during the Anaconda installation phase only.
DEFAULT_INSTALL_CONFIG = {
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
    }
}
