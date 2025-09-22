#!/bin/bash

set -euxo pipefail

DISK=$(/usr/local/bin/disk-helper.sh)
# Specify the disk to clean
DISK_DEVICE=/dev/$DISK

# Remove all logical volumes on the disk
for lv in $(lvs --noheadings -o lv_path | grep "$DISK_DEVICE"); do
    echo "Removing logical volume $lv..."
    lvremove -f "$lv" || { echo "Error removing logical volume $lv."; exit 1; }
done

# Remove all volume groups associated with the disk
for vg in $(vgs --noheadings -o vg_name | grep "$DISK_DEVICE"); do
    echo "Removing volume group $vg..."
    vgremove -f "$vg" || { echo "Error removing volume group $vg."; exit 1; }
done

# Wipe the disk's partition table
echo "Wiping all partitions on $DISK_DEVICE..."
wipefs -af "$DISK_DEVICE" || { echo "Error wiping partitions on $DISK_DEVICE."; exit 1; }

echo "Operation completed successfully."