#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/setup-ph2.done" ]; then
  echo "Kubernetes setup phase 2 already done. Exiting."
  exit 0
fi


NET_DEV=$(ip route show default | awk '/default/ {print $5}')
#NM_NAME=$(nmcli con show | grep -w "${NET_DEV}" | awk '{print $1}')
MAC_ADDR=$(ip link show "${NET_DEV}" | awk '/ether/ {print $2}')

# Retrieve IP, Gateway, DNS, and Domain information from the original network device
IP_ADDR=$(nmcli -g IP4.ADDRESS dev show "${NET_DEV}")
GATEWAY=$(nmcli -g IP4.GATEWAY dev show "${NET_DEV}")
DNS=$(nmcli -t -f IP4.DNS dev show "${NET_DEV}" | awk -F":" '{print $2}' | paste -sd "," -)
SEARCH=$(nmcli -g IP4.DOMAIN dev show "${NET_DEV}")

# Enable and start kubelet service
systemctl enable --now crio
systemctl enable --now kubelet
systemctl enable --now openvswitch

nmcli con add type ovs-bridge conn.interface ovs-bridge con-name ovs-bridge
nmcli con add type ovs-port conn.interface port-ovs-bridge master ovs-bridge con-name ovs-bridge-port
nmcli con add type ovs-interface slave-type ovs-port conn.interface ovs-bridge master ovs-bridge-port con-name ovs-bridge-int

nmcli con add type ovs-port conn.interface ovs-port-eth master ovs-bridge con-name ovs-port-eth
nmcli con add type ethernet conn.interface "${NET_DEV}" master ovs-port-eth con-name ovs-port-eth-int

#nmcli con modify ovs-bridge-int ipv4.method auto ipv6.method disabled

nmcli con modify ovs-bridge 802-3-ethernet.cloned-mac-address "${MAC_ADDR}"
nmcli con modify ovs-bridge-int ipv4.method manual ipv4.address "${IP_ADDR}" ipv4.gateway "${GATEWAY}" ipv4.dns "${DNS}" ipv4.dns-search "${SEARCH}" ipv6.method ignore

#nmcli con modify ovs-bridge-int 802-3-ethernet.mtu 9000
#nmcli con modify ovs-port-eth-int 802-3-ethernet.mtu 9000

#nmcli con down "${NM_NAME}"
nmcli con up ovs-port-eth-int
nmcli con up ovs-bridge-int

rm -f /etc/NetworkManager/system-connections/${NET_DEV}.nmconnection

touch /var/lib/setup-ph2.done
systemctl reboot
while true; do sleep 1000; done