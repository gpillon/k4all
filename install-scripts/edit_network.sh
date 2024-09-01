#!/bin/bash

set -euxo pipefail

# Define paths
CONFIG_FILE="/etc/k4all-config.json"
IGNITION_FILE="/usr/local/bin/k8s.ign"
TMP_JSON_MODIFIED="/tmp/k8s_modified.json"

# Function to get the first network interface name
get_first_interface_name() {
  ip -o link show | awk -F': ' '{print $2}' | grep -v 'lo' | head -n 1
}

# Function to convert subnet mask to prefix
subnetmask_to_prefix() {
  local subnet_mask=$1
  echo "$subnet_mask" | awk '
  function count1s(N){
      c = 0
      for(i=0; i<8; ++i) if(and(2**i, N)) ++c
      return c
  }
  function subnetmaskToPrefix(subnetmask) {
      split(subnetmask, v, ".")
      return count1s(v[1]) + count1s(v[2]) + count1s(v[3]) + count1s(v[4])
  }
  {
      print(subnetmaskToPrefix($1))
  }'
}

# Function to edit the Ignition file for static IP configuration
edit_ignition_for_static_ip() {
  # Read configuration values from the JSON file
  IP_ADDR=$(jq -r '.networking.ipaddr' "$CONFIG_FILE")
  SUBNET_MASK=$(jq -r '.networking.subnet_mask' "$CONFIG_FILE")
  GATEWAY=$(jq -r '.networking.gateway' "$CONFIG_FILE")
  DNS=$(jq -r '.networking.dns' "$CONFIG_FILE" | tr ',' ';')
  DNS_SEARCH=$(jq -r '.networking.dns_search' "$CONFIG_FILE" | tr ',' ';')
  INTERFACE_NAME=$(get_first_interface_name)
  PREFIX=$(subnetmask_to_prefix "$SUBNET_MASK")

  # Prepare the contents to be added to the Ignition file
  STATIC_IP_CONTENT=$(cat <<EOF
{
  "path": "/etc/NetworkManager/system-connections/$INTERFACE_NAME.nmconnection",
  "mode": 384,
  "contents": {
    "source": "data:;base64,$(echo -n "[connection]
id=$INTERFACE_NAME
type=ethernet
interface-name=$INTERFACE_NAME
[ipv4]
address1=$IP_ADDR/$PREFIX,$GATEWAY
dns=$DNS
dns-search=$DNS_SEARCH
may-fail=false
method=manual" | base64 -w 0)"
  }
}
EOF
  )

  # Note on base64: -w 0 is used to prevent line wrapping, default is 76 characters per line

  # Merge the new configuration into the existing Ignition file
  jq ".storage.files += [$STATIC_IP_CONTENT]" "$IGNITION_FILE" > "$TMP_JSON_MODIFIED"
  mv "$TMP_JSON_MODIFIED" "$IGNITION_FILE"
}

# Main script logic

# Check if the configuration is static and edit the Ignition file accordingly
if jq -e '.networking.ipconfig' "$CONFIG_FILE" | grep -q "static"; then
  edit_ignition_for_static_ip
fi

echo "The ignition file has been updated for network configuration."
