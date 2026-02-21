#!/bin/bash

source /usr/local/bin/control-plane-utils

# Function to update the MOTD
update_motd() {
    local fqdn_host=$1
    local nip_host=$2

    #echo "Kubernetes Dashboard Routes:" | sudo tee /etc/motd
    truncate -s 0 /etc/login_data
    echo " - FQDN Route: https://dashboard.$fqdn_host/" | sudo tee -a /etc/login_data
    echo " - nip.io Route: https://dashboard.$nip_host/" | sudo tee -a /etc/login_data
}

# Main logic
ip=$(get_cluster_ip)
fqdn=$(get_fqdn)

# Create the nip.io route
nip_host="$ip.nip.io"

# # Check if the FQDN has a domain part
# if has_domain "$fqdn"; then
#     fqdn_host=$fqdn
# else
#     fqdn_host="kube-control-01.local"  # Fallback FQDN
# fi

# Patch the ingress with the FQDN route first
patch_ingress "$fqdn" 1 "dashboard" "kubernetes-dashboard" "kubernetes-dashboard"

# Patch the ingress with the nip.io route
patch_ingress "$nip_host" 0 "dashboard" "kubernetes-dashboard" "kubernetes-dashboard"

# Update the MOTD with both routes
update_motd "$fqdn" "$nip_host"
