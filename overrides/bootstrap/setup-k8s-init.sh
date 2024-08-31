#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/k8s-setup-init.done" ]; then
  echo "Kubernetes init already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

kubeadm reset --force

# Initialize Kubernetes cluster
kubeadm init --config /etc/k8s-config.yaml

setup_kubeconfig_for_user "root" "/root"
setup_kubeconfig_for_user "core" "/home/core"
finalize_k8s_setup_for_user "root" "/root"
finalize_k8s_setup_for_user "core" "/home/core" 

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/k8s-setup-init.done

