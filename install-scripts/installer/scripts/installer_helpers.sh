#!/bin/bash

set -euo pipefail

ih_run_remote_join() {
  # args: user, password, host
  local user="$1"
  local host="$2"
  local node_type=$(logic_detect_node_type || echo "unknown")
  
  # Try running remote generator in unattended mode first; fall back to debug on failure
  local ssh_opts="-o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  local remote_output=""
  if remote_output=$(ssh ${ssh_opts} "${user}@${host}" "/usr/local/bin/generate_join.sh ${node_type} --unattended"); then
    :
  else
    remote_output=$(ssh ${ssh_opts} "${user}@${host}" "/usr/local/bin/generate_join.sh ${node_type} --debug" || true)
  fi

  # Extract the first "kubeadm join ..." line (robust to prefixes/whitespace)
  local join_line
  join_line=$(printf "%s\n" "$remote_output" | sed -n 's/.*\(kubeadm join[^\r\n]*\).*/\1/p' | head -n1)
  # Trim leading/trailing whitespace
  join_line=$(printf "%s" "$join_line" | sed 's/^[[:space:]]\+//; s/[[:space:]]\+$//')

  # Base64-encode whatever we extracted; validation happens in ih_validate_join_b64
  local joins_string=""
  if [[ -n "$join_line" ]]; then
    joins_string=$(printf "%s" "$join_line" | base64 -w0)
  fi

  echo "$joins_string"
}

# Validate a base64-encoded kubeadm join command
# Usage: ih_validate_join_b64 "BASE64_STRING"
# Returns: 0 if valid, 1 otherwise. No output on success.
ih_validate_join_b64() {
  local b64="$1"
  if [ -z "$b64" ]; then
    return 1
  fi

  local decoded
  if ! decoded=$(printf "%s" "$b64" | base64 -d 2>/dev/null); then
    return 1
  fi

  # Use basic, robust checks to avoid false negatives across grep variants
  # 1) Must start with 'kubeadm join '
  if ! printf "%s\n" "$decoded" | grep -q '^kubeadm join '; then
    return 1
  fi
  # 2) Must contain a token with dot-separated parts (alnum only)
  if ! printf "%s\n" "$decoded" | grep -q ' --token [A-Za-z0-9]\+\.[A-Za-z0-9]\+'; then
    return 1
  fi
  # 3) Must contain a sha256 hash of 64 hex chars
  if ! printf "%s\n" "$decoded" | grep -q ' --discovery-token-ca-cert-hash sha256:[0-9A-Fa-f]\{64\}'; then
    return 1
  fi
  return 0
}


