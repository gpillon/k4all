#!/bin/bash
set -euxo pipefail

source /usr/local/bin/k4all-utils

PACKAGES="kubeadm kubectl kubelet crio openvswitch NetworkManager-ovs yq" # Default packages to install

# Controlla se il file di stato esiste
if [ -f "/var/lib/k8s-setup-ph1.done" ]; then
  echo "Kubernetes setup already done. Exiting."
  exit 0
fi

# Check if the reboot marker exists. If it does, finalize setup and exit.
if [ -f "/var/lib/k8s-setup-ph1.reboot" ]; then
  echo "Finalizing setup after reboot."
  rm -f /var/lib/k8s-setup-ph1.reboot
  touch /var/lib/k8s-setup-ph1.done
  echo "Setup completed successfully."
  exit 0
fi

# Check if node.ha.type is "keepalived" in $CONFIG_JSON, then add keepalived to the package list
if jq -e '.node.ha.type == "keepalived"' "$K4ALL_CONFIG_FILE" >/dev/null; then
  echo "Adding keepalived to the installation list..."
  PACKAGES="$PACKAGES keepalived"
fi

# Check if networking.firewalld.enabled is true in $CONFIG_JSON, then add firewalld to the package list
if jq -e '.networking.firewalld.enabled == "true"' "$K4ALL_CONFIG_FILE" >/dev/null; then
  echo "Adding firewalld to the installation list..."
  PACKAGES="$PACKAGES firewalld"
fi

# Install all the necessary packages in a single rpm-ostree command
echo "Installing packages: $PACKAGES"
rpm-ostree install --idempotent $PACKAGES

# output=$(rpm-ostree status)

# # Check for pending deployments; look for '●' indicating non-active but ready deployments
# if grep -q '●' <<< "$output"; then
#   echo "Pending changes detected. Applying changes live..."
#   rpm-ostree apply-live
# else
#   echo "No pending changes."
# fi

touch /var/lib/k8s-setup-ph1.done
systemctl reboot
while true; do sleep 1000; done