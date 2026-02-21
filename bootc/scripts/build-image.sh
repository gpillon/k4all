#!/bin/bash
# Build K4All bootc OCI image
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"

# Default values
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/gpillon/k4all-bootc}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "=== Building K4All bootc image ==="
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo "Context: ${BOOTC_DIR}"

cd "$BOOTC_DIR"

# Build the image
podman build \
    --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
    --file Containerfile \
    .

echo ""
echo "=== Build complete ==="
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "To push the image:"
echo "  podman push ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "To build an ISO:"
echo "  ./scripts/build-iso.sh ${IMAGE_NAME}:${IMAGE_TAG}"

