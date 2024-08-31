#!/bin/bash
# Script to join a new node as a Worker to an existing Kubernetes cluster using an argument

# Check if a join command was passed as an argument
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 '<join_command>'"
    exit 1
fi

source /usr/local/bin/k4all-utils
# Decode the join command provided as the argument
JOIN_COMMAND=$(echo "$1" | base64 -d)

# Run the join command
sudo bash -c "$JOIN_COMMAND"

setup_kubeconfig_for_user "root" "/root" "kubelet.conf"
setup_kubeconfig_for_user "core" "/home/core" "kubelet.conf"

# Function to verify node join
verify_join() {
    local max_attempts=10
    local attempt=0
    local sleep_time=6  # seconds
    local hostname=$(hostnamectl --static)

    echo "Verifying node has joined the cluster as a Worker..."
    while [[ $attempt -lt $max_attempts ]]; do
        if kubectl get nodes | grep -q "$hostname"; then
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