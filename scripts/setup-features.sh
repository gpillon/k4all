#!/bin/bash
set -euxo pipefail

if [ -f "/var/lib/features-setup.done" ]; then
  echo "Features setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

function install_virt() {

    # Extract the virt.enabled value from the JSON configuration file
    local virt_enabled=$(jq -r '.features.virt.enabled' "$K4ALL_CONFIG_FILE")
    local cni_to_install="calico"

    if [ "$virt_enabled" = "true" ]; then
        /usr/local/bin/setup-feature-virt.sh
    fi

    # Output the result
    echo "Success: Installed Virt Feature"
}

if [ ! -f "$K4ALL_CONFIG_FILE" ]; then
    # Configuration file does not exist
    echo "Warining: no config file not found, Skipping Features"
    return
fi

install_virt

touch /var/lib/features-setup.done