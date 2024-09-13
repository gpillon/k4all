#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/calico-setup.done" ]; then
  echo "Calico setup already done. Exiting."
  exit 0
fi

CALICO_VERSION="v3.27.3"
HOME=/root/

source /usr/local/bin/k4all-utils

#calico_manifest_url="https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/custom-resources.yaml"

# Deploy a network add-on
kubectl --kubeconfig=/etc/kubernetes/admin.conf create -f https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/tigera-operator.yaml
#retry_command "curl -O $calico_manifest_url" 10 5
#kubectl --kubeconfig=/etc/kubernetes/admin.conf create -f custom-resources.yaml
#kubectl --kubeconfig=/etc/kubernetes/admin.conf create -f custom-resources.yaml

while true; do
  if kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f /usr/local/share/calico-resources.yaml; then
    break
  else
    echo "Failed to apply Calico configuration. Retrying in 10 seconds..."
    sleep 10
  fi
done

touch /opt/k4all/calico-setup.done