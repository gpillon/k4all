#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste

if [ -f "/opt/k4all/setup-ingress.done" ]; then
  echo "Ingress setup already done. Exiting."
  exit 0
fi

HOME=/root/

helm upgrade --kubeconfig=/etc/kubernetes/admin.conf --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace -f /usr/local/share/ingress-values.yaml

while true; do
  if kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f /usr/local/share/dashboard-ingress-routes.yaml; then
    break
  else
    echo "Failed to apply Ingress routes configuration. Retrying in 10 seconds..."
    sleep 10
  fi
done

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/setup-ingress.done