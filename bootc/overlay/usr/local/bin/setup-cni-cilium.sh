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

# Install cilium CLI
retry_command "CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)" 10 30
set_cli_arch
if [ "$(uname -m)" = "aarch64" ]; then CLI_ARCH=arm64; fi
retry_command "curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}" 10 30
sha256sum --check cilium-linux-${CLI_ARCH}.tar.gz.sha256sum
tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /var/opt/k4all/bin
rm cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}


$CILIUM_ARGS=(
  --set ipam.operator.clusterPoolIPv4PodCIDRList="$POD_NET" \
  --set kubeProxyReplacement=true \
  --set operator.replicas=1 \
  --set k8sClientRateLimit.qps=10 \
  --set k8sClientRateLimit.burst=20 \
  --set k8sServiceHost=$(get_cluster_ip) \
  --set k8sServicePort=6443
)

DEVICES="ovs-bridge"
ADDITIONAL_DEVICES=$(jq -r '.cni.cilium.additionalDevices // ""' "$K4ALL_CONFIG_FILE")
if [ "$ADDITIONAL_DEVICES" != "" ]; then# Merge the additional devices with the existing devices
  DEVICES="$DEVICES,$ADDITIONAL_DEVICES"
fi
CILIUM_ARGS+=(
  --set devices="$DEVICES"
)

GATEWAY_API_ENABLED=$(jq -r '.cni.cilium.gatewayApi // "false"' "$K4ALL_CONFIG_FILE")
if [ "$GATEWAY_API_ENABLED" = "true" ]; then
  kubectl --kubeconfig=/etc/kubernetes/admin.conf apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.0/standard-install.yaml
  CILIUM_ARGS+=(
    --set gatewayAPI.enabled=true
  )
fi

L2_ANNOUNCEMENTS_ENABLED=$(jq -r '.cni.cilium.l2announcements // "false"' "$K4ALL_CONFIG_FILE")
if [ "$L2_ANNOUNCEMENTS_ENABLED" = "true" ]; then
  CILIUM_ARGS+=(
    --set l2announcements.enabled=true
  )
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

INGRESS_ENABLED=$(jq -r '.cni.cilium.ingress // "false"' "$K4ALL_CONFIG_FILE")
if [ "$INGRESS_ENABLED" = "true" ]; then
  CILIUM_ARGS+=(
    --set ingressController.enabled=true \
    --set ingressController.default=true \
    --set ingressController.loadbalancerMode=shared
  )
fi


# Install cilium CNI
helm upgrade --install cilium oci://quay.io/cilium/charts/cilium --kubeconfig=/etc/kubernetes/admin.conf --namespace kube-system --version $CILIUM_VERSION "${CILIUM_ARGS[@]}"

# Done
touch /opt/k4all/cilium-setup.done
