#!/bin/bash
set -euxo pipefail

if [ -f "/var/lib/cni-setup.done" ]; then
  echo "CNI setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

function install_cni() {
    # Check if the configuration file exists
    if [ ! -f "$K4ALL_CONFIG_FILE" ]; then
        # Configuration file does not exist, use the default network interface
        /usr/local/bin/setup-cni-calico.sh
        echo "Warining: config file not found, defaulting to calico"
        return
    fi

    # Extract the net_dev value from the JSON configuration file
    local cni=$(jq -r '.networking.cni' "$K4ALL_CONFIG_FILE")
    local cni_to_install="calico"

    if [ "$cni" = "cilium" ]; then
        cni_to_install="cilium"
    fi

    install_result=$(/usr/local/bin/setup-cni-$cni_to_install.sh)

    # Output the result
    echo "Installed cni $cni_to_install"
}

install_cni

touch /var/lib/cni-setup.done