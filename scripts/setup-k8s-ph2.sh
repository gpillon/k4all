#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-ph2.done" ]; then
  echo "Kubernetes setup phase 2 already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

# Function to enable and start systemd services
enable_service_if_not_running() {
  local service_name=$1
  if ! systemctl is-enabled --quiet "$service_name"; then
    systemctl enable --now "$service_name"
  fi
}

# Function to check if an nmcli connection exists, and add it if it doesn't
add_nmcli_connection_if_not_exists() {
  local con_name=$1
  shift
  if ! nmcli con show "$con_name" >/dev/null 2>&1; then
    nmcli con add "$@"
  fi
}

# Function to modify nmcli connection settings only if different
modify_nmcli_connection_if_needed() {
  local con_name=$1
  local key=$2
  local new_value=$3
  local current_value
  if [ "$key" = "ipv4.addresses" ]; then
    nmcli con modify "$con_name" ipv4.method manual
  fi
  current_value=$(nmcli -g "$key" con show "$con_name")
  if [ "$current_value" != "$new_value" ]; then
    nmcli con modify "$con_name" "$key" "$new_value"
  fi
}

# Function to add a firewall rule if it doesn't already exist
add_firewalld_rule_if_not_exists() {
  local port_protocol=$1
  if ! firewall-cmd --query-port="$port_protocol" >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$port_protocol"
  fi
}

NET_DEV=$(get_network_device)
PHYS_NET_DEV=$(get_real_interface)

CURRENT_IP_CONFIG=$(jq -r '.networking.iface.ipconfig' "$K4ALL_CONFIG_FILE")
MAC_ADDR=$(ip link show "${PHYS_NET_DEV}" | awk '/ether/ {print $2}')

enable_service_if_not_running openvswitch

# Add ovs-bridge, ovs-bridge-port, ovs-bridge-int, ovs-port-eth, and ovs-port-eth-int if not exists
add_nmcli_connection_if_not_exists ovs-bridge type ovs-bridge conn.interface ovs-bridge con-name ovs-bridge
add_nmcli_connection_if_not_exists ovs-bridge-port type ovs-port conn.interface port-ovs-bridge master ovs-bridge con-name ovs-bridge-port
add_nmcli_connection_if_not_exists ovs-bridge-int type ovs-interface slave-type ovs-port conn.interface ovs-bridge master ovs-bridge-port con-name ovs-bridge-int
add_nmcli_connection_if_not_exists ovs-port-eth type ovs-port conn.interface ovs-port-eth master ovs-bridge con-name ovs-port-eth
add_nmcli_connection_if_not_exists ovs-port-eth-int type ethernet conn.interface "${PHYS_NET_DEV}" master ovs-port-eth con-name ovs-port-eth-int

if [ "$CURRENT_IP_CONFIG" = "static" ]; then
  # Extract values from JSON
  IP_ADDR=$(jq -r '.networking.iface.ipaddr' "$K4ALL_CONFIG_FILE")
  GATEWAY=$(jq -r '.networking.iface.gateway' "$K4ALL_CONFIG_FILE")
  DNS=$(jq -r '.networking.iface.dns' "$K4ALL_CONFIG_FILE")
  SUBNET_MASK=$(jq -r '.networking.iface.subnet_mask' "$K4ALL_CONFIG_FILE")
  DNS_SEARCH=$(jq -r '.networking.iface.dns_search' "$K4ALL_CONFIG_FILE" | sed 's/,/ /g')  # Converts commas to spaces if needed
  CIDR=$(mask_to_cidr $SUBNET_MASK)
  IP_CIDR="$IP_ADDR/$CIDR"

  echo "Using static IP configuration from JSON:"
  echo "IP Address: $IP_ADDR"
  echo "Gateway: $GATEWAY"
  echo "DNS: $DNS"
  echo "Subnet Mask: $SUBNET_MASK"
  echo "Search Domains: $DNS_SEARCH"
  echo "IP with CIDR: $IP_CIDR"

  modify_nmcli_connection_if_needed ovs-bridge-int ipv4.addresses "${IP_CIDR}"
  modify_nmcli_connection_if_needed ovs-bridge-int ipv4.gateway "${GATEWAY}"
  modify_nmcli_connection_if_needed ovs-bridge-int ipv4.dns "${DNS}"
  modify_nmcli_connection_if_needed ovs-bridge-int ipv4.dns-search "${DNS_SEARCH}"
  
else
  # echo "WARNING! this should not happen...."
  # Retrieve IP, Gateway, DNS, and Domain information from the original network device
  # IP_CIDR=$(nmcli -g IP4.ADDRESS dev show "${NET_DEV}" | head -n 1 | cut -d'|' -f1)
  # GATEWAY=$(nmcli -g IP4.GATEWAY dev show "${NET_DEV}")
  # DNS=$(nmcli -t -f IP4.DNS dev show "${NET_DEV}" | awk -F":" '{print $2}' | paste -sd "," -)
  # DNS_SEARCH=$(nmcli -g IP4.DOMAIN dev show "${NET_DEV}")

modify_nmcli_connection_if_needed ovs-bridge-int ipv4.method auto
fi

modify_nmcli_connection_if_needed ovs-bridge-int 802-3-ethernet.cloned-mac-address "${MAC_ADDR}"
# modify_nmcli_connection_if_needed ovs-port-eth-int ethernet.cloned-mac-address "${MAC_ADDR}"

