#!/bin/bash
set -euxo pipefail

# Check if the state file exists
if [ -f "/var/lib/lvm-setup.done" ]; then
  echo "LVM setup already done. Exiting."
  exit 0
fi

# Check if PV already exists
if ! pvdisplay /dev/sda5 &> /dev/null; then
  echo "Creating physical volume on /dev/sda5..."
  pvcreate /dev/sda5
else
  echo "Physical volume on /dev/sda5 already exists."
fi

# Check if VG already exists
if ! vgdisplay vg_data &> /dev/null; then
  echo "Creating volume group vg_data..."
  vgcreate vg_data /dev/sda5
else
  echo "Volume group vg_data already exists."
fi

# Create the state file to indicate the setup is complete
touch /var/lib/lvm-setup.done
echo "LVM setup completed."
