#!/bin/bash
set -euo pipefail

# Function to display the help message
show_help() {
  echo "Usage: $0 [OPTIONS]"
  echo
  echo "This script makes first-boot steps run again by removing their done files, then reboots."
  echo
  echo "Options:"
  echo "  --network       Delete the files related to network configuration."
  echo "  --kubernetes    Refused on k4all 2.x: it cannot reinstall Kubernetes (issue #68)."
  echo "  --hostname      Delete the files related to Hostname (a node in a cluster keeps its name)."
  echo "  --no-base       Skip Base Reinstallation (the first-boot checks that are safe to repeat)."
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

# On 2.x phase 3 never resets a node that holds a cluster (admin.conf, etcd
# data, restore.done, the last one on every 2.x node): kubeadm init would
# run over the running control plane of a bootstrap node, and a control
# plane or a worker would stay as it is. Refused before anything changes.
if [ "$kubernetes_flag" = true ]; then
  cat >&2 <<'EOF'
reinstall.sh --kubernetes does not work on k4all 2.x: nothing was changed.

k4all 2.x never resets the Kubernetes state of a node that holds a cluster,
so a bootstrap node would run kubeadm init over its running control plane
and a control plane or a worker would stay as it is.

Instead:
  - to rebuild a node with its cluster: k4all-backup.sh, then reinstall it
    from the k4all ISO and choose the installer's Restore;
  - to take a control plane or a worker out and join it again: drain it and
    delete its Node from another control plane, run `kubeadm reset` on it,
    then reinstall it from the ISO, or join it again with a new join
    command (generate_join.sh on the bootstrap node).

See https://github.com/gpillon/k4all/issues/68
EOF
  exit 1
fi

# Ask for confirmation before proceeding
ask_for_confirmation

# K4ALL_ROOT: the tests run the script against a fake root.
DONE_DIR="${K4ALL_ROOT:-}/opt/k4all"

# The base reinstall runs again only the first-boot checks that are safe to
# repeat on a node in a cluster (#68): the configuration files, the vg_data
# check, the auto-join check. Not, among others:
# - restore: the next boot would restore the newest backup kept on the node
#   (k4all-backup.sh writes to /var/opt/k4all/backups by default) over its
#   PKI, configuration and, on the bootstrap node, etcd;
# - operator-deployed: deploy-operator.sh would re-apply /etc/k4all-config.yaml
#   and /etc/k4all-release.yaml over the cluster's ClusterConfig and
#   ReleaseManifest;
# - role-dispatcher: it would copy the kubeadm template over /etc/k8s-config.yaml,
#   which holds the node's endpoint, certSANs and networks (backups and
#   enable-cluster.sh read it);
# - setup-taint-master-schedulable: it would remove a control-plane taint
#   set since the install.
BASE_STEPS="first-boot.done lvm-setup.done auto-join.done"
if [ "$base" = true ]; then
  for step in $BASE_STEPS; do
    delete_file "$DONE_DIR/$step"
  done
fi

# Delete specific files based on flags
if [ "$network_flag" = true ]; then
  delete_file "$DONE_DIR/setup-ph2.done"
  delete_file "$DONE_DIR/setup-ph3.done"
  delete_file "$DONE_DIR/setup-proxy.done"
fi

if [ "$hostname_flag" = true ]; then
  delete_file "$DONE_DIR/setup-hostname.done"
fi

# Reboot the system
systemctl reboot
