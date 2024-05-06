#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/custom-manifests-setup.done" ]; then
  echo "Custom manifests setup already done. Exiting."
  exit 0
fi

MANIFEST_DIR="/usr/local/share/mainifests"

# Cicla attraverso tutti i file con estensione .yaml o .yml
for manifest in "$MANIFEST_DIR"/*.{yaml,yml}; do
  # Verifica se il file esiste (per gestire il caso in cui non ci siano file corrispondenti)
  if [ -f "$manifest" ]; then
    echo "Applying $manifest..."
    kubectl --kubeconfig=/root/.kube/config apply -f "$manifest"
  fi
done

touch /var/lib/custom-manifests-setup.done