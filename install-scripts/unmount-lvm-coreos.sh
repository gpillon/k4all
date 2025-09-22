#!/bin/bash

set -euxo pipefail


#devices=$(lsblk -o NAME,TYPE | awk '$2 == "crypt" {print $1}')

# # Cicla su ogni dispositivo dm
# for device in $devices; do
    # # Verifica se è montato
    # mount_point=$(mount | grep "/dev/$device" | awk '{print $3}')
    
    # if [[ -n "$mount_point" ]]; then
        # echo "Smontando /dev/$device montato su $mount_point..."
        # sudo umount "/dev/$device"
        
        # if [[ $? -eq 0 ]]; then
            # echo "/dev/$device smontato con successo."
        # else
            # echo "Errore durante lo smontaggio di /dev/$device."
        # fi
    # else
        # echo "/dev/$device non è montato."
    # fi
# done

# volumes=$(lvs --noheadings -o lv_path)

# # Cicla su ogni volume logico
# for volume in $volumes; do
    # # Verifica se il volume è montato
    # mount_point=$(mount | grep "$volume" | awk '{print $3}')
    
    # if [[ -n "$mount_point" ]]; then
        # echo "Smontando $volume montato su $mount_point..."
        # sudo umount "$volume"
        
        # if [[ $? -eq 0 ]]; then
            # echo "$volume smontato con successo."
        # else
            # echo "Errore durante lo smontaggio di $volume."
        # fi
    # else
        # echo "$volume non è montato."
    # fi
# done

#!/bin/bash


dm_devices=$(sudo dmsetup ls --target linear | awk '{print $1}')

if [[ "$dm_devices" == "No" ]]; then
    echo "No linear-targeted dm devices found."
    exit 0
fi

# # Loop over each dm device
# for dm_device in $dm_devices; do
    # # Find its corresponding block device by resolving its symlink
    # # block_device=$(readlink -f /dev/mapper/$dm_device)

    # # # Check if the block device is mounted
    # # mount_point=$(mount | grep "$block_device" | awk '{print $3}')

    # # if [[ -n "$mount_point" ]]; then
        # # echo "Unmounting $block_device mounted on $mount_point..."
        # # sudo umount "$block_device"

        # # if [[ $? -eq 0 ]]; then
            # # echo "$block_device unmounted successfully."
        # # else
            # # echo "Error unmounting $block_device."
        # # fi
    # # else
        # # echo "$block_device is not mounted."
    # # fi

    # dmsetup remove $dm_device
# done

dmsetup remove_all -f