#!/bin/bash
set -euxo pipefail

for device in /sys/block/*; do
  # Exclude usb, loop, ram, rom, and sr (scsi rom) devices
  if [[ "$(readlink -f ${device})" =~ (usb|loop|ram|rom|sr) ]]; then
    continue  # Skip these devices
  fi
  disk_name=$(basename ${device})
  break  # Stop at the first non-excluded device
done

# Check if a disk name was found
if [[ -z "${disk_name}" ]]; then
  exit 1
else
  echo "${disk_name}"
fi
