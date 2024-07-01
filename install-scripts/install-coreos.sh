#!/bin/bash
set -euxo pipefail

wait_for_config() {
  local timeout=3600  # Timeout in seconds (5 minutes)
  local interval=5   # Check interval in seconds
  local elapsed=0

  echo "Waiting for /tmp/k4all-config.json to be created..."

  while [[ ! -f /tmp/k4all-config.json ]]; do
    sleep $interval
    elapsed=$((elapsed + interval))
    if [[ $elapsed -ge $timeout ]]; then
      echo "Timeout: /tmp/k4all-config.json was not created within $timeout seconds."
      exit 1
    fi
  done

  echo "/tmp/k4all-config.json has been created."
}

# Wait for the configuration file to be created
wait_for_config

dmsetup remove_all -f

echo "Running pre-install script..."
/usr/local/bin/pre-install.sh

DISK=$(/usr/local/bin/disk-helper.sh)
/usr/bin/coreos-installer install /dev/$DISK --ignition-file /usr/local/bin/k8s.ign 

echo "Installation complete. Running post-install script..."
/usr/local/bin/post-install.sh
echo "Post-install script complete."
