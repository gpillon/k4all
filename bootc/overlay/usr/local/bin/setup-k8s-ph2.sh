#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-ph2.done" ]; then
  echo "Kubernetes setup phase 2 already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

# OVS bridge creation is now handled by the k4all operator via nmstate NNCP
# when the ovsBridge feature flag is enabled.

enable_service_if_not_running() {
  local service_name=$1
  if ! systemctl is-enabled --quiet "$service_name"; then
    systemctl enable --now "$service_name"
  fi
}

add_firewalld_rule_if_not_exists() {
  local port_protocol=$1
  if ! firewall-cmd --query-port="$port_protocol" >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$port_protocol"
  fi
}

enable_service_if_not_running crio
enable_service_if_not_running kubelet

if [ "$(yq e '.spec.networking.firewalld.enabled' "$K4ALL_CONFIG_FILE")" = "true" ]; then
  enable_service_if_not_running firewalld
else
  echo "Firewalld is disabled. Disabling it..."
  systemctl stop firewalld && systemctl disable firewalld
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

  # The CNI's ports. A bootstrap node chose the cluster's CNI: its
  # configuration says which. A worker or a control plane cannot know it
  # when it is installed: its configuration has no CNI, or the guess of an
  # older installer (calico, issue #63). On every node k4all-cni-firewalld
  # opens the ports of the CNI that runs there, once the CNI's pod writes
  # its configuration in /etc/cni/net.d.
  if [ "$(tr -d '[:space:]' < /etc/node-type)" = "bootstrap" ]; then
    CNI_TYPE=$(yq e '.spec.networking.cni.type' "$K4ALL_CONFIG_FILE")
    echo "Configuring firewalld for $CNI_TYPE..."
    for port in $(cni_firewalld_ports "$CNI_TYPE"); do
      add_firewalld_rule_if_not_exists "$port"
    done
  fi

  firewall-cmd --reload
fi

# A restored node may already have its own version (with more bridges): keep it.
if [ ! -e /etc/NetworkManager/dispatcher.d/90-ovs-arp.sh ]; then
cat <<'EOF' > /etc/NetworkManager/dispatcher.d/90-ovs-arp.sh
#!/bin/bash
case "$1" in
  ovs-bridge)
    if [ "$2" = "up" ]; then
      sysctl -w net.ipv4.conf.$1.arp_ignore=1
      sysctl -w net.ipv4.conf.$1.arp_announce=2
    fi
    ;;
esac
EOF
chmod +x /etc/NetworkManager/dispatcher.d/90-ovs-arp.sh
fi

systemctl restart NetworkManager

# Mark the setup phase as done
touch /opt/k4all/setup-ph2.done

# Reboot the system
systemctl reboot
