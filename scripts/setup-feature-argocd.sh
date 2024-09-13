#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/feature-argocd-setup.done" ]; then
  echo "ArgoCD setup already done. Exiting."
  exit 0
fi

export KUBECONFIG=/root/.kube/config
export HOME=/root/

source /usr/local/bin/k4all-utils

namespace="argocd"


helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm upgrade --install argocd argo/argo-cd --create-namespace -n $namespace -f /usr/local/share/argocd-values.yaml --set "global.domain=\"argo.$(get_ip).nip.io\"" --set-json "server.ingress.extraHosts=[{\"name\": \"argo.$(get_fqdn)\", \"path\": \"\/\"}]" 

# kubectl get namespace argocd || kubectl create namespace argocd
# kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n $namespace wait deployment/argocd-server --for condition=Available --timeout=3600s

ARGO_ADMIN_SECRET=$(kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath="{.data.password}" | base64 --decode)

# route_host_prefix="argocd"
ingress_name="argocd-server"


# kubectl apply -f /usr/local/share/argocd-ingress-routes.yaml
# patch_ingress "$(get_ip).nip.io" 0 $route_host_prefix $ingress_name $namespace
# patch_ingress "$(get_fqdn)" 1 $route_host_prefix $ingress_name $namespace

urls=$(get_ingress_urls "$ingress_name" $namespace)

if [[ -z "$urls" ]]; then
  echo "No URLs found or error occurred." >&2
  exit 1
else
  IFS=$'\n' # Imposta il separatore interno del campo su nuova linea
  urls_array=($urls) # Crea un array con gli URL
  joined_urls=$(IFS=", "; echo "${urls_array[*]}") # Unisce gli URL con virgole
fi

echo -e "You can now login to argo using credentials admin:${ARGO_ADMIN_SECRET} using one of those: $joined_urls"


# Done
touch /opt/k4all/feature-argocd-setup.done