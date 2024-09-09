#!/bin/bash

# Exit on error, undefined variable, or pipe failure
set -euo pipefail

# Check if an argument is provided, otherwise default to "./fcos/"
FCOS_PATH="${1:-./}"

# Function to fetch the ISO URL and set FCOS_IMAGE
fetch_fcos_image() {
    # Define architecture and CoreOS stable JSON URL
    ARCH=x86_64
    COREOS_JSON=https://builds.coreos.fedoraproject.org/streams/stable.json

    # Extract the ISO URL from the CoreOS JSON
    echo -e "Getting Latest Fedora CoreOS image..."
    ISO_URL=$(curl -s "$COREOS_JSON" | jq -r ".architectures.$ARCH.artifacts.metal.formats.iso.disk.location")

    # Extract the image file name from the URL and set it to FCOS_IMAGE
    FCOS_IMAGE=$(basename "$ISO_URL")
    echo -e "Using Latest Fedora CoreOS image... $FCOS_IMAGE"

    # Check if the file already exists in the specified path
    if [ -f "$FCOS_PATH$FCOS_IMAGE" ]; then
        echo "The file $FCOS_IMAGE already exists."
    else
        echo "The file $FCOS_IMAGE does not exist. Downloading..."
        # Download the ISO image
        curl -o "$FCOS_PATH$FCOS_IMAGE" "$ISO_URL"
        echo "Download completed."
    fi
}

# Function to check if a command exists
command_exists() {
  command -v "$1" &> /dev/null
}

if [ -n "${FCOS_IMAGE:-}" ]; then
    echo "The variable FCOS_IMAGE is already set to $FCOS_IMAGE. Skipping download."
else 
  fetch_fcos_image
fi

# Check for Docker or Podman availability
if command_exists podman; then
  CONTAINER_TOOL="podman"
elif command_exists docker; then
  CONTAINER_TOOL="docker"
else
  echo "Error: Neither Docker nor Podman is installed. Please install one to proceed."
  exit 1
fi

chmod -R +x ./install-scripts/*
chmod -R +x ./scripts/*

echo "Using $CONTAINER_TOOL as the container tool."

# Create the output directory if it doesn't exist
mkdir -p "$FCOS_PATH"

# Generate the Ignition file for the installation using Butane in a container
$CONTAINER_TOOL run --interactive -v "$(pwd):/data/" --rm quay.io/coreos/butane:release --pretty --strict -d /data/ < "k8s-base.bu" > "k8s-base.ign"

roles=("bootstrap" "control" "worker") # Add other elements as needed

for role in "${roles[@]}"; do
    # Generate the Ignition file for each role
    echo "Generating Ignition file for $role..."
    $CONTAINER_TOOL run --interactive -v "$(pwd):/data/" --rm quay.io/coreos/butane:release --pretty --strict -d /data/ < "k8s-$role.bu" > "k8s.ign"
    $CONTAINER_TOOL run --interactive -v $(pwd):/data/ --rm quay.io/coreos/butane:release --pretty --strict -d /data/ < install.bu > install.ign

    # Remove old ISO if it exists
    rm -rf "$FCOS_PATH/fcos40-k8s-$role.iso"

    # Generate the customized Fedora CoreOS ISO
    echo "Creating customized ISO for $role..."
    $CONTAINER_TOOL run --privileged --rm \
      -v /dev:/dev \
      -v "$(pwd):/data" \
      -w /data \
      -v "$FCOS_PATH:/fcos/" \
      quay.io/coreos/coreos-installer:release \
      iso ignition embed \
      -i "/data/install.ign" \
      -o "/fcos/fcos40-k8s-$role.iso" \
      "/fcos/$FCOS_IMAGE"

    # Modify kernel arguments for the ISO
    echo "Modifying kernel arguments for $role ISO..."
    $CONTAINER_TOOL run --privileged --rm \
     -v "$FCOS_PATH:/fcos/" \
     quay.io/coreos/coreos-installer:release \
     iso kargs modify \
     -a coreos.liveiso.fromram \
     "/fcos/fcos40-k8s-$role.iso"

     mv ./k8s.ign k8s-$role.ign
     mv ./install.ign install-$role.ign
done

echo "All processes completed."
