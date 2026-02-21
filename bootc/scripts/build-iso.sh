#!/bin/bash
# Build K4All ISO from bootc image using bootc-image-builder
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"

# Default values
OCI_IMAGE="${1:-ghcr.io/gpillon/k4all-bootc:latest}"
OUTPUT_DIR="${OUTPUT_DIR:-${BOOTC_DIR}/output}"

echo "=== Building K4All ISO ==="
echo "OCI Image: ${OCI_IMAGE}"
echo "Output: ${OUTPUT_DIR}"

mkdir -p "${OUTPUT_DIR}"

# Build ISO using bootc-image-builder
sudo podman run --rm -it --privileged --pull=newer \
    --security-opt label=type:unconfined_t \
    -v "${OUTPUT_DIR}":/output \
    -v /var/lib/containers/storage:/var/lib/containers/storage \
    quay.io/centos-bootc/bootc-image-builder:latest \
    --type iso \
    "${OCI_IMAGE}"

echo ""
echo "=== ISO build complete ==="
echo "Output: ${OUTPUT_DIR}"
echo ""
echo "Next step: Remaster the ISO to include the K4All Anaconda addon:"
echo "  ./scripts/remaster-iso.sh ${OUTPUT_DIR}/<iso-file>.iso"

