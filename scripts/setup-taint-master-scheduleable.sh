#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/setup-taint-master-schedulable.done" ]; then
  echo "Master Already Untainted. Exiting."
  exit 0
fi

# Aspetta che il nodo sia Ready
while true; do
    # Ottieni lo stato del nodo e verifica se è Ready
    NODE_STATUS=$(kubectl --kubeconfig=/root/.kube/config get nodes $(hostnamectl --static) -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
    if [ "$NODE_STATUS" == "True" ]; then
        echo "Node is Ready."
        break
    else
        echo "Waiting for node to become Ready..."
        sleep 10
    fi
done

# Esegui il taint sul nodo
kubectl --kubeconfig=/root/.kube/config taint nodes $(hostnamectl --static) "node-role.kubernetes.io/control-plane:NoSchedule-"

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/setup-taint-master-schedulable.done
