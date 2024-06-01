#!/bin/bash
set -euxo pipefail

if [ -f "/var/lib/metallb-setup.done" ]; then
  echo "MetalLB setup already done. Exiting."
  exit 0
fi

# https://metallb.universe.tf/installation/

METALLB_VERSION="v0.14.5"
HOME=/root/

kubectl --kubeconfig=/root/.kube/config get configmap kube-proxy -n kube-system -o yaml | \
sed -e "s/strictARP: false/strictARP: true/" | \
kubectl --kubeconfig=/root/.kube/config apply -f - -n kube-system

metal_lb_manifest_url="https://raw.githubusercontent.com/metallb/metallb/$METALLB_VERSION/config/manifests/metallb-native.yaml"

while true; do
  if kubectl --kubeconfig=/root/.kube/config apply -f $metal_lb_manifest_url; then
    break
  else
    echo "Failed to apply Metal LB Install configuration. Retrying in 10 seconds..."
    sleep 10
  fi
done

while true; do
  if kubectl --kubeconfig=/root/.kube/config apply -f /usr/local/share/metal-lb.yaml; then
    break
  else
    echo "Failed to apply Metal LB L2Advertisement. Retrying in 10 seconds..."
    sleep 10
  fi
done

touch /var/lib/metal-lb-setup.done