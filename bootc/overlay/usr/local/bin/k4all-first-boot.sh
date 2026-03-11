#!/bin/bash
# K4All - First Boot Safety Net
# Ensures /etc/node-type and /etc/k4all-config.json exist even if the
# Anaconda addon failed to write them during installation.
set -euo pipefail

DONE_FILE="/opt/k4all/first-boot.done"
DEFAULT_CONFIG="/usr/local/share/default-cluster-config.json"

if [ -f "$DONE_FILE" ]; then
    exit 0
fi

echo "K4All first-boot: checking configuration files..."

if [ ! -f /etc/node-type ]; then
    echo "WARNING: /etc/node-type missing — defaulting to 'bootstrap'"
    echo "bootstrap" > /etc/node-type
fi

if [ ! -f /etc/k4all-config.json ]; then
    if [ -f "$DEFAULT_CONFIG" ]; then
        echo "WARNING: /etc/k4all-config.json missing — copying default config"
        cp "$DEFAULT_CONFIG" /etc/k4all-config.json
    else
        echo "ERROR: Neither /etc/k4all-config.json nor $DEFAULT_CONFIG exist"
        exit 1
    fi
fi

RELEASE_MANIFEST="/usr/local/share/k4all-release.yaml"
if [ ! -f /etc/k4all-release.yaml ] && [ -f "$RELEASE_MANIFEST" ]; then
    echo "Copying base release manifest to /etc/k4all-release.yaml"
    cp "$RELEASE_MANIFEST" /etc/k4all-release.yaml
fi

mkdir -p /var/opt/k4all
mkdir -p /var/home/core/.kube
mkdir -p /var/roothome/.kube

mkdir -p /opt/k4all
touch "$DONE_FILE"
echo "K4All first-boot: configuration verified."
