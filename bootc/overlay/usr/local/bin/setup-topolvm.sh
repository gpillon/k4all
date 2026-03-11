#!/bin/bash
set -euxo pipefail

k="kubectl --kubeconfig=/etc/kubernetes/admin.conf"
h="helm --kubeconfig=/etc/kubernetes/admin.conf"

KUBECONFIG=/root/.kube/config
HOME=/root/

source /usr/local/bin/k4all-utils

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/topolvm-setup.done" ]; then
  echo "TopoLVM setup already done. Exiting."
  exit 0
fi

TOPOLVM_VERSION=$(get_component_version topolvm)
TOPOLVM_REPO=$(get_component_repo topolvm)
TOPOLVM_CHART=$(get_component_chart topolvm)
TOPOLVM_NS=$(get_component_namespace topolvm)

# Deploy TopoLVM
$h repo add k4all-topolvm "${TOPOLVM_REPO}"
$h repo update

$k apply -f <(echo "apiVersion: v1
kind: Namespace
metadata:
  name: ${TOPOLVM_NS}")

$k label namespace "${TOPOLVM_NS}" topolvm.io/webhook=ignore
$k label namespace kube-system topolvm.io/webhook=ignore

TOPOLVM_HELM_ARGS=()
if [ -n "$TOPOLVM_VERSION" ] && [ "$TOPOLVM_VERSION" != "null" ]; then
  TOPOLVM_HELM_ARGS+=(--version "${TOPOLVM_VERSION}")
fi

$h upgrade --install --create-namespace --namespace="${TOPOLVM_NS}" topolvm "k4all-topolvm/${TOPOLVM_CHART}" \
  "${TOPOLVM_HELM_ARGS[@]}" --set cert-manager.enabled=false -f /usr/local/share/lvm-values.yaml

# Wait for TopoLVM deployment to complete
while true; do
  $k wait --namespace topolvm-system --for=condition=available --timeout=600s deployment/topolvm-controller
  #$k wait --namespace topolvm-system --for=condition=available --timeout=600s daemonset/topolvm-node #available is not the right condition
  if [ $? -eq 0 ]; then
    break
  fi
done

echo "TopoLVM installation complete, proceeding with the rest of the script."

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/topolvm-setup.done

