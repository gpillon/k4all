#!/bin/bash
# K4All - Setup Helm
# With bootc, Helm is pre-installed in the container image.
# This script verifies Helm is available or installs it as a fallback.
set -euo pipefail

DONE_FILE="/opt/k4all/helm-setup.done"

if [ -f "$DONE_FILE" ]; then
    echo "Helm setup already done. Exiting."
    exit 0
fi

source /usr/local/bin/k4all-utils

# Check if Helm is already installed (should be in bootc image)
if command -v helm &>/dev/null; then
    echo "Helm is already installed: $(helm version --short)"
    mkdir -p /opt/k4all
    touch "$DONE_FILE"
    echo "Helm setup completed (pre-installed)."
    exit 0
fi

# Fallback: install Helm if not found (shouldn't happen with bootc)
echo "WARNING: Helm not found in image, installing from internet..."
HOME=/root/
helm_install_url="https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3"

retry_command "curl -fsSL $helm_install_url | bash" 10 5
helm completion bash > /etc/bash_completion.d/helm

mkdir -p /opt/k4all
touch "$DONE_FILE"
echo "Helm setup completed (downloaded)."
