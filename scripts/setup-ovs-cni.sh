#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/ovs-cni-setup.done" ]; then
  echo "OVS-cni setup already done. Exiting."
  exit 0
fi

HOME=/root/
# URL="https://github.com/k8snetworkplumbingwg/ovs-cni/releases/download/v0.33.0/ovs"
# DESTINATION_DIR="/opt/cni/bin"

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

# mkdir -p /opt/cni/bin/
# retry_command "curl -L $URL -o $DESTINATION_DIR/ovs" 10 5
# chmod +x "$DESTINATION_DIR/ovs"

retry_command "kubectl --kubeconfig=/root/.kube/config apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml" 10 20
retry_command "kubectl --kubeconfig=/root/.kube/config apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/ovs-cni/master/examples/ovs-cni.yml" 10 20

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/ovs-cni-setup.done

