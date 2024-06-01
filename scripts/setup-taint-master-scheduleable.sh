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
    while true; do
        NODE_STATUS=$(kubectl --kubeconfig=/root/.kube/config get nodes $(hostnamectl --static) -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
        if [ $? -eq 0 ]; then
             echo "Node is Ready"
            break
        else
            echo "Failed to retrieve node status, retrying..."
            sleep 5
        fi
    done

    if [ "$NODE_STATUS" == "True" ]; then
        echo "Node is Ready."
        break
    else
        echo "Waiting for node to become Ready..."
        sleep 10
    fi
done

# Esegui il taint sul nodo

NODE_TAINTED=$(kubectl --kubeconfig=/root/.kube/config get nodes $(hostnamectl --static) -o jsonpath='{.spec.taints[?(@.key=="node-role.kubernetes.io/control-plane")].effect}')

if [ "$NODE_TAINTED" == "NoSchedule" ]; then
    echo "Node is tainted, removing taint..."

     while true; do
        NODE_STATUS=$(kubectl --kubeconfig=/root/.kube/config taint nodes $(hostnamectl --static) node-role.kubernetes.io/control-plane:NoSchedule- 2>/dev/null)
        if [ $? -eq 0 ]; then
            echo "Tainted node"
            break
        else
            echo "Failed to taint node , retrying..."
            sleep 5
        fi
    done

    
else
    echo "No relevant taint found, no action needed."
fi

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/setup-taint-master-schedulable.done
