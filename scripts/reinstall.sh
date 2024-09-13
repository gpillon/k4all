#!/bin/bash
set -euxo pipefail

source /usr/local/bin/k4all-utils

NET_DEV=$(get_network_device)
mv -f "/etc/NetworkManager/system-connections/${NET_DEV}.nmconnection.backup" "/etc/NetworkManager/system-connections/${NET_DEV}.nmconnection"

rm -rf /opt/k4all/*.done
systemctl reboot