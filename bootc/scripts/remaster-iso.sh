#!/bin/bash
# Remaster K4All ISO to include Anaconda addon and kickstart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"
ISO_DIR="${BOOTC_DIR}/iso"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <input-iso> [output-iso]"
    echo ""
    echo "This script remasters the bootc ISO to include:"
    echo "  - K4All Anaconda addon (updates.img)"
    echo "  - Modified boot parameters"
    exit 1
fi

INPUT_ISO="$1"
OUTPUT_ISO="${2:-${INPUT_ISO}}"

if ! command -v xorriso &>/dev/null; then
    echo "ERROR: xorriso is required. Install it with: dnf install xorriso"
    exit 1
fi

UPDATES_IMG="${ISO_DIR}/images/k4all_updates.img"
if [ ! -f "$UPDATES_IMG" ]; then
    echo "WARNING: ${UPDATES_IMG} not found."
    echo "Build the K4All Anaconda addon first."
    echo "Continuing without addon..."
    UPDATES_IMG=""
fi

WORK_DIR=$(mktemp -d)
trap "rm -rf ${WORK_DIR}" EXIT

echo "=== Remastering K4All ISO ==="
echo "Input: ${INPUT_ISO}"
echo "Output: ${OUTPUT_ISO}"

# Extract the boot flags from the original ISO so we can replay them
echo "Extracting boot configuration..."
BOOT_FLAGS_FILE="${WORK_DIR}/boot_flags.txt"
xorriso -indev "${INPUT_ISO}" -report_el_torito as_mkisofs 2>/dev/null | \
    grep -v "^xorriso\|^lib\|^Drive\|^Media\|^Boot\|^Volume\|^$" > "$BOOT_FLAGS_FILE"

# Get volume label from original ISO for inst.updates reference
VOLID=$(xorriso -indev "${INPUT_ISO}" -pvd_info 2>/dev/null | \
    grep -i "^Volume [Ii]d" | head -1 | sed 's/.*: *//;s/^ *//;s/ *$//;s/^"//;s/"$//;s/'"'"'//g')
echo "Volume ID: ${VOLID}"

# Extract ISO contents
echo "Extracting ISO..."
xorriso -osirrox on -indev "${INPUT_ISO}" -extract / "${WORK_DIR}/iso" 2>&1 | \
    grep -E "UPDATE.*files restored|^$" || true

# Make extracted files writable
chmod -R u+w "${WORK_DIR}/iso"

# Copy updates.img if available
if [ -n "$UPDATES_IMG" ]; then
    echo "Adding K4All Anaconda addon..."
    mkdir -p "${WORK_DIR}/iso/images"
    cp "$UPDATES_IMG" "${WORK_DIR}/iso/images/k4all_updates.img"
fi

UPDATES_PARAM=""
if [ -n "$UPDATES_IMG" ]; then
    UPDATES_PARAM="inst.updates=hd:LABEL=${VOLID}:/images/k4all_updates.img"
fi

# Modify GRUB configs — only kernel command lines (starting with whitespace + linux/linuxefi)
for grub_cfg in "${WORK_DIR}/iso/EFI/BOOT/grub.cfg" "${WORK_DIR}/iso/boot/grub2/grub.cfg"; do
    if [ -f "$grub_cfg" ] && [ -n "$UPDATES_PARAM" ]; then
        echo "Modifying GRUB config: $(basename $(dirname "$grub_cfg"))/$(basename "$grub_cfg")"
        sed -i "/^[[:space:]]*linux\(efi\)\{0,1\} /{/inst.updates/!s|$| ${UPDATES_PARAM}|}" "$grub_cfg"
    fi
done

# Modify isolinux config for BIOS boot (if present)
ISOLINUX_CFG="${WORK_DIR}/iso/isolinux/isolinux.cfg"
if [ -f "$ISOLINUX_CFG" ] && [ -n "$UPDATES_PARAM" ]; then
    echo "Modifying isolinux config..."
    sed -i "/^[[:space:]]*append /{/inst.updates/!s|$| ${UPDATES_PARAM}|}" "$ISOLINUX_CFG"
fi

# Copy the original ISO to work dir so we can reference it for boot sectors
# while writing the output (avoids Premature EOF on in-place remaster)
ORIG_ISO_COPY="${WORK_DIR}/original.iso"
cp "${INPUT_ISO}" "${ORIG_ISO_COPY}"

# Rebuild ISO preserving original boot configuration
echo "Rebuilding ISO..."
cd "${WORK_DIR}/iso"

# Build the xorriso command from extracted boot flags, replacing references
# to the original ISO with our safe copy
XORRISO_ARGS=()
while IFS= read -r line; do
    line="${line//${INPUT_ISO}/${ORIG_ISO_COPY}}"
    eval "XORRISO_ARGS+=( $line )" 2>/dev/null || true
done < "$BOOT_FLAGS_FILE"

xorriso -as mkisofs \
    -o "${OUTPUT_ISO}" \
    -R -J \
    "${XORRISO_ARGS[@]}" \
    .

echo ""
echo "=== Remaster complete ==="
echo "Output: ${OUTPUT_ISO}"
echo ""
echo "Boot the ISO and the K4All Anaconda addon will be loaded automatically."
