#!/bin/bash
set -euo pipefail

# K4All Auto-Join helper: if /etc/k4all-config.json contains a valid base64 kubeadm join
# command under the root key "autoJoin", attempt to join the node to the cluster.

DONE_FILE="/opt/k4all/auto-join.done"

if [ -f "$DONE_FILE" ]; then
  echo "CNI setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

log() {
  echo "[auto-join] $*"
}

if [ -f "$DONE_FILE" ]; then
  log "Already completed previously. Exiting."
  exit 0
fi

# If kubelet/admin configs exist, assume already joined
if [ -f "/etc/kubernetes/kubelet.conf" ] || [ -f "/etc/kubernetes/admin.conf" ]; then
  log "Kubernetes config present; assuming already joined."
  touch "$DONE_FILE"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  log "jq not installed; cannot read config. Exiting."
  exit 0
fi

if [ ! -f "/etc/k4all-config.json" ]; then
  log "Config file /etc/k4all-config.json not found; skipping."
  exit 0
fi

AUTOJOIN="$(jq -r '.autoJoin // ""' /etc/k4all-config.json 2>/dev/null || echo "")"
if [ -z "$AUTOJOIN" ] || [ "$AUTOJOIN" = "null" ]; then
  log "No autoJoin configured; skipping."
  exit 0
fi

# Validate base64 and ensure it decodes to a kubeadm join command
DECODED=""
if ! DECODED=$(printf "%s" "$AUTOJOIN" | base64 -d 2>/dev/null); then
  log "autoJoin is not valid base64; skipping."
  exit 0
fi

if ! printf "%s\n" "$DECODED" | grep -q '^kubeadm join '; then
  log "Decoded autoJoin does not start with 'kubeadm join'; skipping."
  exit 0
fi
if ! printf "%s\n" "$DECODED" | grep -q ' --token [A-Za-z0-9]\+\.[A-Za-z0-9]\+'; then
  log "Join token missing or malformed; skipping."
  exit 0
fi
if ! printf "%s\n" "$DECODED" | grep -q ' --discovery-token-ca-cert-hash sha256:[0-9A-Fa-f]\{64\}'; then
  log "Discovery token CA cert hash missing or malformed; skipping."
  exit 0
fi

# Execute node-type specific join wrapper installed at /usr/local/bin/join_cluster.sh
if [ ! -x "/usr/local/bin/join_cluster.sh" ]; then
  log "/usr/local/bin/join_cluster.sh not found; cannot join."
  exit 0
fi

log "Attempting to join cluster..."
# Retry join a few times in case the control plane isn't ready yet
if retry_command "/usr/local/bin/join_cluster.sh '$AUTOJOIN'" 5 15; then
  log "Join successful."
  touch "$DONE_FILE"
  exit 0
else
  log "Join failed."
  exit 1
fi

# this part should never be reached but, you never know...
touch /opt/k4all/auto-join.done
