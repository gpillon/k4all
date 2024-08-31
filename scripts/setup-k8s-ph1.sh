#!/bin/bash
set -euxo pipefail

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

# Install Kubernetes packages using rpm-ostree
rpm-ostree install --idempotent kubeadm kubectl kubelet crio openvswitch NetworkManager-ovs yq keepalived

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