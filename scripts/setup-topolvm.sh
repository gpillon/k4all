#!/bin/bash
set -euxo pipefail

k="kubectl --kubeconfig=/etc/kubernetes/admin.conf"
h="helm --kubeconfig=/etc/kubernetes/admin.conf"

KUBECONFIG=/root/.kube/config
HOME=/root/

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/topolvm-setup.done" ]; then
  echo "TopoLVM setup already done. Exiting."
  exit 0
fi
# Deploy TopoLVM
$h repo add topolvm https://topolvm.github.io/topolvm
$h repo update

$k apply -f <(echo 'apiVersion: v1
kind: Namespace
metadata:
  name: topolvm-system')

$k label namespace topolvm-system topolvm.io/webhook=ignore
$k label namespace kube-system topolvm.io/webhook=ignore

$h upgrade --install --create-namespace --namespace=topolvm-system topolvm topolvm/topolvm --set cert-manager.enabled=false -f /usr/local/share/lvm-values.yaml

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

