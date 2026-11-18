#!/bin/bash
# Script to join a new node as a control plane to an existing Kubernetes cluster using an argument

# Check if a join command was passed as an argument
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 '<join_command>'"
    exit 1
fi

source /usr/local/bin/k4all-utils
# Use the join command provided as the argument
JOIN_COMMAND=$(echo "$1" | base64 -d)

# Run the join command
JOINED=false
if sudo bash -c "$JOIN_COMMAND" && [ -f /etc/kubernetes/kubelet.conf ]; then
    JOINED=true
fi

setup_kubeconfig_for_user "root" "/root"
setup_kubeconfig_for_user "core" "/home/core"

# Verify join
echo "Node has joined the cluster as a control plane node. Verifying..."
kubectl get nodes | grep $(hostnamectl --static)

kubectl --kubeconfig=/etc/kubernetes/admin.conf taint nodes $(hostnamectl --static) node-role.kubernetes.io/control-plane:NoSchedule-

# On an HA kube-vip cluster this control plane holds the VIP too: kube-vip's
# static pod, written after the join (kubeadm join wants the manifest
# directory empty, and admin.conf exists only now).
# Only after a join that worked: rc 0 and kubelet.conf there.
if [ "$JOINED" = true ]; then
    /usr/local/bin/k4all-upgrade kube-vip-manifest --write \
        || echo "WARNING: kube-vip not written; run 'k4all-upgrade kube-vip-manifest --write'"
else
    echo "WARNING: the join did not work: kube-vip not written"
fi

echo "Node has been successfully joined to the cluster as a control plane node."
echo "You can now deploy applications and services to the cluster."

# Exit successfully
exit 0