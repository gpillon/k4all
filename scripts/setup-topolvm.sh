#!/bin/bash
set -euxo pipefail

k="kubectl --kubeconfig=/root/.kube/config"
h="helm --kubeconfig=/root/.kube/config"

KUBECONFIG=/root/.kube/config
HOME=/root/

# Controlla se il file di stato esiste
if [ -f "/var/lib/topolvm-setup.done" ]; then
  echo "TopoLVM setup already done. Exiting."
  exit 0
fi

function check_pods_running {
# Get the number of pods in "Running" state
running_pods=$($k get pods -n cert-manager --field-selector=status.phase=Running -o name | wc -l)

# Get the total number of pods for Cert-Manager
total_pods=$($k get pods -n cert-manager -o name | wc -l)

# Compare and return 0 if all pods are running
if [ "$running_pods" -eq "$total_pods" ] && [ "$total_pods" -gt 0 ]; then
  return 0
else
  return 1
fi
}


# Deploy cert-manager
$h repo add jetstack https://charts.jetstack.io
$h repo update
$h install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --version v1.14.5 --set installCRDs=true

echo "Waiting for Cert-Manager pods to be up and running..."

# Loop until all pods are running
until check_pods_running; do
echo "Not all Cert-Manager pods are running yet. Retrying in 7 seconds..."
sleep 7
done

echo "All Cert-Manager pods are running!"

# Deploy TopoLVM
$h repo add topolvm https://topolvm.github.io/topolvm
$h repo update
$k create ns topolvm-system

$k label namespace topolvm-system topolvm.io/webhook=ignore
$k label namespace kube-system topolvm.io/webhook=ignore

$h install --namespace=topolvm-system topolvm topolvm/topolvm --set cert-manager.enabled=false -f /usr/local/share/lvm-values.yaml


# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/topolvm-setup.done

