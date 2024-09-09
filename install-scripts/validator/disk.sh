#!/bin/bash

# Function to validate the networking section
validate_disk() {
  # Check for disk section
  if ! check_json_value '.disk'; then
    echo "Missing 'disk' section."
    return 1
  fi

  # Check for disk.root section
  if ! check_json_value '.disk.root'; then
    echo "Missing 'disk.root' section."
    return 1
  fi

  # Check for disk.root.disk section
  if ! check_json_value '.disk.root.disk'; then
    echo "Missing 'disk.root.disk' section."
    return 1
  fi

  # Check for disk.root.size_mib section
  if ! check_json_value '.disk.root.size_mib'; then
    echo "Missing 'disk.root.size_mib' section."
    return 1
  fi

  # Check for disk.root.size_mib is an integer
  if [ "$(is_json_integer '.disk.root.size_mib' "$CONFIG_FILE")" != "true" ]; then
    echo "Invalid 'disk.root.size_mib' value. Must be an integer."
    return 1
  fi

  # Check for disk.root.size_mib is greater than 12000
  if [[ $(jq -r '.disk.root.size_mib' "$CONFIG_FILE") -lt 12000 ]]; then
    echo "Invalid 'disk.root.size_mib' value. Must be greater than 12000."
    return 1
  fi

  # Check for disk.keep_lvm section
  if ! check_json_value '.disk.keep_lvm'; then
    echo "Missing 'disk.keep_lvm' section."
    return 1
  fi
  
  # Check if 'disk.keep_lvm has either 'true' or 'false' values
  KEEP_LVM=$(jq -r '.disk.keep_lvm' "$CONFIG_FILE")
  if [[ "$KEEP_LVM" != "true" && "$KEEP_LVM" != "false" ]]; then
    echo "Invalid 'disk.keep_lvm' value. Must be 'true' or 'false'."
    return 1
  fi

  echo "disk section is valid."
  return 0
}
