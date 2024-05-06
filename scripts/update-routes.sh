#!/bin/bash

# Function to get the current IP address
get_ip() {
    hostname -I | awk '{print $1}'
}

# Function to get the current FQDN
get_fqdn() {
    hostname -f
}

# Function to check if the FQDN contains a domain part
has_domain() {
    local fqdn=$1
    [[ "$fqdn" =~ \. ]]
}

# Function to patch the ingress with a given host
patch_ingress() {
    local host=$1

    kubectl --kubeconfig=/root/.kube/config patch ingress kubernetes-dashboard -n kubernetes-dashboard --type=json -p="[
      {
        \"op\": \"replace\",
        \"path\": \"/spec/rules/$2/host\",
        \"value\": \"dashboard.$host\"
      }
    ]"
}

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
ip=$(get_ip)
fqdn=$(get_fqdn)

# Create the nip.io route
nip_host="$ip.nip.io"

# Check if the FQDN has a domain part
if has_domain "$fqdn"; then
    fqdn_host=$fqdn
else
    fqdn_host="kube-control-01.local"  # Fallback FQDN
fi

# Patch the ingress with the FQDN route first
patch_ingress "$fqdn_host" 1

# Patch the ingress with the nip.io route
patch_ingress "$nip_host" 0

# Update the MOTD with both routes
update_motd "$fqdn_host" "$nip_host"
