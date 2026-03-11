#!/bin/bash
set -euo pipefail

if [ -f "/opt/k4all/feature-argocd-setup.done" ]; then
  echo "ArgoCD setup already done. Exiting."
  exit 0
fi

export KUBECONFIG=/root/.kube/config
export HOME=/root/

source /usr/local/bin/k4all-utils

ARGOCD_REPO=$(get_component_repo argocd)
ARGOCD_CHART=$(get_component_chart argocd)
ARGOCD_VERSION=$(get_component_version argocd)
namespace=$(get_component_namespace argocd)

ARGOCD_HELM_ARGS=""
if [ -n "$ARGOCD_VERSION" ] && [ "$ARGOCD_VERSION" != "null" ]; then
  ARGOCD_HELM_ARGS="--version ${ARGOCD_VERSION}"
fi

helm repo add k4all-argo "${ARGOCD_REPO}"
helm repo update

ARGO_JSON="server.ingress.extraHosts=[{\"name\": \"argo.$(get_fqdn)\", \"path\": \"/\"}]"

retry_command "helm upgrade --install argocd k4all-argo/${ARGOCD_CHART} ${ARGOCD_HELM_ARGS} --create-namespace -n $namespace -f /usr/local/share/argocd-values.yaml --set \"global.domain=argo.$(get_ip).nip.io\" --set-json '$ARGO_JSON'" 30 10

# Wait for ArgoCD server to be available
kubectl -n $namespace wait deployment/argocd-server --for condition=Available --timeout=3600s

ARGO_ADMIN_SECRET=$(kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath="{.data.password}" | base64 --decode)

ingress_name="argocd-server"

# Fetch ingress URLs
urls=$(get_ingress_urls "$ingress_name" $namespace)

if [[ -z "$urls" ]]; then
  echo "No URLs found or error occurred." >&2
  exit 1
else
  IFS=$'\n' # Set field separator to newline
  urls_array=($urls) # Create an array with the URLs
  joined_urls=$(IFS=", "; echo "${urls_array[*]}") # Join URLs with commas
fi

echo -e "You can now login to Argo using credentials admin:${ARGO_ADMIN_SECRET} using one of those: $joined_urls"

# Mark setup as done
touch /opt/k4all/feature-argocd-setup.done
