#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste

if [ -f "/var/lib/setup-taint-master-schedulable.done" ]; then
  echo "Master Already Untained. Exiting."
  exit 0
fi

kubectl --kubeconfig=/root/.kube/config taint nodes $(hostnamectl hostname) "node-role.kubernetes.io/control-plane:NoSchedule-"

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/setup-taint-master-schedulable.done