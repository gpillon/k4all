#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/metal-lb-setup.done" ]; then
  echo "MetalLB setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

CNI_TYPE=$(jq -r '.networking.cni.type // "calico"' "$K4ALL_CONFIG_FILE")
CILIUM_L2=$(jq -r '.cni.cilium.l2announcements // "false"' "$K4ALL_CONFIG_FILE")

# MetalLB is NOT needed when Cilium handles L2 announcements
if [ "$CNI_TYPE" = "cilium" ] && [ "$CILIUM_L2" = "true" ]; then
  echo "Cilium L2 Announcements are enabled — skipping MetalLB installation."
  touch /opt/k4all/metal-lb-setup.done
  exit 0
fi

# Collect dedicated IPs that need L2 announcement
DEDICATED_IPS=()
NGINX_IP=$(jq -r '.ingress.nginx.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
CILIUM_IP=$(jq -r '.ingress.cilium.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
[ -n "$NGINX_IP" ] && DEDICATED_IPS+=("$NGINX_IP")
[ -n "$CILIUM_IP" ] && DEDICATED_IPS+=("$CILIUM_IP")

if [ ${#DEDICATED_IPS[@]} -eq 0 ]; then
  echo "No dedicated IPs configured — skipping MetalLB installation."
  touch /opt/k4all/metal-lb-setup.done
  exit 0
fi

echo "Installing MetalLB for L2 announcement of dedicated IPs: ${DEDICATED_IPS[*]}"

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
    echo "Failed to apply MetalLB manifest. Retrying in 10 seconds..."
    sleep 10
  fi
done

# Wait for MetalLB controller to be ready
echo "Waiting for MetalLB controller..."
kubectl --kubeconfig=/etc/kubernetes/admin.conf -n metallb-system wait --for=condition=ready pod -l app=metallb,component=controller --timeout=300s || true

# Build address list for IPAddressPool (each IP as <ip>/32)
ADDRESSES_YAML=""
for ip in "${DEDICATED_IPS[@]}"; do
  ADDRESSES_YAML+="    - ${ip}/32
"
done

# Create IPAddressPool and L2Advertisement
while ! cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: k4all-ingress-pool
  namespace: metallb-system
spec:
  addresses:
${ADDRESSES_YAML}
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: k4all-l2adv
  namespace: metallb-system
spec:
  ipAddressPools:
    - k4all-ingress-pool
EOF
do
  echo "Retrying MetalLB pool/advertisement in 10s..."
  sleep 10
done

if ! kubectl --kubeconfig=/etc/kubernetes/admin.conf -n metallb-system get daemonset speaker -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q -- '--ignore-exclude-lb'; then
  kubectl --kubeconfig=/etc/kubernetes/admin.conf patch daemonset speaker -n metallb-system --type=json \
    -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--ignore-exclude-lb"}]'
fi
touch /opt/k4all/metal-lb-setup.done
