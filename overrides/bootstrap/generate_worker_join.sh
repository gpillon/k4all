#!/bin/bash
# Script to generate Kubernetes join command for new control plane nodes in a single line

# Generate a new token and print the join command
JOIN_COMMAND=$(kubeadm token create --print-join-command)

# Combine the join command with control plane and certificate key options
echo "${JOIN_COMMAND}"