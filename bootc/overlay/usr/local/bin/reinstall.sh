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
    rm -f "$file_to_del"
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

# K4ALL_ROOT: the tests run the script against a fake root.
DONE_DIR="${K4ALL_ROOT:-}/opt/k4all"

# Delete all other *.done files except the ones specifically handled by flags,
# and restore.done: without it the next boot restores the newest backup found
# on the node (k4all-backup.sh writes to /var/opt/k4all/backups by default)
# over its PKI, configuration and, on the bootstrap node, etcd.
if [ "$base" = true ]; then
  for file in "$DONE_DIR"/*.done; do
    [ -e "$file" ] || continue
    case "$(basename "$file")" in
      setup-ph3.done|setup-ph2.done|k8s-setup-init.done|setup-hostname.done|setup-ph3-reset-kube.done|setup-proxy.done|restore.done) ;;
      *) delete_file "$file" ;;
    esac
  done
fi

# Delete specific files based on flags
if [ "$network_flag" = true ]; then
  delete_file "$DONE_DIR/setup-ph2.done"
  delete_file "$DONE_DIR/setup-ph3.done"
  delete_file "$DONE_DIR/setup-proxy.done"
fi

if [ "$kubernetes_flag" = true ]; then
  delete_file "$DONE_DIR/k8s-setup-init.done"
  delete_file "$DONE_DIR/setup-ph3-reset-kube.done"
fi

if [ "$hostname_flag" = true ]; then
  delete_file "$DONE_DIR/setup-hostname.done"
fi

# Reboot the system
systemctl reboot
