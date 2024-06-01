#!/bin/bash
set -euxo pipefail

if [ -f "/var/lib/calico-setup.done" ]; then
  echo "Calico setup already done. Exiting."
  exit 0
fi

CALICO_VERSION="v3.27.3"
HOME=/root/

#calico_manifest_url="https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/custom-resources.yaml"

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

# Deploy a network add-on
kubectl --kubeconfig=/root/.kube/config create -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.3/manifests/tigera-operator.yaml
#retry_command "curl -O $calico_manifest_url" 10 5
#kubectl --kubeconfig=/root/.kube/config create -f custom-resources.yaml
#kubectl --kubeconfig=/root/.kube/config create -f custom-resources.yaml

while true; do
  if kubectl --kubeconfig=/root/.kube/config apply -f /usr/local/share/calico-resources.yaml; then
    break
  else
    echo "Failed to apply Calico configuration. Retrying in 10 seconds..."
    sleep 10
  fi
done

touch /var/lib/calico-setup.done