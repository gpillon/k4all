#!/bin/bash

# Enable strict mode and pipefail for robust error handling
set -exuo pipefail

if [ -f "/opt/k4all/setup-static-ip.done" ]; then
  echo "Static ip setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

update_json_field() {
    local path="$1"
    local value="$2"
    local config_file="$3"
    local temp_file="/tmp/temp.json.$$"

    jq "$path |= \"$value\"" "$config_file" > "$temp_file" && mv "$temp_file" "$config_file"
}

CURRENT_DEV=$(jq -r '.networking.iface.dev' "$K4ALL_CONFIG_FILE")
if [ "$CURRENT_DEV" = "auto" ]; then
    PHYS_NET_DEV=$(get_real_interface)
    update_json_field '.networking.iface.dev' "$PHYS_NET_DEV" "$K4ALL_CONFIG_FILE"
fi


CURRENT_IP_CONFIG=$(jq -r '.networking.iface.ipconfig' "$K4ALL_CONFIG_FILE")
if [ "$CURRENT_IP_CONFIG" = "dhcp" ]; then
    NET_DEV=$(get_network_device)

    # Retrieve all IP addresses and subnet masks
    IP_ADDRESSES=$(nmcli -g IP4.ADDRESS dev show "${NET_DEV}" | head -n 1 | cut -d' ' -f1)

    # Assuming you want to work with the first IP address and subnet mask
    FIRST_IP_ADDRESS=$(echo "${IP_ADDRESSES}" | head -n 1)

    # Parse the IP address and the subnet mask
    IP_ADDR=$(echo $FIRST_IP_ADDRESS | cut -d'/' -f1)
    SUBNET_CIDR=$(echo $FIRST_IP_ADDRESS | cut -d'/' -f2 | awk '{print $1}')  # Assuming CIDR notation is first if multiple fields
    SUBNET_MASK=$(cidr_to_mask $SUBNET_CIDR)

    # Retrieve IP, Gateway, DNS, and Domain information from the original network device
    GATEWAY=$(nmcli -g IP4.GATEWAY dev show "${NET_DEV}")
    DNS=$(nmcli -t -f IP4.DNS dev show "${NET_DEV}" | awk -F":" '{print $2}' | paste -sd "," -)
    DNS_SEARCH=$(nmcli -g IP4.DOMAIN dev show "${NET_DEV}")

    update_json_field '.networking.iface.ipconfig' "static" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.ipaddr' "$IP_ADDR" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.gateway' "$GATEWAY" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.subnet_mask' "$SUBNET_MASK" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.dns' "$DNS" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.dns_search' "$DNS_SEARCH" "$K4ALL_CONFIG_FILE"
fi

touch /opt/k4all/setup-static-ip.done
