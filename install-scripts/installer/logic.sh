#!/bin/bash

set -euo pipefail

DEFAULT_CONFIG_FILE=${DEFAULT_CONFIG_FILE:-/usr/local/share/default-cluster-config.json}
TEMP_CONFIG_FILE=${TEMP_CONFIG_FILE:-/tmp/temp-k4all-config.json}
TEMP_STRIPPED_CONFIG_FILE=${TEMP_STRIPPED_CONFIG_FILE:-/tmp/temp-stripped-k4all-config.json}
VALIDATE_SCRIPT=${VALIDATE_SCRIPT:-/usr/local/bin/validate_config.sh}

logic_check_deps() {
  local missing=0
  if ! command -v jq >/dev/null 2>&1; then
    echo "Missing dependency: jq"
    missing=1
  fi
  # tput is optional; UI works without it
  return $missing
}

logic_copy_default() {
  # Copy default config and remove lines that start with '//' so jq can edit it
  sed '/^\s*\/\//d' "$DEFAULT_CONFIG_FILE" > "$TEMP_CONFIG_FILE"
}

logic_strip_comments() {
  sh -c 'sed "/^\s*\/\//d" '"$TEMP_CONFIG_FILE"' > '"$TEMP_STRIPPED_CONFIG_FILE"''
}

logic_validate() {
  logic_strip_comments
  bash "$VALIDATE_SCRIPT" "$TEMP_STRIPPED_CONFIG_FILE" 1>&2
}

logic_detect_ifaces() {
  ls /sys/class/net | grep -Ev 'lo|virbr|docker|veth|cni|flannel' || true
}

logic_detect_disks() {
  lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT | grep ' disk' | awk '{print $1 "(" $2 ")"}' | tr '\n' ' ' || true
}

logic_set_json() {
  local jq_expr="$1"
  local value="$2"
  jq --arg v "$value" "$jq_expr" "$TEMP_CONFIG_FILE" > "$TEMP_CONFIG_FILE.tmp" && mv "$TEMP_CONFIG_FILE.tmp" "$TEMP_CONFIG_FILE"
}

logic_get_json() {
  local jq_expr="$1"
  jq -r "$jq_expr" "$TEMP_CONFIG_FILE"
}

logic_menu_networking() {
  # Prepare defaults
  local dev
  dev=$(logic_get_json '.networking.iface.dev // ""')
  local mode
  mode=$(logic_get_json '.networking.iface.ipconfig // "dhcp"')

  echo "dev=$dev"
  echo "mode=$mode"
}

logic_menu_features() {
  local argocd
  argocd=$(logic_get_json '.features.argocd.enabled // "false"')
  echo "argocd=$argocd"
  local gateway
  gateway=$(logic_get_json '.features.gateway.enabled // "false"')
  echo "gateway=$gateway"
}

logic_detect_node_type() {
  # Try known ignition paths
  local ign
  for p in /usr/local/bin/k8s.ign /usr/local/bon/k8s.ign; do
    if [ -f "$p" ]; then ign="$p"; break; fi
  done

  # Fallback to marker file
  if [ -z "${ign:-}" ]; then
    if [ -f /etc/node-type ]; then
      cat /etc/node-type
      return 0
    fi
    echo "unknown"
    return 0
  fi

  # Ensure ignition key exists
  if ! jq -e '.ignition' "$ign" >/dev/null 2>&1; then
    echo "unknown"
    return 0
  fi

  # Extract data URL for /etc/node-type
  local src
  src=$(jq -r '.storage.files[]? | select(.path=="/etc/node-type") | .contents.source // empty' "$ign" 2>/dev/null || true)
  if [ -z "$src" ]; then
    echo "unknown"
    return 0
  fi

  # Parse data URL
  local payload
  payload="${src#*,}"
  if echo "$src" | grep -q ';base64,'; then
    echo "$payload" | base64 -d 2>/dev/null || true
  else
    printf '%b' "${payload//%/\\x}"
  fi
}

