#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/k8s-setup-init.done" ]; then
  echo "Kubernetes init already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

K4ALL_CONFIG="/etc/k4all-config.json"
K8S_CONFIG="/etc/k8s-config.yaml"

if [ -f "$K4ALL_CONFIG" ]; then
  POD_NET=$(jq -r '.cluster.podNetwork // "10.100.0.1/18"' "$K4ALL_CONFIG")
  SVC_NET=$(jq -r '.cluster.serviceNetwork // "10.96.0.0/16"' "$K4ALL_CONFIG")
  CNI=$(jq -r '.networking.cni.type // "calico"' "$K4ALL_CONFIG")

  if [ "$CNI" == "cilium" ]; then
    yq e '(select(.kind == "ClusterConfiguration") | .proxy.disabled) = true' -i "$K8S_CONFIG"
  fi

  echo "Setting pod network to $POD_NET and service network to $SVC_NET"
  yq e '(select(.kind == "ClusterConfiguration") | .networking.podSubnet) = "'"$POD_NET"'"' -i "$K8S_CONFIG"
  yq e '(select(.kind == "ClusterConfiguration") | .networking.serviceSubnet) = "'"$SVC_NET"'"' -i "$K8S_CONFIG"
fi

# Initialize Kubernetes cluster
kubeadm init --config /etc/k8s-config.yaml


# if [ -f "/etc/kubernetes/manifests/kube-vip.yaml" ]; then
#   # Setting to /etc/kubernetes/super-admin.conf, else the leader election will not work.
#   yq e '.spec.volumes[] |= select(.name == "kubeconfig") | .spec.volumes[0].hostPath.path = "/etc/kubernetes/super-admin.conf"' -i /etc/kubernetes/manifests/kube-vip.yaml
# fi

setup_kubeconfig_for_user "root" "/root"
setup_kubeconfig_for_user "core" "/home/core"

# finalize_k8s_setup_for_user "root" "/root"
# finalize_k8s_setup_for_user "core" "/home/core"

kubectl completion bash > /etc/bash_completion.d/kubectl_bash_completion

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/k8s-setup-init.done

