#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste

if [ -f "/opt/k4all/setup-ingress.done" ]; then
  echo "Ingress setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/control-plane-utils

HOME=/root/
HA_INGRESS_PARAMS=""

# Check if the configuration is static and edit the Ignition file accordingly
if jq -e '.node.ha.type' "$K4ALL_CONFIG_FILE" | grep -q "kubevip"; then
  HA_INGRESS_PARAMS="--set \"controller.service.loadBalancerClass=kube-vip.io/kube-vip-class\" " 
fi

helm upgrade --kubeconfig=/etc/kubernetes/admin.conf --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace -f /usr/local/share/ingress-values.yaml --timeout 15m \
  --set controller.hostPort.enabled=false \
  --set controller.service.type=LoadBalancer \
  --set controller.service.externalIPs[0]=$(get_cluster_ip) \
  --set controller.service.loadBalancerIP=$(get_cluster_ip) \
  $HA_INGRESS_PARAMS

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