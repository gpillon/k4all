#!/bin/bash
# K4All - LVM vg_data Setup
# Creates or verifies the vg_data volume group for TopoLVM
set -euo pipefail

DONE_FILE="/opt/k4all/lvm-setup.done"

if [ -f "$DONE_FILE" ]; then
    echo "LVM setup already done. Exiting."
    exit 0
fi

# Check if vg_data already exists (created during install by Anaconda addon)
if vgdisplay vg_data &>/dev/null; then
    echo "Volume group vg_data already exists."
    touch "$DONE_FILE"
    echo "LVM setup completed (vg_data pre-existing)."
    exit 0
fi

# Check if vg_data is disabled in config
if [ -f /etc/k4all-config.json ]; then
    VG_ENABLED=$(jq -r '.storage.vg_data.enabled // "true"' /etc/k4all-config.json)
    if [ "$VG_ENABLED" = "false" ]; then
        echo "vg_data is disabled in config."
        touch "$DONE_FILE"
        exit 0
    fi
fi

echo "vg_data not found, attempting to create..."

# Find root disk
disk_name=$(/usr/local/bin/disk-helper.sh)
echo "Root disk detected: $disk_name"

# Check the partition naming convention dynamically
if ls /dev/${disk_name}* 2>/dev/null | grep -q "${disk_name}p"; then
    partition_suffix="p"
elif ls /dev/${disk_name}* 2>/dev/null | grep -q "${disk_name}[0-9]"; then
    partition_suffix=""
else
    echo "No partitions detected, using default naming convention"
    partition_suffix=""
fi

# Try partition 5 first (legacy layout), then look for any free partition
partition_name=""
for num in 5 6 7 4; do
    candidate="/dev/${disk_name}${partition_suffix}${num}"
    if [ -b "$candidate" ]; then
        # Check if not already a PV
        if ! pvs "$candidate" &>/dev/null; then
            partition_name="$candidate"
            break
        fi
    fi
done

if [ -z "$partition_name" ]; then
    echo "ERROR: No suitable partition found for vg_data"
    echo "Please ensure a partition is available for LVM storage"
    exit 1
fi

echo "Using partition: ${partition_name}"

# Create physical volume
if ! pvdisplay "$partition_name" &>/dev/null; then
    echo "Creating physical volume on ${partition_name}..."
    pvcreate "$partition_name"
else
    echo "Physical volume on ${partition_name} already exists."
fi

# Create volume group
if ! vgdisplay vg_data &>/dev/null; then
    echo "Creating volume group vg_data..."
    vgcreate vg_data "$partition_name"
else
    echo "Volume group vg_data already exists."
fi

# Mark setup complete
mkdir -p /opt/k4all
touch "$DONE_FILE"
echo "LVM setup completed."
