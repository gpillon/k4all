#!/bin/bash

# Script to remove all bootstrap tokens from a Kubernetes cluster

# Fetch all bootstrap token secrets and their names
token_names=$(kubectl get secrets -n kube-system -o jsonpath="{.items[?(@.type=='bootstrap.kubernetes.io/token')].metadata.name}")

# Check if there are any bootstrap tokens to delete
if [ -z "$token_names" ]; then
  echo "No bootstrap tokens found in the cluster."
  exit 0
fi

# Iterate over each token name and delete them
for token_name in $token_names; do
  kubectl delete secret $token_name -n kube-system
  echo "Deleted bootstrap token: $token_name"
done

echo "All bootstrap tokens have been removed from the cluster."
