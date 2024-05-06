#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/var/lib/k8s-setup.done" ]; then
  echo "Kubernetes setup already done. Exiting."
  exit 0
fi

# Install Kubernetes packages using rpm-ostree
rpm-ostree install kubeadm kubectl kubelet crio

rpm-ostree apply-live

# Enable and start kubelet service
systemctl enable --now crio
systemctl enable --now kubelet

# Initialize Kubernetes cluster
kubeadm init --config /etc/k8s-config.yaml

# Set up kubeconfig for the root user
mkdir -p /root/.kube
cp /etc/kubernetes/admin.conf /root/.kube/config
chown $(id -u):$(id -g) /root/.kube/config

kubectl completion bash > /root/.kube/completion.bash.inc
printf "
# kubectl shell completion
source '/root/.kube/completion.bash.inc'
" >> /root/.bash_profile

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/k8s-setup.done

