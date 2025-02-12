#!/bin/bash

# Path to the kube-apiserver YAML file
FILE_PATH="/etc/kubernetes/manifests/kube-apiserver.yaml"

# Check if the file exists
if [ ! -f "$FILE_PATH" ]; then
  echo "\n [ WARNING ] File not found: $FILE_PATH.\n"
  return
fi

# Extract the advertise address using yq
advertise_address=$(yq e '.spec.containers[0].command[] | select(. | contains("--advertise-address"))' $FILE_PATH | cut -d'=' -f2 | cut -d':' -f1)

# Check if we got the advertise address
if [ -z "$advertise_address" ]; then
  echo "Advertise address not found in $FILE_PATH"
  exit 1
fi

# List all IP addresses on the host
host_ips=$(hostname -I)

# Check if any host IP matches the advertise address
if [[ $host_ips =~ $advertise_address ]]; then
 printf "\n[ OK ] Host IP $advertise_address is used as Kubernetes API advertise address.\n"
else
  printf "\n[ ERROR ] Kubernetes Advertise address $advertise_address is not any of the host IPs.\n"
fi
