#!/bin/bash
# K4All - Configuration Migration
# Handles migration from legacy JSON (/etc/k4all-config.json) to the new
# ClusterConfig CR YAML (/etc/k4all-config.yaml), and future YAML-to-YAML
# schema upgrades.
set -euo pipefail

source /usr/local/bin/k4all-utils

CONFIG_YAML="/etc/k4all-config.yaml"
CONFIG_JSON="/etc/k4all-config.json"
RELEASE_MANIFEST="/etc/k4all-release.yaml"
RELEASE_MANIFEST_DEFAULT="/usr/local/share/k4all-release.yaml"

# =========================================================================
# JSON-to-YAML migration (one-time, for upgrades from pre-operator builds)
# =========================================================================
migrate_json_to_yaml() {
    echo "Migrating legacy JSON config to ClusterConfig CR YAML..."

    local cni_type firewalld_enabled virt_enabled virt_emulation argocd_enabled
    local ha_type ha_interface ha_vip ha_subnet
    local custom_api_ep api_hostname
    local http_proxy https_proxy no_proxy

    cni_type=$(jq -r '.networking.cni.type // "calico"' "$CONFIG_JSON")
    firewalld_enabled=$(jq -r '.networking.firewalld.enabled // "false"' "$CONFIG_JSON")
    virt_enabled=$(jq -r '.features.virt.enabled // "false"' "$CONFIG_JSON")
    virt_emulation=$(jq -r '.features.virt.emulation // "auto"' "$CONFIG_JSON")
    argocd_enabled=$(jq -r '.features.argocd.enabled // "false"' "$CONFIG_JSON")
    ha_type=$(jq -r '.cluster.ha.type // "none"' "$CONFIG_JSON")
    ha_interface=$(jq -r '.cluster.ha.interface // "auto"' "$CONFIG_JSON")
    ha_vip=$(jq -r '.cluster.ha.apiControlEndpoint // ""' "$CONFIG_JSON")
    ha_subnet=$(jq -r '.cluster.ha.apiControlEndpointSubnetSize // ""' "$CONFIG_JSON")
    # iface removed: network config now handled by Anaconda/NetworkManager
    custom_api_ep=$(jq -r '.cluster.customApiEndPoint // ""' "$CONFIG_JSON")
    api_hostname=$(jq -r '.cluster.apiEndPointUseHostName // "false"' "$CONFIG_JSON")
    http_proxy=$(jq -r '.proxy.http_proxy // ""' "$CONFIG_JSON")
    https_proxy=$(jq -r '.proxy.https_proxy // ""' "$CONFIG_JSON")
    no_proxy=$(jq -r '.proxy.no_proxy // ""' "$CONFIG_JSON")

    # Convert string booleans to YAML booleans
    [ "$firewalld_enabled" = "true" ] && firewalld_enabled="true" || firewalld_enabled="false"
    [ "$virt_enabled" = "true" ] && virt_enabled="true" || virt_enabled="false"
    [ "$argocd_enabled" = "true" ] && argocd_enabled="true" || argocd_enabled="false"
    [ "$api_hostname" = "true" ] && api_hostname="true" || api_hostname="false"

    cp /usr/local/share/k4all-config.yaml.default "$CONFIG_YAML"

    yq e ".spec.networking.cni.type = \"${cni_type}\"" -i "$CONFIG_YAML"
    yq e ".spec.networking.firewalld.enabled = ${firewalld_enabled}" -i "$CONFIG_YAML"
    yq e ".spec.features.virt.enabled = ${virt_enabled}" -i "$CONFIG_YAML"
    yq e ".spec.features.virt.emulation = \"${virt_emulation}\"" -i "$CONFIG_YAML"
    yq e ".spec.features.argocd.enabled = ${argocd_enabled}" -i "$CONFIG_YAML"
    yq e ".spec.cluster.ha.type = \"${ha_type}\"" -i "$CONFIG_YAML"
    yq e ".spec.cluster.ha.interface = \"${ha_interface}\"" -i "$CONFIG_YAML"
    yq e ".spec.cluster.ha.apiControlEndpoint = \"${ha_vip}\"" -i "$CONFIG_YAML"
    yq e ".spec.cluster.ha.apiControlEndpointSubnetSize = \"${ha_subnet}\"" -i "$CONFIG_YAML"
    yq e ".spec.cluster.customApiEndPoint = \"${custom_api_ep}\"" -i "$CONFIG_YAML"
    yq e ".spec.cluster.apiEndPointUseHostName = ${api_hostname}" -i "$CONFIG_YAML"
    yq e ".spec.proxy.httpProxy = \"${http_proxy}\"" -i "$CONFIG_YAML"
    yq e ".spec.proxy.httpsProxy = \"${https_proxy}\"" -i "$CONFIG_YAML"
    yq e ".spec.proxy.noProxy = \"${no_proxy}\"" -i "$CONFIG_YAML"

    mv "$CONFIG_JSON" "${CONFIG_JSON}.migrated"
    echo "JSON config migrated to YAML. Backup saved as ${CONFIG_JSON}.migrated"
}

