#!/bin/bash
set -euxo pipefail

if [ -f "/var/lib/cilium-setup.done" ]; then
  echo "Cilium setup already done. Exiting."
  exit 0
fi

CILIUM_VERSION="1.16.1"
KUBECONFIG=/root/.kube/config
export HOME=/root/

source /usr/local/bin/k4all-utils

# Install cilium CLI
retry_command "CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)" 10 30
CLI_ARCH=amd64
if [ "$(uname -m)" = "aarch64" ]; then CLI_ARCH=arm64; fi
retry_command "curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}" 10 30
sha256sum --check cilium-linux-${CLI_ARCH}.tar.gz.sha256sum
tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /usr/local/bin
rm cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}

# Install cilium CNI
cilium install --version $CILIUM_VERSION

# Done
touch /var/lib/cilium-setup.done