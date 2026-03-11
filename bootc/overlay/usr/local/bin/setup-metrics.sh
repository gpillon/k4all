#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-metrics.done" ]; then
  echo "Metrics setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

METRICS_VERSION=$(get_component_version metrics-server)
if [ -z "$METRICS_VERSION" ] || [ "$METRICS_VERSION" = "null" ] || [ "$METRICS_VERSION" = "latest" ]; then
  METRICS_URL="https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml"
else
  METRICS_URL="https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_VERSION}/components.yaml"
fi

kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f "$METRICS_URL"
kubectl --kubeconfig=/etc/kubernetes/admin.conf patch deployment metrics-server -n kube-system --type='json' -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/setup-metrics.done
