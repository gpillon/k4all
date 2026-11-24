# K4All Anaconda Addon - Constants
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""This module contains constants that are used by various parts of the K4All addon."""

import copy

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
VALID_INGRESS_CONTROLLERS = ("traefik", "cilium", "both")
VALID_INGRESS_IP_MODES = ("auto", "dedicated")
# The bounds and enums of the ClusterConfig CRD (k4all-operator v0.6.0,
# api/v1alpha1/clusterconfig_types.go), which a kickstart is checked against.
VALID_ROOK_SMALL_CLUSTER = ("Refuse", "Allow")
VALID_METADATA_SCOPES = ("Labelled", "All")
VALID_CPU_MANAGER_POLICIES = ("none", "static")
VALID_TOPOLOGY_MANAGER_POLICIES = ("none", "best-effort", "restricted", "single-numa-node")
VALID_TOPOLOGY_MANAGER_SCOPES = ("container", "pod")
HUGEPAGE_SIZES = ("1Gi", "2Mi")
MAX_PODS_RANGE = (10, 1000)
MAX_FEATURE_GATES = 64
MIN_TOKEN_EXPIRATION_SECONDS = 600
INT32_MAX = 2**31 - 1

# Default cluster configuration -- mirrors ClusterConfigSpec in the CRD.
# This dict is written as `spec:` inside the ClusterConfig CR YAML, and is
# also the shape a kickstart body is checked against (with
# OPTIONAL_CLUSTER_CONFIG). All field names use camelCase to match the Go
# CRD exactly. Keep it equal to bootc/overlay/etc/k4all-config.yaml.default
# (tests/test_bootc_contracts.py).
#
# k4all v2.7.0 (its spec, §3): the metadata service is on for the VMs
# labelled for it (it does nothing while virt is off), Rook is off, the
# kubelet runs 250 pods per node (what kubeadm's bootstrap config gives new
# installs since v2.6.5). Hangar's node agent and the KubeVirt settings are
# left out: the release's default, and nothing owned. Existing clusters get
# none of this: an upgrade does not touch their ClusterConfig.
DEFAULT_CLUSTER_CONFIG = {
    "networking": {
        "cni": {"type": "calico"},
        "firewalld": {"enabled": False}
    },
    "features": {
        "virt": {
            "enabled": False,
            "emulation": "auto",
            "metadata": {"enabled": True, "scope": "Labelled"},
        },
        "rook": {"enabled": False},
        "argocd": {"enabled": False},
        "ovsCni": {"enabled": False},
        "ovsBridge": {"enabled": True}
    },
    "nodes": {
        "kubelet": {"maxPods": 250}
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
        "traefik": {
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

# In a schema: a mapping whose keys are free, every value of the type given
# under this key (nodes.hugepages: page size to a count).
ANY_KEY = "*"

# ClusterConfig fields a kickstart body may set that new installs leave
# out: every field of the CRD (k4all v2.7.0, spec §3), so a kickstart sets
# at install what the ClusterConfig accepts. The values give their type
# ([""]: a list of strings). Rook's creation inputs matter most: the
# CephCluster is created once, right after Rook is installed, so a
# kickstart that turns Rook on sets its disks (deviceFilter) and its
# small-cluster policy in the same body. The CRD's bounds, enums and rules
# are checked by cluster_config.check_crd_rules.
OPTIONAL_CLUSTER_CONFIG = {
    "features": {
        "virt": {
            "kubevirt": {
                "featureGates": [""],
                "disabledFeatureGates": [""],
                "vmStateStorageClass": "",
            },
            "hangar": {"nodeAgent": True},
            "metadata": {
                "tokens": {"audiences": [""], "expirationSeconds": 3600},
                "vendorDataConfigMap": "",
            },
        },
        "rook": {"smallCluster": "Refuse", "storage": {"deviceFilter": ""}},
    },
    "nodes": {
        "kubelet": {
            "cpuManagerPolicy": "",
            "reservedSystemCPUs": "",
            "topologyManagerPolicy": "",
            "topologyManagerScope": "",
        },
        "hugepages": {ANY_KEY: 0},
        "iommu": True,
        "rollout": {"paused": True},
    },
}


def cluster_config_schema():
    """The shape a kickstart's ClusterConfig is checked against: the
    defaults and the optional fields."""
    def merge(base, extra):
        out = copy.deepcopy(base)
        for key, value in extra.items():
            if isinstance(value, dict) and isinstance(out.get(key), dict):
                out[key] = merge(out[key], value)
            else:
                out[key] = copy.deepcopy(value)
        return out
    return merge(DEFAULT_CLUSTER_CONFIG, OPTIONAL_CLUSTER_CONFIG)


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


# Roles that join a cluster made by a bootstrap node.
JOINING_ROLES = ("control", "worker")


def node_cluster_config(role, cluster_config):
    """The ClusterConfig spec a node of ``role`` keeps in /etc/k4all-config.yaml.

    The cluster's CNI is the bootstrap node's choice. A node that joins
    cannot know it when it is installed, so its configuration carries no
    ``networking.cni`` rather than a guess (issue #63): k4all-cni-firewalld
    opens the ports of the CNI that runs on the node.
    """
    spec = copy.deepcopy(cluster_config)
    if role in JOINING_ROLES:
        spec.get("networking", {}).pop("cni", None)
    return spec
