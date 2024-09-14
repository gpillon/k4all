#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste

if [ -f "/opt/k4all/default-service-account.done" ]; then
  echo "Default Service Accound Already checked. Exiting."
  exit 0
fi

# Check for the default service account
while true; do
  # Check if the default service account exists in the default namespace
  if kubectl --kubeconfig=/etc/kubernetes/admin.conf get serviceaccount default --namespace default &> /dev/null; then
    echo "Default service account is present in the default namespace."
    break
  fi

  # Wait before checking again
  echo "Waiting for the default service account to be created..."
  sleep 5
done

touch /opt/k4all/default-service-account.done