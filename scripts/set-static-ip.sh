#!/bin/bash

# Enable strict mode and pipefail for robust error handling
set -exuo pipefail

if [ -f "/opt/k4all/setup-static-ip.done" ]; then
  echo "Static ip setup already done. Exiting."
  exit 0
fi

update_json_field() {
    local path="$1"
    local value="$2"
    local config_file="$3"
    local temp_file="temp.json.$$"

    jq "$path |= \"$value\"" "$config_file" > "$temp_file" && mv "$temp_file" "$config_file"
}

if [ "$CURRENT_IP_CONFIG" = "dhcp" ]; then
    NET_DEV=$(get_network_device)

    # Retrieve all IP addresses and subnet masks
    IP_ADDRESSES=$(nmcli -g IP4.ADDRESS dev show "${NET_DEV}")

    # Assuming you want to work with the first IP address and subnet mask
    FIRST_IP_ADDRESS=$(echo "${IP_ADDRESSES}" | head -n 1)

    # Parse the IP address and the subnet mask
    IP_ADDR=$(echo $FIRST_IP_ADDRESS | cut -d'/' -f1)
    SUBNET_CIDR=$(echo $FIRST_IP_ADDRESS | cut -d'/' -f2 | awk '{print $1}')  # Assuming CIDR notation is first if multiple fields

    # Retrieve IP, Gateway, DNS, and Domain information from the original network device
    GATEWAY=$(nmcli -g IP4.GATEWAY dev show "${NET_DEV}")
    DNS=$(nmcli -t -f IP4.DNS dev show "${NET_DEV}" | awk -F":" '{print $2}' | paste -sd "," -)
    SEARCH=$(nmcli -g IP4.DOMAIN dev show "${NET_DEV}")

    update_json_field '.networking.iface.ipconfig' "static" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.ipaddr' "$IP_ADDR" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.gateway' "$GATEWAY" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.subnet_mask' "$SUBNET_CIDR" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.dns' "$DNS" "$K4ALL_CONFIG_FILE"
    update_json_field '.networking.iface.dns_search' "$SEARCH" "$K4ALL_CONFIG_FILE"
fi

touch /opt/k4all/setup-static-ip.done
