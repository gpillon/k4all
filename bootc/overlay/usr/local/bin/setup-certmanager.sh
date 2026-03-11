#!/bin/bash
set -euxo pipefail

k="kubectl --kubeconfig=/etc/kubernetes/admin.conf"
h="helm --kubeconfig=/etc/kubernetes/admin.conf"

KUBECONFIG=/root/.kube/config
HOME=/root/

source /usr/local/bin/k4all-utils

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/certmanager-setup.done" ]; then
  echo "CertManager setup already done. Exiting."
  exit 0
fi

CERTMGR_VERSION=$(get_component_version cert-manager)
CERTMGR_REPO=$(get_component_repo cert-manager)
CERTMGR_CHART=$(get_component_chart cert-manager)
CERTMGR_NS=$(get_component_namespace cert-manager)

# Deploy cert-manager
$h repo add k4all-certmgr "${CERTMGR_REPO}"
$h repo update
$h upgrade --install cert-manager "k4all-certmgr/${CERTMGR_CHART}" --version "${CERTMGR_VERSION}" \
   --namespace "${CERTMGR_NS}" --create-namespace \
   --set installCRDs=true \
   --wait --timeout=30m

echo "Waiting for Cert-Manager pods to be up and running..."

# Wait for cert-manager deployment to complete
$k wait --namespace cert-manager --for=condition=available --timeout=1800s deployment/cert-manager
$k wait --namespace cert-manager --for=condition=available --timeout=1800s deployment/cert-manager-webhook
$k wait --namespace cert-manager --for=condition=available --timeout=1800s deployment/cert-manager-cainjector

echo "Cert-manager installation complete, proceeding with the rest of the script."
touch /opt/k4all/certmanager-setup.done

