#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-metrics.done" ]; then
  echo "Metrics setup already done. Exiting."
  exit 0
fi

kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl --kubeconfig=/etc/kubernetes/admin.conf patch deployment metrics-server -n kube-system --type='json' -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/setup-metrics.done
