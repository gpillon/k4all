# K4All Anaconda Addon - ClusterConfig checks
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""The rules of the ClusterConfig CRD a kickstart's ClusterConfig must meet.

The node applies /etc/k4all-config.yaml at first boot; a value the CRD
refuses then would leave the cluster without its operator. The installer
refuses it instead, naming the field. The field types are checked first
(K4AllData._normalize_and_validate_cluster_config): here only the bounds,
enums and cross-field rules (the CRD's x-kubernetes-validations).
"""

from com_k4all_installer.constants import (
    VALID_ROOK_SMALL_CLUSTER, VALID_METADATA_SCOPES,
    VALID_CPU_MANAGER_POLICIES, VALID_TOPOLOGY_MANAGER_POLICIES,
    VALID_TOPOLOGY_MANAGER_SCOPES, HUGEPAGE_SIZES, MAX_PODS_RANGE,
    MAX_FEATURE_GATES, MIN_TOKEN_EXPIRATION_SECONDS, INT32_MAX,
)


def _at(spec, path):
    """The value at the dotted path, None when a part is missing."""
    node = spec
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def _one_of(spec, path, values):
    value = _at(spec, path)
    if value is not None and value not in values:
        raise ValueError(
            f"Invalid ClusterConfig {path}: {value} (one of {', '.join(values)})")


def _a_set(spec, path, max_items=None):
    """A list the CRD declares a set (listType=set): no entry twice."""
    items = _at(spec, path)
    if items is None:
        return []
    seen = set()
    for item in items:
        if item in seen:
            raise ValueError(f"ClusterConfig field {path} lists {item} twice")
        seen.add(item)
    if max_items is not None and len(items) > max_items:
        raise ValueError(
            f"ClusterConfig field {path}: at most {max_items} entries ({len(items)})")
    return items


def check_crd_rules(spec):
    """Raise ValueError at the first value of spec the CRD would refuse."""
    # features.virt.kubevirt
    on = _a_set(spec, "features.virt.kubevirt.featureGates", MAX_FEATURE_GATES)
    off = _a_set(spec, "features.virt.kubevirt.disabledFeatureGates", MAX_FEATURE_GATES)
    both = sorted(set(on) & set(off))
    if both:
        raise ValueError(
            "ClusterConfig features.virt.kubevirt: a gate cannot be both on and off: "
            + ", ".join(both))
    if "HotplugVolumes" in on and "DeclarativeHotplugVolumes" in on:
        raise ValueError(
            "ClusterConfig features.virt.kubevirt.featureGates: "
            "HotplugVolumes turns DeclarativeHotplugVolumes off: set one")

    # features.virt.metadata
    _one_of(spec, "features.virt.metadata.scope", VALID_METADATA_SCOPES)
    _a_set(spec, "features.virt.metadata.tokens.audiences")
    expiration = _at(spec, "features.virt.metadata.tokens.expirationSeconds")
    if expiration is not None and expiration < MIN_TOKEN_EXPIRATION_SECONDS:
        raise ValueError(
            "Invalid ClusterConfig features.virt.metadata.tokens.expirationSeconds: "
            f"{expiration} (at least {MIN_TOKEN_EXPIRATION_SECONDS})")

    # features.rook
    _one_of(spec, "features.rook.smallCluster", VALID_ROOK_SMALL_CLUSTER)

    # nodes
    max_pods = _at(spec, "nodes.kubelet.maxPods")
    low, high = MAX_PODS_RANGE
    if max_pods is not None and not low <= max_pods <= high:
        raise ValueError(
            f"Invalid ClusterConfig nodes.kubelet.maxPods: {max_pods} (from {low} to {high})")
    _one_of(spec, "nodes.kubelet.cpuManagerPolicy", VALID_CPU_MANAGER_POLICIES)
    if _at(spec, "nodes.kubelet.cpuManagerPolicy") == "static" and \
            not _at(spec, "nodes.kubelet.reservedSystemCPUs"):
        raise ValueError(
            "ClusterConfig nodes.kubelet: the static CPU manager needs reservedSystemCPUs")
    _one_of(spec, "nodes.kubelet.topologyManagerPolicy", VALID_TOPOLOGY_MANAGER_POLICIES)
    _one_of(spec, "nodes.kubelet.topologyManagerScope", VALID_TOPOLOGY_MANAGER_SCOPES)
    for size, count in (_at(spec, "nodes.hugepages") or {}).items():
        if size not in HUGEPAGE_SIZES:
            raise ValueError(
                "ClusterConfig nodes.hugepages: hugepages page sizes are "
                f"{' and '.join(HUGEPAGE_SIZES)}: {size}")
        if count < 0:
            raise ValueError(
                f"ClusterConfig nodes.hugepages: hugepage counts are 0 or more: {size}")
        if count > INT32_MAX:
            raise ValueError(
                f"ClusterConfig nodes.hugepages: {size}: {count} pages (at most {INT32_MAX})")
