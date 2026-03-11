#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/feature-virt-setup.done" ]; then
  echo "Virt Feature setup already done. Exiting."
  exit 0
fi

export KUBECONFIG=/root/.kube/config
export HOME=/root/

source /usr/local/bin/k4all-utils

# Resolve kubevirt version: use manifest pinned version, fall back to latest stable
KUBEVIRT_VERSION=$(get_component_version kubevirt)
if [ -z "$KUBEVIRT_VERSION" ] || [ "$KUBEVIRT_VERSION" = "null" ] || [ "$KUBEVIRT_VERSION" = "latest" ]; then
  KUBEVIRT_VERSION_URL=$(get_component_version_url kubevirt)
  if [ -n "$KUBEVIRT_VERSION_URL" ] && [ "$KUBEVIRT_VERSION_URL" != "null" ]; then
    KUBEVIRT_VERSION=$(curl -sL "$KUBEVIRT_VERSION_URL")
  else
    KUBEVIRT_VERSION=$(curl -sL https://storage.googleapis.com/kubevirt-prow/release/kubevirt/kubevirt/stable.txt)
  fi
fi
export RELEASE="$KUBEVIRT_VERSION"

retry_command "kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-operator.yaml" 10 30
retry_command "kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-cr.yaml" 10 30
kubectl -n kubevirt patch kubevirt kubevirt --type=merge --patch '{"spec":{"infra":{"replicas": 1 }}}'
kubectl -n kubevirt wait kubevirt kubevirt --for condition=Available --timeout=3600s

set_cli_arch
# Install virtctl
K4ALL_BIN="/var/opt/k4all/bin"
retry_command "curl -L https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/virtctl-${RELEASE}-linux-${CLI_ARCH} -o ${K4ALL_BIN}/virtctl-${RELEASE}-linux-${CLI_ARCH}" 10 30
chmod +x ${K4ALL_BIN}/virtctl-${RELEASE}-linux-${CLI_ARCH}
ln -sf ${K4ALL_BIN}/virtctl-${RELEASE}-linux-${CLI_ARCH} ${K4ALL_BIN}/virtctl
chmod +x ${K4ALL_BIN}/virtctl

virtctl completion bash > /etc/bash_completion.d/virtctl_bash_completion

#Enable Emulation
virt_emulation=$(jq -r '.features.virt.emulation' "$K4ALL_CONFIG_FILE")
if [ "$virt_emulation" = "true" ]; then
    kubectl -n kubevirt patch kubevirt kubevirt --type=merge --patch '{"spec":{"configuration":{"developerConfiguration":{"useEmulation":true}}}}'
elif [ "$virt_emulation" = "auto" ]; then
    # Check if /dev/kvm exists
    if [ ! -e /dev/kvm ]; then
        kubectl -n kubevirt patch kubevirt kubevirt --type=merge --patch '{"spec":{"configuration":{"developerConfiguration":{"useEmulation":true}}}}'
    fi
fi

# Resolve CDI version: use manifest pinned version, fall back to latest
CDI_VERSION=$(get_component_version cdi)
if [ -z "$CDI_VERSION" ] || [ "$CDI_VERSION" = "null" ] || [ "$CDI_VERSION" = "latest" ]; then
  export TAG=$(curl -s -w %{redirect_url} https://github.com/kubevirt/containerized-data-importer/releases/latest)
  CDI_VERSION=$(echo ${TAG##*/})
fi
export VERSION="$CDI_VERSION"
kubectl apply -f https://github.com/kubevirt/containerized-data-importer/releases/download/$VERSION/cdi-operator.yaml
kubectl apply -f https://github.com/kubevirt/containerized-data-importer/releases/download/$VERSION/cdi-cr.yaml
kubectl patch cdi cdi --patch '{"spec": {"config": {"podResourceRequirements": {"limits": {"memory": "2G"}}}}}' --type merge

#Install Kubevirt-manager
kubectl apply -f https://raw.githubusercontent.com/kubevirt-manager/kubevirt-manager/main/kubernetes/bundled.yaml
kubectl apply -f https://raw.githubusercontent.com/kubevirt-manager/kubevirt-manager/main/kubernetes/crd.yaml
# Patch deployment image if needed
patch_deployment_image_registry kubevirt-manager kubevirt-manager 0 docker.io

#Apply Kubevirt-manager Ingress And Patch Routes
kubectl apply -f /usr/local/share/virt-ingress-routes.yaml
patch_ingress "$(get_ip).nip.io" 0 "kubevirt" "kubevirt-manager" "kubevirt-manager"
patch_ingress "$(get_fqdn)" 1 "kubevirt" "kubevirt-manager" "kubevirt-manager"

#Apply CDI Ingress And Patch Routes
kubectl apply -f /usr/local/share/cdi-ingress-routes.yaml
patch_ingress "$(get_ip).nip.io" 0 "cdi-uploadproxy" "cdi-uploadproxy" "cdi"
patch_ingress "$(get_fqdn)" 1 "cdi-uploadproxy" "cdi-uploadproxy" "cdi"

# Done
touch /opt/k4all/feature-virt-setup.done