#!/bin/bash
set -euo pipefail

# Function to display the help message
show_help() {
  echo "Usage: $0 [OPTIONS]"
  echo
  echo "This script resets the Kubernetes setup by removing specific done files and rebooting the system."
  echo
  echo "Options:"
  echo "  --network       Delete the files related to network configuration."
  echo "  --kubernetes    Delete the files related to Kubernetes initialization."
  echo "  --hostname      Delete the files related to Hostname."
  echo "  --no-base       Skip Base Reinstallation."  
  echo "  --yes           Dont ask confirmation."
  echo "  --help          Show this help message and exit."
  echo
  echo "WARNING: Reinstalling the cluster could be dangerous if several modifications have been made."
}

# Function to display a warning and ask for user confirmation
ask_for_confirmation() {
  if [[ "$yes_flag" != "false" ]]; then
    return
  fi
  echo "WARNING: Reinstalling the cluster could be dangerous if several modifications have been made."
  echo "This action may result in data loss or misconfiguration. Do you want to proceed? (yes/no)"
  read -r confirmation
  if [[ "$confirmation" != "yes" ]]; then
    echo "Aborted by user."
    exit 0
  fi
}

delete_file() {
  local file_to_del=$1

  if [ -f "$file_to_del" ]; then
    echo "Deleting $file_to_del"
    rm -f $file_to_del
  else
    echo "$file_to_del does not exist"
  fi
}

# Initialize flag variables
network_flag=false
kubernetes_flag=false
hostname_flag=false
yes_flag=false
base=true

# Parse command-line options
for arg in "$@"; do
  case $arg in
    --yes)
      yes_flag=true
      shift
      ;;
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
    --no-base)
      base=false
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
if [ "$base" = true ]; then
  for file in /opt/k4all/*.done; do
    if [[ "$file" != "/opt/k4all/setup-ph3.done"  && "$file" != "/opt/k4all/setup-ph2.done" && "$file" != "/opt/k4all/k8s-setup-init.done"  && "$file" != "/opt/k4all/setup-hostname.done" && "$file" != "/opt/k4all/setup-ph3-reset-kube.done" ]]; then
      delete_file "$file"
    fi
  done
fi

# Delete specific files based on flags
if [ "$network_flag" = true ]; then
  delete_file /opt/k4all/setup-ph2.done
  delete_file /opt/k4all/setup-ph3.done
fi

if [ "$kubernetes_flag" = true ]; then
  delete_file "/opt/k4all/k8s-setup-init.done"
  delete_file "/opt/k4all/setup-ph3-reset-kube.done"
fi

if [ "$hostname_flag" = true ]; then
  delete_file "/opt/k4all/setup-hostname.done"
fi

# Reboot the system
systemctl reboot
