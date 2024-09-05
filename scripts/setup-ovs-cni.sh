#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/ovs-cni-setup.done" ]; then
  echo "OVS-cni setup already done. Exiting."
  exit 0
fi

HOME=/root/
# URL="https://github.com/k8snetworkplumbingwg/ovs-cni/releases/download/v0.33.0/ovs"
# DESTINATION_DIR="/opt/cni/bin"

source /usr/local/bin/k4all-utils

# mkdir -p /opt/cni/bin/
# retry_command "curl -L $URL -o $DESTINATION_DIR/ovs" 10 5
# chmod +x "$DESTINATION_DIR/ovs"

retry_command "kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml" 10 30
retry_command "kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/ovs-cni/master/examples/ovs-cni.yml" 10 30

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/ovs-cni-setup.done

