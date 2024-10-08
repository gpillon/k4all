#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-taint-master-schedulable.done" ]; then
  echo "Master Already Untainted. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

#Wait for k8s nodes endpoint
retry_command "kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes" 30 10

wait_node() {
    # Aspetta che il nodo sia Ready
    while true; do
        # Ottieni lo stato del nodo e verifica se è Ready
        while true; do
            NODE_STATUS=$(kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes $(hostnamectl --static) -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
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
}

retry_command wait_node 30 10

# Esegui il taint sul nodo

NODE_TAINTED=$(kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes $(hostnamectl --static) -o jsonpath='{.spec.taints[?(@.key=="node-role.kubernetes.io/control-plane")].effect}')

if [ "$NODE_TAINTED" == "NoSchedule" ]; then
    echo "Node is tainted, removing taint..."

     while true; do
        NODE_STATUS=$(kubectl --kubeconfig=/etc/kubernetes/admin.conf taint nodes $(hostnamectl --static) node-role.kubernetes.io/control-plane:NoSchedule- 2>/dev/null)
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
touch /opt/k4all/setup-taint-master-schedulable.done
