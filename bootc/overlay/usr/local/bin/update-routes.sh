#!/bin/bash

set -euo pipefail

source /opt/k4all/bin/control-plane-utils

# Function to update the MOTD
update_motd() {
    local fqdn_host=$1
    local nip_host=$2

    truncate -s 0 /etc/login_data
    echo " - FQDN Route: https://dashboard.$fqdn_host/" | sudo tee -a /etc/login_data
    echo " - nip.io Route: https://dashboard.$nip_host/" | sudo tee -a /etc/login_data
}

NGINX_INGRESS_ENABLED=$(jq -r '.ingress.nginx.enabled // "true"' "$K4ALL_CONFIG_FILE")
NGINX_IS_DEFAULT=$(jq -r '.ingress.nginx.isDefault // "true"' "$K4ALL_CONFIG_FILE")
NGINX_INGRESS_DEDICATED_IP=$(jq -r '.ingress.nginx.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")

CILIUM_INGRESS_ENABLED=$(jq -r '.ingress.cilium.enabled // "false"' "$K4ALL_CONFIG_FILE")
CILIUM_INGRESS_DEDICATED_IP=$(jq -r '.ingress.cilium.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
CILIUM_INGRESS_IS_DEFAULT=$(jq -r '.ingress.cilium.isDefault // "false"' "$K4ALL_CONFIG_FILE")

FQDN=$(get_fqdn)

INGRESS_IP=$(get_cluster_ip)
if [ "$NGINX_INGRESS_ENABLED" = "true" ] && [ "$NGINX_INGRESS_DEDICATED_IP" != "true" ]; then
    INGRESS_IP="$NGINX_INGRESS_DEDICATED_IP"
elif [ "$CILIUM_INGRESS_ENABLED" = "true" ] && [ "$CILIUM_INGRESS_DEDICATED_IP" != "true" ]; then
    INGRESS_IP="$CILIUM_INGRESS_DEDICATED_IP"
fi

# Create the nip.io route
NIP_HOST="$INGRESS_IP.nip.io"

# Patch the ingress with the FQDN route first
patch_ingress "$FQDN" 1 "dashboard" "headlamp" "headlamp"

# Patch the ingress with the nip.io route
patch_ingress "$NIP_HOST" 0 "dashboard" "headlamp" "headlamp"

# Update the MOTD with both routes
update_motd "$FQDN" "$NIP_HOST"
