#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/feature-virt-setup.done" ]; then
  echo "Virt Feature setup already done. Exiting."
  exit 0
fi

export KUBECONFIG=/root/.kube/config
export HOME=/root/

source /usr/local/bin/k4all-utils

# Install Kubevirt
export RELEASE=$(curl https://storage.googleapis.com/kubevirt-prow/release/kubevirt/kubevirt/stable.txt)
retry_command "kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-operator.yaml" 10 30
retry_command "kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-cr.yaml" 10 30
kubectl -n kubevirt patch kubevirt kubevirt --type=merge --patch '{"spec":{"infra":{"replicas": 1 }}}'
kubectl -n kubevirt wait kubevirt kubevirt --for condition=Available --timeout=3600s

set_cli_arch
# Install virtctl
retry_command "curl -L https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/virtctl-${RELEASE}-linux-${CLI_ARCH} -o /usr/local/bin/virtctl-${RELEASE}-linux-${CLI_ARCH}" 10 30
chmod +x /usr/local/bin/virtctl-${RELEASE}-linux-${CLI_ARCH}
ln -sf /usr/local/bin/virtctl-${RELEASE}-linux-${CLI_ARCH} /usr/local/bin/virtctl
chmod +x /usr/local/bin/virtctl

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

#Install CDI
export TAG=$(curl -s -w %{redirect_url} https://github.com/kubevirt/containerized-data-importer/releases/latest)
export VERSION=$(echo ${TAG##*/})
kubectl apply -f https://github.com/kubevirt/containerized-data-importer/releases/download/$VERSION/cdi-operator.yaml
kubectl apply -f https://github.com/kubevirt/containerized-data-importer/releases/download/$VERSION/cdi-cr.yaml
kubectl patch cdi cdi --patch '{"spec": {"config": {"podResourceRequirements": {"limits": {"memory": "2G"}}}}}' --type merge

#Install Kubevirt-manager
kubectl apply -f https://raw.githubusercontent.com/kubevirt-manager/kubevirt-manager/main/kubernetes/bundled.yaml
kubectl apply -f https://raw.githubusercontent.com/kubevirt-manager/kubevirt-manager/main/kubernetes/crd.yaml

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