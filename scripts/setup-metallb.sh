#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/metallb-setup.done" ]; then
  echo "MetalLB setup already done. Exiting."
  exit 0
fi

# https://metallb.universe.tf/installation/

METALLB_VERSION="v0.14.5"
HOME=/root/

kubectl --kubeconfig=/etc/kubernetes/admin.conf get configmap kube-proxy -n kube-system -o yaml | \
sed -e "s/strictARP: false/strictARP: true/" | \
kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f - -n kube-system

metal_lb_manifest_url="https://raw.githubusercontent.com/metallb/metallb/$METALLB_VERSION/config/manifests/metallb-native.yaml"

while true; do
  if kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f $metal_lb_manifest_url; then
    break
  else
    echo "Failed to apply Metal LB Install configuration. Retrying in 10 seconds..."
    sleep 10
  fi
done

while true; do
  if kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f /usr/local/share/metal-lb.yaml; then
    break
  else
    echo "Failed to apply Metal LB L2Advertisement. Retrying in 10 seconds..."
    sleep 10
  fi
done

# https://metallb.universe.tf/troubleshooting/#metallb-is-not-advertising-my-service-from-my-control-plane-nodes-or-from-my-single-node-cluster
kubectl --kubeconfig=/etc/kubernetes/admin.conf patch daemonset speaker -n metallb-system --type=json -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--ignore-exclude-lb"}]'

touch /opt/k4all/metal-lb-setup.done