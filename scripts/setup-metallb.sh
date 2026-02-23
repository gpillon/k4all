#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/metallb-setup.done" ]; then
  echo "MetalLB setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

# Skip MetalLB when Cilium is the CNI (Cilium provides its own L2 announcements)
if [ -f "$K4ALL_CONFIG_FILE" ]; then
  cni_type=$(jq -r '.networking.cni.type // "calico"' "$K4ALL_CONFIG_FILE")
  if [ "$cni_type" = "cilium" ]; then
    echo "Cilium CNI detected, skipping MetalLB installation."
    touch /opt/k4all/metallb-setup.done
    exit 0
  fi
fi

# https://metallb.universe.tf/installation/

METALLB_VERSION="v0.15.3"
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

touch /opt/k4all/metallb-setup.done