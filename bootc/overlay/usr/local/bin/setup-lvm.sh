#!/bin/bash
# K4All - LVM vg_data Setup
# Creates or verifies the vg_data volume group for TopoLVM
set -euo pipefail

DONE_FILE="/opt/k4all/lvm-setup.done"

if [ -f "$DONE_FILE" ] && lvdisplay vg_data/thin-pool &>/dev/null; then
    echo "LVM setup already done and vg_data/thin-pool exists. Exiting."
    exit 0
elif [ -f "$DONE_FILE" ]; then
    echo "WARNING: stale LVM setup marker found without vg_data/thin-pool; repairing."
    rm -f "$DONE_FILE"
fi

# Check if vg_data already exists (created during install by Anaconda addon)
if vgdisplay vg_data &>/dev/null; then
    echo "Volume group vg_data already exists."
else
    # Check if vg_data is disabled in a legacy install config.
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
            if ! pvs "$candidate" &>/dev/null; then
                partition_name="$candidate"
                break
            fi
        fi
    done

    if [ -z "$partition_name" ]; then
        echo "WARNING: No partition available for vg_data - skipping LVM setup"
        echo "To use TopoLVM storage, create a partition and rerun this service"
        mkdir -p /opt/k4all
        touch "$DONE_FILE"
        exit 0
    fi

    echo "Using partition: ${partition_name}"

    if ! pvdisplay "$partition_name" &>/dev/null; then
        echo "Creating physical volume on ${partition_name}..."
        pvcreate "$partition_name"
    fi

    echo "Creating volume group vg_data..."
    vgcreate vg_data "$partition_name"
fi

# Create the thin pool required by the TopoLVM release manifest even when the
# Anaconda addon already created vg_data during installation.
if ! lvdisplay vg_data/thin-pool &>/dev/null; then
    existing_lvs=$(lvs --noheadings -o lv_name vg_data 2>/dev/null | wc -w)
    if [ "$existing_lvs" -gt 0 ]; then
        # Clusters installed before the thin pool existed keep their thick
        # TopoLVM volumes; a thin pool over 100%FREE would starve them.
        echo "WARNING: vg_data holds $existing_lvs volume(s) and no thin pool;"
        echo "         not creating one. Existing thick volumes stay usable."
    else
        echo "Creating thin pool vg_data/thin-pool..."
        lvcreate -l 100%FREE -T -n thin-pool vg_data
    fi
else
    echo "Thin pool vg_data/thin-pool already exists."
fi

# Mark setup complete
mkdir -p /opt/k4all
touch "$DONE_FILE"
echo "LVM setup completed."
