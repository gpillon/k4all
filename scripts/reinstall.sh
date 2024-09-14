#!/bin/bash
set -euo pipefail

# Function to display the help message
show_help() {
  echo "Usage: $0 [OPTIONS]"
  echo
  echo "This script resets the Kubernetes setup by removing specific done files and rebooting the system."
  echo
  echo "Options:"
  echo "  --network       Delete the /opt/k4all/setup-ph2.done file (related to network configuration)."
  echo "  --kubernetes    Delete the /opt/k4all/k8s-setup-init.done file (related to Kubernetes initialization)."
  echo "  --hostname      Delete the /opt/k4all/setup-hostname.done file (related to Hostname)."
  echo "  --help          Show this help message and exit."
  echo
  echo "WARNING: Reinstalling the cluster could be dangerous if several modifications have been made."
}

# Function to display a warning and ask for user confirmation
ask_for_confirmation() {
  echo "WARNING: Reinstalling the cluster could be dangerous if several modifications have been made."
  echo "This action may result in data loss or misconfiguration. Do you want to proceed? (yes/no)"
  read -r confirmation
  if [[ "$confirmation" != "yes" ]]; then
    echo "Aborted by user."
    exit 0
  fi
}

# Initialize flag variables
network_flag=false
kubernetes_flag=false
hostname_flag=false

# Parse command-line options
for arg in "$@"; do
  case $arg in
    --network)
      network_flag=true
      shift
      ;;
    --kubernetes)
      kubernetes_flag=true
      shift
      ;;
    --hostname)
      hostname_flag=true
      shift
      ;;
    --help)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      show_help
      exit 1
      ;;
  esac
done

# Ask for confirmation before proceeding
ask_for_confirmation

# Delete all other *.done files except the ones specifically handled by flags
for file in /opt/k4all/*.done; do
  if [[ "$file" != "/opt/k4all/setup-ph3.done"  && "$file" != "/opt/k4all/setup-ph2.done" && "$file" != "/opt/k4all/k8s-setup-init.done"  && "$file" != "/opt/k4all/setup-hostname.done" ]]; then
    echo "Deleting $file"
    rm -f "$file"
  fi
done

# Delete specific files based on flags
if [ "$network_flag" = true ]; then
  if [ -f "/opt/k4all/setup-ph2.done" ]; then
    echo "Deleting /opt/k4all/setup-ph2.done"
    rm -f /opt/k4all/setup-ph2.done
  else
    echo "/opt/k4all/setup-ph2.done does not exist"
  fi
    if [ -f "/opt/k4all/setup-ph3.done" ]; then
    echo "Deleting /opt/k4all/setup-ph3.done"
    rm -f /opt/k4all/setup-ph3.done
  else
    echo "/opt/k4all/setup-ph3.done does not exist"
  fi
fi

if [ "$kubernetes_flag" = true ]; then
  if [ -f "/opt/k4all/k8s-setup-init.done" ]; then
    echo "Deleting /opt/k4all/k8s-setup-init.done"
    rm -f /opt/k4all/k8s-setup-init.done
  else
    echo "/opt/k4all/k8s-setup-init.done does not exist"
  fi
fi

if [ "$hostname_flag" = true ]; then
  if [ -f "/opt/k4all/setup-hostname.done" ]; then
    echo "Deleting /opt/k4all/setup-hostname.done"
    rm -f /opt/k4all/setup-hostname.done
  else
    echo "/opt/k4all/setup-hostname.done does not exist"
  fi
fi

# Reboot the system
systemctl reboot
