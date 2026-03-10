#!/bin/bash
# Build K4All ISO from bootc image using bootc-image-builder
#
# Usage:
#   ./build-iso.sh [OCI_IMAGE]                          # default: anaconda-iso, attended
#   ISO_MODE=unattended-bootstrap ./build-iso.sh
#   ISO_MODE=unattended-worker   ./build-iso.sh
#   ISO_MODE=attended            ./build-iso.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"

OCI_IMAGE="${1:-ghcr.io/gpillon/k4all-bootc:latest}"
OUTPUT_DIR="${OUTPUT_DIR:-${BOOTC_DIR}/output}"
ISO_MODE="${ISO_MODE:-attended}"

# cache directories for osbuild-worker
STORE_DIR="${BOOTC_DIR}/.cache/osbuild-store"
RPMMD_DIR="${BOOTC_DIR}/.cache/rpmmd"
mkdir -p "${STORE_DIR}" "${RPMMD_DIR}"

CONFIG_DIR="${BOOTC_DIR}/iso/config"

case "$ISO_MODE" in
    unattended-bootstrap)
        CONFIG_FILE="${CONFIG_DIR}/unattended-bootstrap.toml"
        ISO_SUFFIX="bootstrap"
        ;;
    unattended-control)
        CONFIG_FILE="${CONFIG_DIR}/unattended-control.toml"
        ISO_SUFFIX="control"
        ;;
    unattended-worker)
        CONFIG_FILE="${CONFIG_DIR}/unattended-worker.toml"
        ISO_SUFFIX="worker"
        ;;
    attended)
        CONFIG_FILE="${CONFIG_DIR}/attended.toml"
        ISO_SUFFIX="attended"
        ;;
    *)
        echo "ERROR: Unknown ISO_MODE='${ISO_MODE}'"
        echo "Valid modes: attended, unattended-bootstrap, unattended-control, unattended-worker"
        exit 1
        ;;
esac

if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: Config file not found: ${CONFIG_FILE}"
    exit 1
fi

echo "=== Building K4All ISO ==="
echo "Mode:   ${ISO_MODE}"
echo "Config: ${CONFIG_FILE}"
echo "Image:  ${OCI_IMAGE}"
echo "Output: ${OUTPUT_DIR}"
echo ""

mkdir -p "${OUTPUT_DIR}"

sudo podman run --rm -it --privileged --pull=newer \
    --security-opt label=type:unconfined_t \
    -v "${CONFIG_FILE}":/config.toml:ro \
    -v "${OUTPUT_DIR}":/output \
    -v "${STORE_DIR}":/store \
    -v "${RPMMD_DIR}":/rpmmd \
    -v /var/lib/containers/storage:/var/lib/containers/storage \
    quay.io/centos-bootc/bootc-image-builder:latest \
    --type anaconda-iso \
    --rootfs xfs \
    --use-librepo=True \
    "${OCI_IMAGE}"

# bootc-image-builder outputs to bootiso/install.iso inside OUTPUT_DIR
BIB_OUTPUT="${OUTPUT_DIR}/bootiso/install.iso"
FINAL_NAME="${OUTPUT_DIR}/k4all-${ISO_SUFFIX}.iso"

if [ -f "$BIB_OUTPUT" ]; then
    mv "$BIB_OUTPUT" "$FINAL_NAME"
    rmdir "${OUTPUT_DIR}/bootiso" 2>/dev/null || true
else
    echo "ERROR: Expected output not found at ${BIB_OUTPUT}"
    echo "Checking for ISO files..."
    find "${OUTPUT_DIR}" -name "*.iso" -newer "${CONFIG_FILE}" 2>/dev/null
    exit 1
fi

echo ""
echo "=== ISO build complete ==="
echo "Output: ${FINAL_NAME}"
echo ""
echo "Next step: Remaster to include the K4All Anaconda addon:"
echo "  ./scripts/remaster-iso.sh ${FINAL_NAME}"
