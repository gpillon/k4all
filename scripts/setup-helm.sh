#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/helm-setup.done" ]; then
  echo "Helm setup already done. Exiting."
  exit 0
fi

HOME=/root/
helm_install_url="https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3"


source /usr/local/bin/k4all-utils

retry_command "curl -fsSL $helm_install_url | bash" 10 5
helm completion bash > /etc/bash_completion.d/helm

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/helm-setup.done

