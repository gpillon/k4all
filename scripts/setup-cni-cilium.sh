#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/cilium-setup.done" ]; then
  echo "Cilium setup already done. Exiting."
  exit 0
fi

CILIUM_VERSION="1.19.1"
KUBECONFIG=/root/.kube/config
export HOME=/root/

source /usr/local/bin/k4all-utils

# Install cilium CLI
retry_command "CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)" 10 30
set_cli_arch
if [ "$(uname -m)" = "aarch64" ]; then CLI_ARCH=arm64; fi
retry_command "curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}" 10 30
sha256sum --check cilium-linux-${CLI_ARCH}.tar.gz.sha256sum
tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /usr/local/bin
rm cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}

# Install cilium CNI
cilium install --version $CILIUM_VERSION \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=$(get_cluster_ip) \
  --set k8sServicePort=6443 \
  --set l2announcements.enabled=true \
  --set k8sClientRateLimit.qps=10 \
  --set k8sClientRateLimit.burst=20

# Done
touch /opt/k4all/cilium-setup.done