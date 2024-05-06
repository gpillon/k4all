#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/helm-setup.done" ]; then
  echo "Helm setup already done. Exiting."
  exit 0
fi

helm_install_url="https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3"


retry_command() {
  local command="$1"
  local max_retries="$2"
  local delay="$3"
  local retry_count=0
  local success=false

  while [ "$retry_count" -lt "$max_retries" ]; do
    echo "Attempt $(($retry_count + 1))..."

    # Execute the command
    if eval "$command"; then
      echo "Command executed successfully."
      success=true
      break
    else
      echo "Command failed. Retrying in $delay seconds..."
      retry_count=$(($retry_count + 1))
      sleep "$delay"
    fi
  done

  # Check if we succeeded after all retries
  if [ "$success" = false ]; then
    echo "Command failed after $max_retries retries."
    return 1
  fi
}

retry_command "curl -fsSL $helm_install_url | bash" 10 5
helm completion bash > /etc/bash_completion.d/helm

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/helm-setup.done

