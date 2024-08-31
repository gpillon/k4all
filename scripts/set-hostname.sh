#!/bin/bash

# Enable strict mode and pipefail for robust error handling
set -euo pipefail

if [ -f "/var/lib/hostname-setup.done" ]; then
  echo "Hostname setup already done. Exiting."
  exit 0
fi

# Function to generate random suffix
generate_random_suffix() {
    echo "$(openssl rand -base64 64 | tr -dc 'a-z0-9' | head -c 5)"
}

# Function to check for node type and adjust hostname accordingly
set_static_hostname() {
    local node_type_suffix="unknown" # Default value if file does not exist or is empty

    if [ -f "/etc/node-type" ]; then
        # Read content, trim spaces/newlines, and append
        local content=$(cat /etc/node-type | tr -d ' \n')
        if [[ -n "$content" ]]; then
            node_type_suffix="$content"
        fi
    fi

    echo "kube-$node_type_suffix-$(generate_random_suffix)"
}

# Define the static hostname part using the function
STATIC_HOSTNAME=$(set_static_hostname)

# Function to retrieve the domain from DHCP using systemd-resolved
function get_domain() {
    local domain=""
    local retry_count=0
    local max_retries=5
    local sleep_interval=5  # Wait time between retries in seconds

    while [[ $retry_count -lt $max_retries ]]; do
        # Capture the output of systemd-resolve
        domain=$(systemd-resolve --status 2>/dev/null | grep "DNS Domain:" | awk '{print $3}' || echo "")

        if [[ -n "$domain" ]]; then
            echo "$domain"
            return
        fi

        echo "DNS domain not found, retrying in $sleep_interval seconds..." 1>&2
        sleep $sleep_interval
        retry_count=$((retry_count + 1))
    done
}

# Attempt to retrieve the domain part from DHCP
DOMAIN=$(get_domain)

# Determine the full hostname
if [[ -z "$DOMAIN" ]]; then
    FULL_HOSTNAME="$STATIC_HOSTNAME"
else
    FULL_HOSTNAME="$STATIC_HOSTNAME.$DOMAIN"
fi

# Set the hostname using the hostnamectl command
hostnamectl set-hostname "$FULL_HOSTNAME"

echo "Hostname set to $FULL_HOSTNAME"
touch /var/lib/hostname-setup.done
