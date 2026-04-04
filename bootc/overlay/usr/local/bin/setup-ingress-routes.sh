#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/setup-ingress-routes.done" ]; then
  echo "Ingress routes setup already done. Exiting."
  exit 0
fi

source /var/opt/k4all/bin/control-plane-utils

HOME=/root/

while true; do
  if kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f /usr/local/share/headlamp-ingress-routes.yaml; then
    break
  else
    echo "Failed to apply Ingress routes configuration. Retrying in 10 seconds..."
    sleep 10
  fi
done

touch /opt/k4all/setup-ingress-routes.done
