#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/k8s-setup-init.done" ]; then
  echo "Kubernetes init already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

K4ALL_CONFIG="/etc/k4all-config.json"
K8S_CONFIG="/etc/k8s-config.yaml"

# --- Cluster restore path ---
# If a backup was restored, the etcd data and PKI are already in place.
# We skip kubeadm init and just start the control plane from existing state.
if [ -f "/opt/k4all/restore-bootstrap-cluster.flag" ]; then
  echo "Restore flag detected — skipping kubeadm init (cluster restored from backup)"

  # Ensure kubelet can start with restored config
  if [ ! -f /var/lib/kubelet/config.yaml ]; then
    echo "Generating kubelet config from kubeadm..."
    kubeadm init phase kubelet-start --config "$K8S_CONFIG" 2>/dev/null || true
  fi

  setup_kubeconfig_for_user "root" "/root"
  setup_kubeconfig_for_user "core" "/home/core"

  kubectl completion bash > /etc/bash_completion.d/kubectl_bash_completion

  # Wait for the API server to come back up (etcd + static pods should start automatically)
  echo "Waiting for API server to become available after restore..."
  for i in $(seq 1 120); do
    if kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes &>/dev/null; then
      echo "API server is available."
      break
    fi
    echo "  Attempt $i/120: API server not ready yet..."
    sleep 5
  done

  rm -f /opt/k4all/restore-bootstrap-cluster.flag
  touch /opt/k4all/k8s-setup-init.done
  echo "Cluster restore init completed."
  exit 0
fi

# --- Normal init path ---
if [ -f "$K4ALL_CONFIG_FILE" ]; then
  POD_NET=$(yq e '.spec.cluster.podNetwork // "10.100.0.1/18"' "$K4ALL_CONFIG_FILE")
  SVC_NET=$(yq e '.spec.cluster.serviceNetwork // "10.96.0.0/16"' "$K4ALL_CONFIG_FILE")
  CNI=$(yq e '.spec.networking.cni.type // "calico"' "$K4ALL_CONFIG_FILE")

  # if [ "$CNI" == "cilium" ]; then
  #   yq e '(select(.kind == "ClusterConfiguration") | .proxy.disabled) = true' -i "$K8S_CONFIG"
  # fi

  echo "Setting pod network to $POD_NET and service network to $SVC_NET"
  yq e '(select(.kind == "ClusterConfiguration") | .networking.podSubnet) = "'"$POD_NET"'"' -i "$K8S_CONFIG"
  yq e '(select(.kind == "ClusterConfiguration") | .networking.serviceSubnet) = "'"$SVC_NET"'"' -i "$K8S_CONFIG"
fi

kubeadm init --config /etc/k8s-config.yaml

setup_kubeconfig_for_user "root" "/root"
setup_kubeconfig_for_user "core" "/home/core"

kubectl completion bash > /etc/bash_completion.d/kubectl_bash_completion

touch /opt/k4all/k8s-setup-init.done
