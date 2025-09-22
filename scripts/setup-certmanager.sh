#!/bin/bash
set -euxo pipefail

k="kubectl --kubeconfig=/etc/kubernetes/admin.conf"
h="helm --kubeconfig=/etc/kubernetes/admin.conf"

KUBECONFIG=/root/.kube/config
HOME=/root/

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/certmanager-setup.done" ]; then
  echo "CertManager setup already done. Exiting."
  exit 0
fi

# Deploy cert-manager
$h repo add jetstack https://charts.jetstack.io
$h repo update
$h upgrade --install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --version v1.14.5 --set installCRDs=true

echo "Waiting for Cert-Manager pods to be up and running..."

# Wait for cert-manager deployment to complete
$k wait --namespace cert-manager --for=condition=available --timeout=600s deployment/cert-manager
$k wait --namespace cert-manager --for=condition=available --timeout=600s deployment/cert-manager-webhook
$k wait --namespace cert-manager --for=condition=available --timeout=600s deployment/cert-manager-cainjector

echo "Cert-manager installation complete, proceeding with the rest of the script."
touch /opt/k4all/certmanager-setup.done

