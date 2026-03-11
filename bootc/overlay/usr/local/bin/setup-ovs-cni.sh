#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/ovs-cni-setup.done" ]; then
  echo "OVS-cni setup already done. Exiting."
  exit 0
fi

HOME=/root/
# URL="https://github.com/k8snetworkplumbingwg/ovs-cni/releases/download/v0.33.0/ovs"
# DESTINATION_DIR="/opt/cni/bin"

source /usr/local/bin/k4all-utils

MULTUS_VERSION=$(get_component_version multus-cni)
OVSCNI_VERSION=$(get_component_version ovs-cni)

MULTUS_SRC=$(get_component_source multus-cni)
OVSCNI_SRC=$(get_component_source ovs-cni)

if [ -n "$MULTUS_SRC" ] && [ "$MULTUS_SRC" != "null" ]; then
  MULTUS_URL=$(echo "$MULTUS_SRC" | sed "s/{{ version }}/${MULTUS_VERSION}/g")
else
  MULTUS_URL="https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml"
fi

if [ -n "$OVSCNI_SRC" ] && [ "$OVSCNI_SRC" != "null" ]; then
  OVSCNI_URL=$(echo "$OVSCNI_SRC" | sed "s/{{ version }}/${OVSCNI_VERSION}/g")
else
  OVSCNI_URL="https://raw.githubusercontent.com/k8snetworkplumbingwg/ovs-cni/master/examples/ovs-cni.yml"
fi

retry_command "kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f $MULTUS_URL" 10 30
retry_command "kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f $OVSCNI_URL" 10 30

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/ovs-cni-setup.done

