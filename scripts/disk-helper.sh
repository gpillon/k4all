#!/bin/bash
set -euxo pipefail

function get_root_disk() {
    # Path to the JSON configuration file
    local config_file="/etc/k4all-config.json"

    # Check if the configuration file exists and if disk.root.disk is specified
    if [[ -f "$config_file" ]]; then
        # Read the disk configuration from the JSON file
        local specified_disk=$(jq -r '.disk.root.disk' "$config_file")

        # Check if a specific disk is configured
        if [[ "$specified_disk" != "auto" ]]; then
            echo "$specified_disk"
            return
        fi
    fi

    # No specific disk configured, find the first suitable disk
    local disk_name=""
    for device in /sys/block/*; do
      # Exclude usb, loop, ram, rom, and sr (scsi rom) devices, as well as device mapper
      if [[ "$(readlink -f ${device})" =~ (usb|loop|ram|rom|sr|dm) ]]; then
        continue  # Skip these devices
      fi
      disk_name=$(basename ${device})
      break  # Stop at the first non-excluded device
    done

    # Check if a disk name was found
    if [[ -z "${disk_name}" ]]; then
      echo "No suitable disk found"
      exit 1
    else
      echo "${disk_name}"
    fi
}

# Example usage:
get_root_disk