# Bring up the ovs-port-eth-int and ovs-bridge-int connections
nmcli con up ovs-port-eth-int
nmcli con up ovs-bridge-int

# Enable and start kubelet, crio, and openvswitch services
enable_service_if_not_running crio
enable_service_if_not_running kubelet

# Check if networking.firewalld.enabled is true in $K4ALL_CONFIG_FILE
if jq -e '.networking.firewalld.enabled == "true"' "$K4ALL_CONFIG_FILE" >/dev/null; then
  enable_service_if_not_running firewalld
fi

# Remove the old NetworkManager connection if it exists
if [ -f "/etc/NetworkManager/system-connections/${NET_DEV}.nmconnection" ]; then
  mv -f "/etc/NetworkManager/system-connections/${NET_DEV}.nmconnection" "/etc/NetworkManager/system-connections/${NET_DEV}.nmconnection.disabled"
fi

# Check if firewalld is enabled
if systemctl is-enabled --quiet firewalld; then
  echo "Firewalld is enabled. Configuring it for Kubernetes..."

  # Add common firewall rules for Kubernetes

  # Allow Management Ports
  add_firewalld_rule_if_not_exists 22/tcp  # ssh

  # Allow Ingress Ports
  add_firewalld_rule_if_not_exists 80/tcp  # ssh
  add_firewalld_rule_if_not_exists 443/tcp  # ssh

  # Allow DNS Ports
  add_firewalld_rule_if_not_exists 53/udp    # DNS (UDP)
  add_firewalld_rule_if_not_exists 53/tcp    # DNS (TCP)

  # Allow necessary Kubernetes ports
  add_firewalld_rule_if_not_exists 6443/tcp   # Kubernetes API server
  add_firewalld_rule_if_not_exists 2379-2380/tcp # etcd server client API
  add_firewalld_rule_if_not_exists 10250/tcp  # Kubelet API
  add_firewalld_rule_if_not_exists 10251/tcp  # kube-scheduler
  add_firewalld_rule_if_not_exists 10252/tcp  # kube-controller-manager
  add_firewalld_rule_if_not_exists 10255/tcp  # Read-only Kubelet API (deprecated)
  add_firewalld_rule_if_not_exists 30000-32767/tcp  # NodePort Services

  # Check the CNI type from the configuration file and apply appropriate firewall rules
  CNI_TYPE=$(jq -r '.networking.cni' "$K4ALL_CONFIG_FILE")
  case "$CNI_TYPE" in
    "calico")
      echo "Configuring firewalld for Calico..."
      add_firewalld_rule_if_not_exists 179/tcp  # BGP for Calico
      add_firewalld_rule_if_not_exists 4789/udp # VXLAN for Calico
      add_firewalld_rule_if_not_exists 5473/tcp # Typha for Calico
      add_firewalld_rule_if_not_exists 51820/udp # IPv4 Wireguard
      add_firewalld_rule_if_not_exists 51821/udp # IPv6 Wireguard
      ;;
    "cilium")
      echo "Configuring firewalld for Cilium..."
      add_firewalld_rule_if_not_exists 4240/tcp  # Cilium health checks
      add_firewalld_rule_if_not_exists 4244/tcp  # Hubble server
      add_firewalld_rule_if_not_exists 4245/tcp  # Hubble Relay
      add_firewalld_rule_if_not_exists 4250/tcp  # Mutual Authentication port
      add_firewalld_rule_if_not_exists 4251/tcp  # Spire Agent health check port
      add_firewalld_rule_if_not_exists 6060/tcp  # cilium-agent pprof server
      add_firewalld_rule_if_not_exists 6061/tcp  # cilium-operator pprof server
      add_firewalld_rule_if_not_exists 6062/tcp  # Hubble Relay pprof server
      add_firewalld_rule_if_not_exists 9878/tcp  # cilium-envoy health listener
      add_firewalld_rule_if_not_exists 9879/tcp  # cilium-agent health status API
      add_firewalld_rule_if_not_exists 9890/tcp  # cilium-agent gops server
      add_firewalld_rule_if_not_exists 9891/tcp  # operator gops server
      add_firewalld_rule_if_not_exists 9893/tcp  # Hubble Relay gops server
      add_firewalld_rule_if_not_exists 9901/tcp  # cilium-envoy Admin API
      add_firewalld_rule_if_not_exists 9962/tcp  # cilium-agent Prometheus metrics
      add_firewalld_rule_if_not_exists 9963/tcp  # cilium-operator Prometheus metrics
      add_firewalld_rule_if_not_exists 9964/tcp  # cilium-envoy Prometheus metrics
      add_firewalld_rule_if_not_exists 51871/udp # WireGuard encryption tunnel endpoint
      ;;
    "flannel")
      echo "Configuring firewalld for Flannel..."
      add_firewalld_rule_if_not_exists 8472/udp # VXLAN for Flannel
      ;;
    *)
      echo "No specific CNI firewall rules needed for $CNI_TYPE."
      ;;
  esac

  firewall-cmd --reload
fi

systemctl restart NetworkManager

# Mark the setup phase as done
touch /opt/k4all/setup-ph2.done

# Reboot the system
systemctl reboot
