#!/bin/bash

# Initialize variables
mode=""
debug=0
join_time=""

function print_help {
    echo "Usage: $0 [MODE] [OPTIONS]"
    echo ""
    echo "MODE:"
    echo "  worker                Generate a join command for a worker node."
    echo "  control               Generate a join command for a control plane node."
    echo ""
    echo "OPTIONS:"
    echo "  --unattended          Output the join command without any additional output. (overrides all other options)"
    echo "  --debug               Output the join command in clear text."
    echo ""
    echo "Examples:"
    echo "  $0 worker --debug     Generate a clear text join command for a worker node."
    echo "  $0 control            Generate a base64 encoded join command for a control plane node."
}

# Parse command-line arguments
for arg in "$@"
do
    case $arg in
        worker|control)
            mode=$arg
            ;;
        --debug)
            debug=1
            ;;
        --unattended)
            unattended=1
            ;;
        --help)
            print_help
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            print_help
            exit 1
            ;;
    esac
done

# Check if mode is specified
if [[ -z $mode ]]; then
    echo "Error: Mode (worker or control) must be explicitly specified."
    print_help
    exit 1
fi

source /usr/local/bin/k4all-utils

# Pods that started before the cluster's CNI hold addresses of CRI-O's bridge
# (10.85.0.0/16), which no other node can reach: coredns among them. Before a
# second node joins, start them again on the cluster's CNI and drop the
# bridge. Messages go to stderr: --unattended prints only the join command.
# The first boot of the bootstrap node already did it (deploy-operator.sh);
# this is the safety net, and costs nothing once the marker is gone.
if cluster_cni_present; then
    handover_crio_bridge >&2 || true
elif [ -e "$CNI_NET_DIR/$CRIO_BRIDGE_CNI" ]; then
    echo "WARNING: the cluster's CNI is not installed yet: pods on CRI-O's bridge" \
         "($CNI_NET_DIR/$CRIO_BRIDGE_CNI) cannot be reached from other nodes" >&2
fi

# Generate a unique join token and capture the current time as the join time
JOIN_COMMAND=$(kubeadm token create --print-join-command)

# Get current nodes
current_nodes=$(kubectl get nodes -o jsonpath='{.items[*].metadata.name}')

if [[ $mode == "control" ]]; then
    # Generate and upload certificates, capturing the certificate key for control plane nodes
    CERT_KEY=$(kubeadm init phase upload-certs --upload-certs | tail -1)
    JOIN_COMMAND="${JOIN_COMMAND} --control-plane --certificate-key ${CERT_KEY}"
fi


if [[ $unattended -eq 1 ]]; then
    echo "${JOIN_COMMAND}"
elif [[ $debug -eq 1 ]]; then
    # Output in clear text if --debug is specified
    echo "Clear text join command:"
    echo "${JOIN_COMMAND}"
else
    # Encode in base64 by default
    JOIN_COMMAND_BASE64=$(echo "${JOIN_COMMAND}" | base64 -w0)
    echo "Join token generated successfully. Now you can use the following command to join a new node to the cluster:"
    echo "    join_cluster.sh ${JOIN_COMMAND_BASE64}"

    if [[ $mode == "worker" ]]; then
        # Wait for a new node to join
        echo "Waiting for a new node to join the cluster..."
        new_node_detected=false
        while ! $new_node_detected; do
            sleep 5  # Check every 10 seconds for a new node
            all_nodes=$(kubectl get nodes -o jsonpath='{.items[*].metadata.name}')
            for node in $all_nodes; do
                if [[ ! "$current_nodes" =~ "$node" ]]; then
                    echo "New node detected: $node"
                    new_node_detected=true

                    # Set the node role to worker
                    echo "Setting node role to worker..."
                    kubectl label node $node node-role.kubernetes.io/worker=""

                    # Delete the join token now that the new node has joined
                    echo "Deleting join token..."
                    kubeadm token delete $(echo $JOIN_COMMAND | awk '{print $5}')  # Assumes the token is the third element in JOIN_COMMAND

                    break
                fi
            done
        done
    fi
fi