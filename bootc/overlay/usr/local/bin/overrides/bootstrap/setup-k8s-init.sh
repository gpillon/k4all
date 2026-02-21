#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/k8s-setup-init.done" ]; then
  echo "Kubernetes init already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

# Initialize Kubernetes cluster
kubeadm init --config /etc/k8s-config.yaml


if [ -f "/etc/kubernetes/manifests/kube-vip.yaml" ]; then
  # Setting to /etc/kubernetes/admin.conf, the super-admin.conf maybe too much....
  yq e '.spec.volumes[] |= select(.name == "kubeconfig") | .spec.volumes[0].hostPath.path = "/etc/kubernetes/admin.conf"' -i /etc/kubernetes/manifests/kube-vip.yaml
fi

setup_kubeconfig_for_user "root" "/root"
setup_kubeconfig_for_user "core" "/home/core"

# finalize_k8s_setup_for_user "root" "/root"
# finalize_k8s_setup_for_user "core" "/home/core"

kubectl completion bash > /etc/bash_completion.d/kubectl_bash_completion

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/k8s-setup-init.done

