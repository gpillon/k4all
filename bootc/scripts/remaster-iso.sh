#!/bin/bash
# Remaster K4All ISO to include Anaconda addon and kickstart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"
ISO_DIR="${BOOTC_DIR}/iso"

# Check arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <input-iso> [output-iso]"
    echo ""
    echo "This script remasters the bootc ISO to include:"
    echo "  - K4All Anaconda addon (updates.img)"
    echo "  - Default kickstart (optional)"
    echo "  - Modified boot parameters"
    exit 1
fi

INPUT_ISO="$1"
OUTPUT_ISO="${2:-${INPUT_ISO%.iso}-k4all.iso}"

# Check dependencies
for cmd in xorriso mkisofs; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: $cmd is required. Install it with: dnf install xorriso genisoimage"
        exit 1
    fi
done

# Check if updates.img exists
UPDATES_IMG="${ISO_DIR}/images/k4all_updates.img"
if [ ! -f "$UPDATES_IMG" ]; then
    echo "WARNING: ${UPDATES_IMG} not found."
    echo "Build the K4All Anaconda addon first:"
    echo "  cd ../k4all-anaconda-addon && make"
    echo ""
    echo "Continuing without addon (interactive mode only)..."
    UPDATES_IMG=""
fi

# Create temp directory
WORK_DIR=$(mktemp -d)
trap "rm -rf ${WORK_DIR}" EXIT

echo "=== Remastering K4All ISO ==="
echo "Input: ${INPUT_ISO}"
echo "Output: ${OUTPUT_ISO}"

# Extract ISO
echo "Extracting ISO..."
xorriso -osirrox on -indev "${INPUT_ISO}" -extract / "${WORK_DIR}/iso"

# Copy updates.img if available
if [ -n "$UPDATES_IMG" ]; then
    echo "Adding K4All Anaconda addon..."
    mkdir -p "${WORK_DIR}/iso/images"
    cp "$UPDATES_IMG" "${WORK_DIR}/iso/images/k4all_updates.img"
fi

# Copy kickstart if available
KS_FILE="${ISO_DIR}/ks/ks.cfg"
if [ -f "$KS_FILE" ]; then
    echo "Adding kickstart..."
    mkdir -p "${WORK_DIR}/iso/ks"
    cp "$KS_FILE" "${WORK_DIR}/iso/ks/ks.cfg"
fi

# Modify GRUB config to add boot parameters
GRUB_CFG="${WORK_DIR}/iso/EFI/BOOT/grub.cfg"
if [ -f "$GRUB_CFG" ]; then
    echo "Modifying GRUB config..."
    # Add inst.updates parameter to all menu entries
    if [ -n "$UPDATES_IMG" ]; then
        sed -i 's|linux |linux inst.updates=cdrom:/images/k4all_updates.img |g' "$GRUB_CFG"
    fi
fi

# Modify isolinux config for BIOS boot
ISOLINUX_CFG="${WORK_DIR}/iso/isolinux/isolinux.cfg"
if [ -f "$ISOLINUX_CFG" ]; then
    echo "Modifying isolinux config..."
    if [ -n "$UPDATES_IMG" ]; then
        sed -i 's|append |append inst.updates=cdrom:/images/k4all_updates.img |g' "$ISOLINUX_CFG"
    fi
fi

# Rebuild ISO
echo "Rebuilding ISO..."
cd "${WORK_DIR}/iso"

# Get volume ID from original ISO
VOLID=$(xorriso -indev "${INPUT_ISO}" -pvd_info 2>/dev/null | grep "Volume Id" | cut -d: -f2 | tr -d ' ' || echo "K4ALL")

xorriso -as mkisofs \
    -o "${OUTPUT_ISO}" \
    -R -J -V "${VOLID}" \
    -b isolinux/isolinux.bin \
    -c isolinux/boot.cat \
    -no-emul-boot \
    -boot-load-size 4 \
    -boot-info-table \
    -eltorito-alt-boot \
    -e images/efiboot.img \
    -no-emul-boot \
    -isohybrid-gpt-basdat \
    .

echo ""
echo "=== Remaster complete ==="
echo "Output: ${OUTPUT_ISO}"
echo ""
echo "Boot the ISO and the K4All Anaconda addon will be loaded automatically."

