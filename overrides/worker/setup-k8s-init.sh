#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/k8s-setup-init.done" ]; then
  echo "Kubernetes init already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

finalize_k8s_setup_for_user "root" "/root"
finalize_k8s_setup_for_user "core" "/home/core"

touch /var/lib/k8s-setup-init.done

