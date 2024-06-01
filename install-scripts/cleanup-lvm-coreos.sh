#!/bin/bash

set -euxo pipefail


# Specify the disk to clean
DISK="/dev/sda"

# Remove all logical volumes on the disk
for lv in $(lvs --noheadings -o lv_path | grep "$DISK"); do
    echo "Removing logical volume $lv..."
    lvremove -f "$lv" || { echo "Error removing logical volume $lv."; exit 1; }
done

# Remove all volume groups associated with the disk
for vg in $(vgs --noheadings -o vg_name | grep "$DISK"); do
    echo "Removing volume group $vg..."
    vgremove -f "$vg" || { echo "Error removing volume group $vg."; exit 1; }
done

# Wipe the disk's partition table
echo "Wiping all partitions on $DISK..."
wipefs -af "$DISK" || { echo "Error wiping partitions on $DISK."; exit 1; }

echo "Operation completed successfully."