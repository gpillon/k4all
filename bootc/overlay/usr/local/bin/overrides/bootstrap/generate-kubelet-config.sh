#!/bin/bash

set -euxo pipefail

# Function to display usage
usage() {
    echo "Usage: $0 [--force|-f]"
    exit 1
}

# Parse command-line options
FORCE_UPDATE=false
while [[ "$#" -gt 0 ]]; do
    case $1 in
        -f|--force) FORCE_UPDATE=true ;;
        *) usage ;;
    esac
    shift
done

# Set the Kubernetes version
KUBE_VERSION=$(kubectl version | grep Server | awk '{print $3}')

# Extract cluster DNS and Domain from the CoreDNS ConfigMap (common default settings)
CLUSTER_DNS_IP=$(kubectl get cm coredns -n kube-system -o jsonpath='{.data.Corefile}' | grep 'forward' | awk '{print $2}')
CLUSTER_DOMAIN=$(kubectl get cm coredns -n kube-system -o jsonpath='{.data.Corefile}' | grep 'kubernetes' | awk '{print $2}')

# Determine the Cgroup Driver used by the kubelet
CGROUP_DRIVER=$(ps aux | grep kubelet | grep -oP 'cgroup-driver=\K\S+' || echo "systemd")

# Create the kubelet configuration file
cat <<EOF >kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: $CGROUP_DRIVER
clusterDNS:
  - "$CLUSTER_DNS_IP"
clusterDomain: "$CLUSTER_DOMAIN"
failSwapOn: false
rotateCertificates: true
serverTLSBootstrap: true
EOF

# Define the ConfigMap name
CONFIG_MAP_NAME="kubelet-config"

# Check if the ConfigMap exists
if kubectl get configmap $CONFIG_MAP_NAME -n kube-system > /dev/null 2>&1; then
    if [ "$FORCE_UPDATE" = true ]; then
        echo "Forcing update of the ConfigMap."
        kubectl delete configmap $CONFIG_MAP_NAME -n kube-system
        kubectl create configmap $CONFIG_MAP_NAME --from-file=kubelet=kubelet-config.yaml -n kube-system
        echo "ConfigMap $CONFIG_MAP_NAME updated successfully in the kube-system namespace."
    else
        echo "ConfigMap $CONFIG_MAP_NAME already exists. Use --force or -f to overwrite."
    fi
else
    kubectl create configmap $CONFIG_MAP_NAME --from-file=kubelet=kubelet-config.yaml -n kube-system
    echo "ConfigMap $CONFIG_MAP_NAME created successfully in the kube-system namespace."
fi
