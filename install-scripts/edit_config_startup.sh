#!/bin/bash
set -euxo pipefail

# Define the file path
CONFIG_FILE="/usr/local/share/default-cluster-config.json"

# Get all Ethernet interfaces, ignoring lo
ETHERNET_INTERFACES=$(ip link | grep 'BROADCAST,MULTICAST' | awk -F ': ' '{print $2}' | tr '\n' ' ')

# Get all physical disks
PHYSICAL_DISKS=$(lsblk -nd -o NAME,SIZE,TYPE | grep ' disk' | awk '{print $1 "(" $2 ")"}' | tr '\n' ' ')

# Replace "found_eth_cards" with Ethernet interfaces in the JSON file
sed -i "s/found_eth_cards/$ETHERNET_INTERFACES/" $CONFIG_FILE

# Replace "found_disks" with physical disks in the JSON file
sed -i "s/found_disks/$PHYSICAL_DISKS/" $CONFIG_FILE

# # Check if KVM module is present
# if lsmod | grep -q kvm; then
#     # If KVM is present, change features.virt.emulation to "true"
#     jq '.features.virt.emulation = "true"' "$CONFIG_FILE" > tmp.$$.json && mv -f tmp.$$.json $CONFIG_FILE
# else
#     # Otherwise, set it to "false"
#     jq '.features.virt.emulation = "false"' "$CONFIG_FILE" > tmp.$$.json && mv -f tmp.$$.json $CONFIG_FILE
# fi

echo "Configuration updated."