# =========================================================================
# YAML-to-YAML schema upgrades (future version bumps)
# =========================================================================
migrate_yaml_schema() {
    echo "Checking ClusterConfig YAML schema version..."

    local api_version
    api_version=$(yq e '.apiVersion' "$CONFIG_YAML" 2>/dev/null || echo "")

    if [ "$api_version" != "k4all.magesgate.com/v1alpha1" ]; then
        echo "WARNING: Unknown apiVersion '$api_version' — skipping YAML migration"
        return
    fi

    # Ensure ingress section exists (added in operator v0.2.0)
    if [ "$(yq e '.spec.ingress' "$CONFIG_YAML")" = "null" ]; then
        yq e '.spec.ingress.nginx.isDefault = true' -i "$CONFIG_YAML"
        yq e '.spec.ingress.nginx.dedicatedIP = ""' -i "$CONFIG_YAML"
        yq e '.spec.ingress.cilium.dedicatedIP = ""' -i "$CONFIG_YAML"
        echo "  Added missing ingress section"
    fi

    # Ensure proxy section exists (added in operator v0.2.0)
    if [ "$(yq e '.spec.proxy' "$CONFIG_YAML")" = "null" ]; then
        yq e '.spec.proxy.httpProxy = ""' -i "$CONFIG_YAML"
        yq e '.spec.proxy.httpsProxy = ""' -i "$CONFIG_YAML"
        yq e '.spec.proxy.noProxy = ""' -i "$CONFIG_YAML"
        echo "  Added missing proxy section"
    fi

    echo "ClusterConfig YAML schema is up to date."
}

# =========================================================================
# Release manifest migration
# =========================================================================
migrate_release_manifest() {
    if [ ! -f "$RELEASE_MANIFEST" ]; then
        if [ -f "$RELEASE_MANIFEST_DEFAULT" ]; then
            cp "$RELEASE_MANIFEST_DEFAULT" "$RELEASE_MANIFEST"
            echo "Installed default release manifest"
        fi
        return
    fi

    if [ -f "$RELEASE_MANIFEST_DEFAULT" ]; then
        yq eval-all 'select(fileIndex == 0) * select(fileIndex == 1)' \
            "$RELEASE_MANIFEST" "$RELEASE_MANIFEST_DEFAULT" > /tmp/merged-release.yaml
        mv /tmp/merged-release.yaml "$RELEASE_MANIFEST"
        echo "Release manifest merged with defaults"
    fi
}

# =========================================================================
# Main
# =========================================================================
echo "K4All configuration migration starting..."

# Step 1: Migrate from legacy JSON if it exists
if [ -f "$CONFIG_JSON" ] && [ ! -f "$CONFIG_YAML" ]; then
    migrate_json_to_yaml
elif [ -f "$CONFIG_JSON" ] && [ -f "$CONFIG_YAML" ]; then
    echo "Both JSON and YAML configs exist — using YAML, archiving JSON"
    mv "$CONFIG_JSON" "${CONFIG_JSON}.migrated"
fi

# Step 2: Schema upgrades on existing YAML
if [ -f "$CONFIG_YAML" ]; then
    migrate_yaml_schema
fi

# Step 3: Release manifest
migrate_release_manifest

echo "K4All configuration migration complete."
