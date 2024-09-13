#!/bin/bash

set -euxo pipefail

DISK=$(/usr/local/bin/disk-helper.sh)
CONFIG_FILE="/etc/k4all-config.json"
KEEP_LVM=$(jq -r '.disk.keep_lvm' "$CONFIG_FILE")

# If KEEP_LVM is true, do nothing
if [ "$KEEP_LVM" == "true" ]; then
    echo "KEEP_LVM is set to true. No LVM removal will be performed."
else 
    PARTITIONS=$(lsblk -rno NAME,TYPE | grep -E "^${DISK}[5-9]|^${DISK}[1-9][0-9]*" | awk '$2=="part" {print "/dev/" $1}')

    if [ -z "$PARTITIONS" ]; then
        echo "No partitions found on ${DISK} with partition number 5 or greater."
        exit 1
    fi

    # Loop through all identified partitions and check for LVM
    for PARTITION in $PARTITIONS; do
        echo "Checking partition: $PARTITION"
        
        # Check if the partition is an LVM physical volume
        VG_NAMES=$(pvs --noheadings -o vg_name $PARTITION | awk '{$1=$1};1' | sort -u)
        
        if [ -n "$VG_NAMES" ]; then
            echo "Found LVM on partition $PARTITION, volume groups: $VG_NAMES"
            
            # Loop through each volume group and delete the logical volumes and volume group
            for VG_NAME in $VG_NAMES; do
                echo "Deactivating logical volumes in volume group $VG_NAME..."
                lvchange -an $VG_NAME
                
                echo "Removing logical volumes in volume group $VG_NAME..."
                lvremove -f /dev/$VG_NAME/*
                
                echo "Removing volume group $VG_NAME..."
                vgremove -f $VG_NAME
            done

            # Remove the physical volume associated with the partition
            echo "Removing physical volume $PARTITION..."
            pvremove $PARTITION
        else
            echo "$PARTITION is not an LVM partition."
        fi
    done
    echo "All LVM configurations related to partitions on $DISK with number 5 or greater have been successfully removed."
fi

echo "Operation completed successfully."