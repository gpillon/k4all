#!/bin/bash
# Script to join a new node as a Worker to an existing Kubernetes cluster using an argument

# Check if a join command was passed as an argument
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 '<join_command>'"
    exit 1
fi

source /usr/local/bin/k4all-utils
KUBELET_CONF="${KUBELET_CONF:-/etc/kubernetes/kubelet.conf}"
KUBELET_CLIENT_CERT="${KUBELET_CLIENT_CERT:-/var/lib/kubelet/pki/kubelet-client-current.pem}"
# Decode the join command provided as the argument
JOIN_COMMAND=$(echo "$1" | base64 -d)

# Run the join command
sudo bash -c "$JOIN_COMMAND"

setup_kubeconfig_for_user "root" "/root" "kubelet.conf"
setup_kubeconfig_for_user "core" "/home/core" "kubelet.conf"

# The Node's name: the kubelet's client certificate says it
# (CN=system:node:<name>); before it exists, the hostname, lowercased as
# kubeadm registers it.
node_name() {
    local name
    name=$(openssl x509 -noout -subject -nameopt multiline \
               -in "$KUBELET_CLIENT_CERT" 2>/dev/null \
           | sed -n 's/^ *commonName *= *system:node://p')
    [ -n "$name" ] || name=$(hostname | tr '[:upper:]' '[:lower:]')
    echo "$name"
}

# Function to verify node join. A worker has only kubelet.conf, and the Node
# authorizer lets a kubelet read its own Node and nothing else: `kubectl get
# nodes` is always forbidden here.
verify_join() {
    local max_attempts=10
    local attempt=0
    local sleep_time=6  # seconds
    local node_name
    node_name=$(node_name)

    echo "Verifying node has joined the cluster as a Worker..."
    while [[ $attempt -lt $max_attempts ]]; do
        if [ -f "$KUBELET_CONF" ] && systemctl is-active --quiet kubelet \
                && kubectl --kubeconfig "$KUBELET_CONF" get node "$node_name" \
                    -o name >/dev/null; then
            echo "Node has successfully joined the cluster as a Worker node."
            return 0
        else
            echo "Attempt $((attempt + 1))/$max_attempts failed, retrying in $sleep_time seconds..."
            sleep $sleep_time
            ((attempt++))
        fi
    done
    echo "Failed to verify node join after $max_attempts attempts."
    return 1
}

# Verify node join with retries
if verify_join; then
    echo "You can now deploy applications and services to the cluster."
else
    echo "Verification failed. Please check cluster status and node connectivity."
    exit 1
fi

# Exit successfully
exit 0