#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/cilium-setup.done" ]; then
  echo "Cilium setup already done. Exiting."
  exit 0
fi

CILIUM_VERSION="1.19.1"
KUBECONFIG=/root/.kube/config
export HOME=/root/

source /opt/k4all/bin/control-plane-utils

POD_NET=$(jq -r '.cluster.podNetwork // "10.100.0.1/18"' "$K4ALL_CONFIG_FILE")
NGINX_DEDICATED_IP=$(jq -r '.ingress.nginx.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
CILIUM_DEDICATED_IP=$(jq -r '.ingress.cilium.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
HA_TYPE=$(jq -r '.cluster.ha.type // "none"' "$K4ALL_CONFIG_FILE")

# Install cilium CLI
retry_command "CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)" 10 30
set_cli_arch
if [ "$(uname -m)" = "aarch64" ]; then CLI_ARCH=arm64; fi
retry_command "curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}" 10 30
sha256sum --check cilium-linux-${CLI_ARCH}.tar.gz.sha256sum
tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /var/opt/k4all/bin
rm cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}

CILIUM_ARGS=(
  --set ipam.operator.clusterPoolIPv4PodCIDRList="$POD_NET"
  --set kubeProxyReplacement=true
  --set operator.replicas=1
  --set k8sClientRateLimit.qps=10
  --set k8sClientRateLimit.burst=20
  --set k8sServiceHost=$(get_cluster_ip)
  --set k8sServicePort=6443
)

DEVICES="ovs-bridge"
ADDITIONAL_DEVICES=$(jq -r '.cni.cilium.additionalDevices // ""' "$K4ALL_CONFIG_FILE")
if [ -n "$ADDITIONAL_DEVICES" ]; then
  DEVICES="$DEVICES,$ADDITIONAL_DEVICES"
fi
CILIUM_ARGS+=(--set devices="$DEVICES")

GATEWAY_API_ENABLED=$(jq -r '.cni.cilium.gatewayApi // "false"' "$K4ALL_CONFIG_FILE")
if [ "$GATEWAY_API_ENABLED" = "true" ]; then
  kubectl delete -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.0/standard-install.yaml || true
  kubectl --kubeconfig=/etc/kubernetes/admin.conf apply --server-side \
    -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.0/standard-install.yaml

  #to solve the issue with the tlsroutes crd
  kubectl --kubeconfig=/etc/kubernetes/admin.conf patch crd tlsroutes.gateway.networking.k8s.io --type='json' -p='[{"op": "replace", "path": "/spec/versions/1/served", "value": true}]'
  CILIUM_ARGS+=(--set gatewayAPI.enabled=true)
fi

L2_ANNOUNCEMENTS_ENABLED=$(jq -r '.cni.cilium.l2announcements // "false"' "$K4ALL_CONFIG_FILE")
if [ "$L2_ANNOUNCEMENTS_ENABLED" = "true" ]; then
  CILIUM_ARGS+=(--set l2announcements.enabled=true)
fi

HUBBLE_ENABLED=$(jq -r '.cni.cilium.hubble // "false"' "$K4ALL_CONFIG_FILE")
if [ "$HUBBLE_ENABLED" = "true" ]; then
  HUBBLE_UI_HOST=hubble.$(get_cluster_ip).nip.io
  CILIUM_ARGS+=(
    --set hubble.relay.enabled=true
    --set hubble.ui.enabled=true
    --set hubble.ui.ingress.enabled=true
    --set hubble.ui.ingress.hosts[0]="$HUBBLE_UI_HOST"
  )
fi

# Cilium Ingress Controller (reads from ingress section, not cni.cilium)
INGRESS_ENABLED=$(jq -r '.ingress.cilium.enabled // "false"' "$K4ALL_CONFIG_FILE")
INGRESS_IS_DEFAULT=$(jq -r '.ingress.cilium.isDefault // "false"' "$K4ALL_CONFIG_FILE")
if [ "$INGRESS_ENABLED" = "true" ]; then
  CILIUM_ARGS+=(
    --set ingressController.enabled=true
    --set ingressController.default="$INGRESS_IS_DEFAULT"
    --set ingressController.loadbalancerMode=shared
    --set ingressController.service.labels."k4all-ingress"="cilium"
  )
fi

if [ -z "$CILIUM_DEDICATED_IP" ] && [ "$HA_TYPE" != "kubevip" ] && [ "$INGRESS_IS_DEFAULT" = "true" ]; then
    echo "Setting ingressController.hostNetwork.enabled=true because CILIUM_DEDICATED_IP is not set, HA_TYPE is none and INGRESS_IS_DEFAULT is true"
    CILIUM_ARGS+=(--set ingressController.hostNetwork.enabled=true)
    CILIUM_ARGS+=(--set ingressController.hostNetwork.httpPort=80)
    CILIUM_ARGS+=(--set ingressController.hostNetwork.httpsPort=443)
    CILIUM_ARGS+=(--set ingressController.service.type=ClusterIP)
else
  echo "Setting controller.hostPort=false because NGINX_DEDICATED_IP is set, HA_TYPE is not none or NGINX_IS_DEFAULT is not true"
  CILIUM_ARGS+=(--set ingressController.hostPort.enabled=false)
fi

# Install cilium CNI
helm upgrade --install cilium oci://quay.io/cilium/charts/cilium \
  --kubeconfig=/etc/kubernetes/admin.conf \
  --namespace kube-system --version $CILIUM_VERSION \
  "${CILIUM_ARGS[@]}"

# this is to avoid the issue with the CRDs not being ready in next steps
echo "Waiting for CRDs..."
for crd in ciliumloadbalancerippools.cilium.io ciliuml2announcementpolicies.cilium.io; do
  until kubectl --kubeconfig=/etc/kubernetes/admin.conf get crd "$crd" >/dev/null 2>&1; do
    echo "Waiting for CRD $crd..."
    sleep 2
  done
done

# If Cilium L2 announcements are enabled, create L2 resources for dedicated IPs
# If Cilium L2 announcements are enabled, create dedicated LB IP pools and L2 policies

if [ "$L2_ANNOUNCEMENTS_ENABLED" = "true" ]; then

  if [ -n "$NGINX_DEDICATED_IP" ]; then
    echo "Creating Cilium LB IP pool and L2 policy for NGINX IP: $NGINX_DEDICATED_IP"

    cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata:
  name: k4all-ingress-nginx-pool
spec:
  blocks:
    - cidr: ${NGINX_DEDICATED_IP}/32
  serviceSelector:
    matchLabels:
      k4all-ingress: nginx
---
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: k4all-l2-policy-nginx
spec:
  serviceSelector:
    matchLabels:
      k4all-ingress: nginx
  loadBalancerIPs: true
  interfaces:
    - ^ovs-bridge$
EOF
  fi

  if [ -n "$CILIUM_DEDICATED_IP" ]; then
    echo "Creating Cilium LB IP pool and L2 policy for Cilium IP: $CILIUM_DEDICATED_IP"

    cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata:
  name: k4all-ingress-cilium-pool
spec:
  blocks:
    - cidr: ${CILIUM_DEDICATED_IP}/32
  serviceSelector:
    matchLabels:
      k4all-ingress: cilium
---
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: k4all-l2-policy-cilium
spec:
  serviceSelector:
    matchLabels:
      k4all-ingress: cilium
  loadBalancerIPs: true
  interfaces:
    - ^ovs-bridge$
EOF
  fi
fi

touch /opt/k4all/cilium-setup.done
