#!/bin/bash

# Exit on error, undefined variable, or pipe failure
set -euxo pipefail

# Function to check if a command exists
command_exists() {
  command -v "$1" &> /dev/null
}

# Check for Docker or Podman availability
if command_exists podman; then
  CONTAINER_TOOL="podman"
elif command_exists docker; then
  CONTAINER_TOOL="docker"
else
  echo "Error: Neither Docker nor Podman is installed. Please install one to proceed."
  exit 1
fi

chmod +x ./install-scripts/*
chmod +x ./scripts/*

echo "Using $CONTAINER_TOOL as the container tool."

# Check if an argument is provided, otherwise default to "./fcos/"
FCOS_PATH="${1:-./}"

# Create the output directory if it doesn't exist
mkdir -p "$FCOS_PATH"

# Generate the Ignition file for Kubernetes using Butane in a container
$CONTAINER_TOOL run --interactive -v $(pwd):/data/ --rm quay.io/coreos/butane:release --pretty --strict -d /data/ < k8s.bu > k8s.ign

# Generate the Ignition file for the installation using Butane in a container
$CONTAINER_TOOL run --interactive -v $(pwd):/data/ --rm quay.io/coreos/butane:release --pretty --strict -d /data/ < install.bu > install.ign

# Generate the customized Fedora CoreOS ISO using CoreOS Installer in a container
rm -rf "$FCOS_PATH/fcos40-k8s.iso" && \
$CONTAINER_TOOL run --privileged --rm \
  -v /dev:/dev \
  -v .:/data \
  -w /data \
  -v "$FCOS_PATH":/fcos/ \
  quay.io/coreos/coreos-installer:release \
  iso ignition embed \
  -i /data/install.ign \
  -o "/fcos/fcos40-k8s.iso" \
  "/fcos/fedora-coreos-40.20240504.3.0-live.x86_64.iso"

$CONTAINER_TOOL run --privileged --rm \
 -v "$FCOS_PATH":/fcos/ \
 quay.io/coreos/coreos-installer:release \
 iso kargs modify \
 -a coreos.liveiso.fromram \
 /fcos/fcos40-k8s.iso 

 #-a dm_mod.blacklist=1 \
 #-a rd.driver.blacklist=dm_mod \

echo "ISO generated successfully!"

