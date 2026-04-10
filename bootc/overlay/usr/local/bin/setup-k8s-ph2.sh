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

  # Check the CNI type from the configuration file and apply appropriate firewall rules
  CNI_TYPE=$(yq e '.spec.networking.cni.type' "$K4ALL_CONFIG_FILE")
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
