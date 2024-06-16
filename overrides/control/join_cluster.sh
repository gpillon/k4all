
#!/bin/bash
# Script to join a new node as a control plane to an existing Kubernetes cluster using an argument

# Check if a join command was passed as an argument
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 '<join_command>'"
    exit 1
fi

# Use the join command provided as the argument
JOIN_COMMAND="$1"

# Run the join command
sudo bash -c "$JOIN_COMMAND"

# Optionally, configure kubeconfig for convenience
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# Verify join
echo "Node has joined the cluster as a control plane node. Verifying..."
kubectl get nodes | grep $(hostnamectl --static)

kubectl --kubeconfig=/etc/kubernetes/admin.conf taint nodes $(hostnamectl --static) node-role.kubernetes.io/control-plane:NoSchedule-

echo "Node has been successfully joined to the cluster as a control plane node."
echo "You can now deploy applications and services to the cluster."

# Exit successfully
exit 0