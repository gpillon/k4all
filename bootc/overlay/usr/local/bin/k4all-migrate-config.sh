#!/bin/bash
# K4All - Configuration Migration
# Handles migration from legacy JSON (/etc/k4all-config.json) to the new
# ClusterConfig CR YAML (/etc/k4all-config.yaml), and future YAML-to-YAML
# schema upgrades.
set -euo pipefail

# K4ALL_ROOT: the tests run the script against a fake root.
ROOT="${K4ALL_ROOT:-}"

source "$ROOT/usr/local/bin/k4all-utils"
CNI_NET_DIR="$ROOT/etc/cni/net.d"
K4ALL_CNI_SHARE="$ROOT/usr/local/share/k4all-cni"

CONFIG_YAML="$ROOT/etc/k4all-config.yaml"
CONFIG_JSON="$ROOT/etc/k4all-config.json"
CONFIG_DEFAULT="$ROOT/usr/local/share/k4all-config.yaml.default"
RELEASE_MANIFEST="$ROOT/etc/k4all-release.yaml"
RELEASE_MANIFEST_DEFAULT="$ROOT/usr/local/share/k4all-release.yaml"

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

    cp "$CONFIG_DEFAULT" "$CONFIG_YAML"
    # What a new v2.7.0 install gets is not this cluster's: absent, k4all
    # owns none of it, and nothing changes on the running cluster.
    yq e 'del(.spec.nodes) | del(.spec.features.virt.metadata) | del(.spec.features.rook)' -i "$CONFIG_YAML"

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

    # Ensure ingress section exists, for the controller the image runs:
    # Traefik (spec.ingress.traefik) from v2.4.0, ingress-nginx
    # (spec.ingress.nginx) before. With Traefik, spec.ingress.nginx moves
    # there just below.
    if [ "$(yq e '.spec.ingress' "$CONFIG_YAML")" = "null" ]; then
        local ingress_key=nginx
        traefik_is_active "$RELEASE_MANIFEST_DEFAULT" && ingress_key=traefik
        yq e ".spec.ingress.${ingress_key}.isDefault = true" -i "$CONFIG_YAML"
        yq e ".spec.ingress.${ingress_key}.dedicatedIP = \"\"" -i "$CONFIG_YAML"
        yq e '.spec.ingress.cilium.dedicatedIP = ""' -i "$CONFIG_YAML"
        echo "  Added missing ingress section (spec.ingress.${ingress_key})"
    fi

    migrate_ingress_nginx_to_traefik

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
# spec.ingress.nginx -> spec.ingress.traefik (from v2.4.0)
# =========================================================================
# Traefik replaced ingress-nginx in v2.4.0. Configs written before only have
# spec.ingress.nginx, which Traefik followed while spec.ingress.traefik was
# missing. Once the image runs Traefik, the nginx settings (dedicatedIP,
# isDefault) become spec.ingress.traefik, in the same place, unless that key
# already exists; then spec.ingress.nginx goes away. k4all-operator v0.5.0
# (pinned from v2.4.0) moves the ClusterConfig in the cluster the same way,
# during the v2.4.0 sync. The script ships from the v2.2.4 bridge on; before
# v2.4.0 the image runs no Traefik and nothing moves. Runs at every boot:
# without spec.ingress.nginx there is nothing left to do.
migrate_ingress_nginx_to_traefik() {
    traefik_is_active "$RELEASE_MANIFEST_DEFAULT" || return 0
    [ "$(yq e '(.spec.ingress // {}) | has("nginx")' "$CONFIG_YAML")" = "true" ] || return 0

    local backup="${CONFIG_YAML}.ingress-nginx.migrated"
    if [ ! -e "$backup" ]; then
        cp -p "$CONFIG_YAML" "$backup"
        echo "  Backup saved as $backup"
    fi

    if [ "$(yq e '.spec.ingress | has("traefik")' "$CONFIG_YAML")" = "true" ]; then
        yq e 'del(.spec.ingress.nginx)' -i "$CONFIG_YAML"
        echo "  Removed spec.ingress.nginx (spec.ingress.traefik already set)"
        return 0
    fi

    local dedicated_ip is_default
    dedicated_ip=$(yq e '.spec.ingress.nginx.dedicatedIP // ""' "$CONFIG_YAML")
    # Not `// true`: yq's // also replaces an explicit false. Left out, the
    # controller is the default class (as in the ClusterConfig CRD).
    is_default=$(yq e '.spec.ingress.nginx.isDefault' "$CONFIG_YAML")
    [ "$is_default" = "false" ] || is_default=true
    # Rename the key in place (order and comments stay), then write both
    # fields explicitly.
    INGRESS_IP="$dedicated_ip" yq e \
        '(.spec.ingress.nginx | key) = "traefik" |
         .spec.ingress.traefik.dedicatedIP = strenv(INGRESS_IP) |
         .spec.ingress.traefik.isDefault = '"$is_default" -i "$CONFIG_YAML"
    echo "  Moved spec.ingress.nginx to spec.ingress.traefik" \
         "(dedicatedIP '${dedicated_ip}', isDefault ${is_default})"
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
            "$RELEASE_MANIFEST" "$RELEASE_MANIFEST_DEFAULT" > "${RELEASE_MANIFEST}.merged"
        mv "${RELEASE_MANIFEST}.merged" "$RELEASE_MANIFEST"
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

# Step 4: CRI-O's example CNI networks, which the image no longer installs,
# go once the cluster's CNI is there (a new bootstrap node borrowed the
# bridge; ostree keeps an /etc file that was changed by hand).
drop_crio_cni

echo "K4All configuration migration complete."
