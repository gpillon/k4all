#!/bin/bash
set -euxo pipefail

# Check for a node that's ready and schedulable
while true; do
  # Try to get the list of nodes and filter for those that are ready and schedulable
  if ready_nodes=$(kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes -o json | jq -r '.items[] | select((.status.conditions[] | select(.type=="Ready" and .status=="True")) and (.spec.taints == null or (.spec.taints | map(select(.key=="node-role.kubernetes.io/control-plane" and .effect == "NoSchedule")) | length == 0))) | .metadata.name'); then
    # Check if the result is non-empty
    if [ -n "$ready_nodes" ]; then
      echo "Node(s) ready and schedulable: $ready_nodes"
      break
    fi
  else
    echo "Failed to fetch nodes. Retrying in 5 seconds..."
  fi

  # Wait before checking again
  echo "Waiting for a node to become ready and schedulable..."
  sleep 5
done