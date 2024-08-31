#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/setup-ph3.done" ]; then
  echo "Kubernetes setup phase 3 already done. Exiting."
  exit 0
fi

# nothing to do ATM on workers

touch /var/lib/setup-ph3.done