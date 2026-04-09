#!/bin/bash
# K4All - Kubernetes Setup Phase 1
# With bootc, all packages are pre-installed in the container image.
# This script just verifies that required packages are available.
set -euo pipefail

DONE_FILE="/opt/k4all/k8s-setup-ph1.done"

if [ -f "$DONE_FILE" ]; then
    echo "Kubernetes setup phase 1 already done. Exiting."
    exit 0
fi

echo "Creating /var/opt/ directories..."
mkdir -p /var/opt/libexec/
mkdir -p /var/opt/cni/
mkdir -p /var/opt/k4all/

echo "Verifying pre-installed packages..."

REQUIRED_COMMANDS=(kubeadm kubelet kubectl crio jq)
MISSING=()

for cmd in "${REQUIRED_COMMANDS[@]}"; do
    if ! command -v "$cmd" &>/dev/null; then
        MISSING+=("$cmd")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "ERROR: Required commands not found: ${MISSING[*]}"
    echo "These should be pre-installed in the bootc image."
    exit 1
fi

echo "Extracting images from cache..."
for img in /var/opt/k4all/.imagecache/*.tar; do
    podman load -i "$img"
    rm -f "$img"
    echo "Extracted $img"
done

echo "All required packages verified."

mkdir -p /opt/k4all
touch "$DONE_FILE"
echo "Setup phase 1 completed."
