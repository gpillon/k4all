#!/bin/bash
set -euxo pipefail

disk_name=$(/usr/local/bin/disk-helper.sh)

# Check if the state file exists
if [ -f "/var/lib/lvm-setup.done" ]; then
  echo "LVM setup already done. Exiting."
  exit 0
fi

# Check if PV already exists
if ! pvdisplay /dev/${disk_name}5 &> /dev/null; then
  echo "Creating physical volume on /dev/${disk_name}5..."
  pvcreate /dev/${disk_name}5
else
  echo "Physical volume on /dev/${disk_name}5 already exists."
fi

# Check if VG already exists
if ! vgdisplay vg_data &> /dev/null; then
  echo "Creating volume group vg_data..."
  vgcreate vg_data /dev/${disk_name}5
else
  echo "Volume group vg_data already exists."
fi

# Create the state file to indicate the setup is complete
touch /var/lib/lvm-setup.done
echo "LVM setup completed."
