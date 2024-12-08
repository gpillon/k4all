#!/bin/bash
set -euxo pipefail

# Check if the state file exists
if [ -f "/opt/k4all/lvm-setup.done" ]; then
  echo "LVM setup already done. Exiting."
  exit 0
fi

disk_name=$(/usr/local/bin/disk-helper.sh)

# Check the partition naming convention dynamically
if ls /dev/${disk_name}* 2>/dev/null | grep -q "${disk_name}p"; then
  partition_suffix="p"
elif ls /dev/${disk_name}* 2>/dev/null | grep -q "${disk_name}[0-9]"; then
  partition_suffix=""
else
  echo "No partitions detected, using default naming convention"
  partition_suffix=""
fi

partition_name="${disk_name}${partition_suffix}5"
echo "The fifth partition is named: ${partition_name}"

# Check if PV already exists
if ! pvdisplay /dev/${partition_name} &> /dev/null; then
  echo "Creating physical volume on /dev/${partition_name}..."
  pvcreate /dev/${partition_name}
else
  echo "Physical volume on /dev/${partition_name} already exists."
fi

# Check if VG already exists
if ! vgdisplay vg_data &> /dev/null; then
  echo "Creating volume group vg_data..."
  vgcreate vg_data /dev/${partition_name}
else
  echo "Volume group vg_data already exists."
fi

# Create the state file to indicate the setup is complete
touch /opt/k4all/lvm-setup.done
echo "LVM setup completed."