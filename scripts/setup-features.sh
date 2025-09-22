#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/features-setup.done" ]; then
  echo "Features setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

function install_virt() {

    # Extract the virt.enabled value from the JSON configuration file
    local virt_enabled=$(jq -r '.features.virt.enabled' "$K4ALL_CONFIG_FILE")

    if [ "$virt_enabled" = "true" ]; then
        /usr/local/bin/setup-feature-virt.sh
    fi

    # Output the result
    echo "Success: Installed Virt Feature"
}

function install_argocd() {

    # Extract the virt.enabled value from the JSON configuration file
    local argocd_enabled=$(jq -r '.features.argocd.enabled' "$K4ALL_CONFIG_FILE")

    if [ "$argocd_enabled" = "true" ]; then
        /usr/local/bin/setup-feature-argocd.sh
    fi

    # Output the result
    echo "Success: Installed argocd Feature"
}


if [ ! -f "$K4ALL_CONFIG_FILE" ]; then
    # Configuration file does not exist
    echo "Warining: no config file not found, Skipping Features"
    return
fi

install_virt
install_argocd

touch /opt/k4all/features-setup.done