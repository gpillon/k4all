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

# The ingress controller is Traefik. Its settings are spec.ingress.traefik;
# configs written before v2.6.0 only have spec.ingress.nginx, which Traefik
# then follows (same rule as the operator's Traefik hook).
if [ "$(yq e '.spec.ingress.traefik != null' "$K4ALL_CONFIG_FILE")" = "true" ]; then
    INGRESS_KEY=traefik
else
    INGRESS_KEY=nginx
fi
# Not `// "true"`: yq's // also replaces an explicit false.
INGRESS_IS_DEFAULT=$(yq e ".spec.ingress.${INGRESS_KEY}.isDefault" "$K4ALL_CONFIG_FILE")
[ "$INGRESS_IS_DEFAULT" = "null" ] && INGRESS_IS_DEFAULT=true
INGRESS_DEDICATED_IP=$(yq e ".spec.ingress.${INGRESS_KEY}.dedicatedIP // \"\"" "$K4ALL_CONFIG_FILE")
CILIUM_DEDICATED_IP=$(yq e '.spec.ingress.cilium.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")

FQDN=$(get_fqdn)

INGRESS_IP=$(get_cluster_ip)
if [ "$INGRESS_IS_DEFAULT" = "true" ] && [ -n "$INGRESS_DEDICATED_IP" ] && [ "$INGRESS_DEDICATED_IP" != "null" ]; then
    INGRESS_IP="$INGRESS_DEDICATED_IP"
elif [ "$INGRESS_IS_DEFAULT" != "true" ] && [ -n "$CILIUM_DEDICATED_IP" ] && [ "$CILIUM_DEDICATED_IP" != "null" ]; then
    INGRESS_IP="$CILIUM_DEDICATED_IP"
fi

# Create the nip.io route
NIP_HOST="$INGRESS_IP.nip.io"

# Patch the ingress with the FQDN route first
patch_ingress "$FQDN" 1 "dashboard" "headlamp" "headlamp"

# Patch the ingress with the nip.io route
patch_ingress "$NIP_HOST" 0 "dashboard" "headlamp" "headlamp"

# Update the MOTD with both routes
update_motd "$FQDN" "$NIP_HOST"