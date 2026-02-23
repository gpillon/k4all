#!/bin/bash

set -euo pipefail

DEFAULT_CONFIG_FILE=${DEFAULT_CONFIG_FILE:-/usr/local/share/default-cluster-config.json}
TEMP_CONFIG_FILE=${TEMP_CONFIG_FILE:-/tmp/temp-k4all-config.json}
TEMP_STRIPPED_CONFIG_FILE=${TEMP_STRIPPED_CONFIG_FILE:-/tmp/temp-stripped-k4all-config.json}
VALIDATE_SCRIPT=${VALIDATE_SCRIPT:-/usr/local/bin/validate_config.sh}
CONFIG_FILE=${CONFIG_FILE:-/etc/k4all-config.json}
TIMEOUT_SECONDS=${WHIPTAIL_TIMEOUT_SECONDS:-${TIMEOUT:-10}}
SKIP_TIMEOUT=${SKIP_TIMEOUT:-false}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$SCRIPT_DIR/ui.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/logic.sh"
# shellcheck source=/dev/null

if [ -d "$SCRIPT_DIR/scripts" ]; then
  shopt -s nullglob
  for script in "$SCRIPT_DIR"/scripts/*.sh; do
    source "$script"
  done
  shopt -u nullglob
fi

interactive_flow() {
  local choice
  while true; do
    local node_type
    node_type=$(logic_detect_node_type || echo "unknown")
    ui_title "K4All Installer - Main Menu (${node_type})"
    local out
    if [ "$node_type" = "bootstrap" ]; then
      out=$(ui_prompt_menu "" 1 0 \
        "Networking" \
        "Cluster" \
        "Features" \
        "Proxy" \
        "Disk" \
        "Print current configuration" \
        "Validate & Save" \
        "Exit")
    else
      out=$(ui_prompt_menu "" 1 0 \
        "Networking" \
        "Features" \
        "Proxy" \
        "Disk" \
        "Auto join cluster" \
        "Print current configuration" \
        "Validate & Save" \
        "Exit")
    fi
    choice="${out#*:}"
    case "$choice" in
      Networking)
        menu_networking
        ;;
      Cluster)
        menu_cluster
        ;;
      Features)
        menu_features
        ;;
      Proxy)
        menu_proxy
        ;;
      "Auto join cluster")
        menu_auto_join
        ;;
      "Print current configuration")
        menu_print_config
        ;;
      Disk)
        menu_disk
        ;;
      "Validate & Save")
        if logic_validate; then
          ui_title "Validation"
          ui_msg "Configuration is valid."
          jq -r 'paths(scalars) as $p | [($p | join(".")), (getpath($p))] | "\"\(.[0])\" = \(.[1])"' "$TEMP_CONFIG_FILE" || true
          ui_pause
          return 0
        else
          ui_title "Validation"
          ui_msg "Configuration invalid. Please fix settings."
          jq -r 'paths(scalars) as $p | [($p | join(".")), (getpath($p))] | "\"\(.[0])\" = \(.[1])"' "$TEMP_CONFIG_FILE" || true
          ui_pause
        fi
        ;;
      Exit)
        return 1
        ;;
    esac
  done
}

menu_networking() {
  local iface ipmode
  ui_title "Network Configuration"
  local ifaces
  ifaces=$(logic_detect_ifaces)
  if [ -z "$ifaces" ]; then ifaces="eth0"; fi
  IFS=$'\n' read -r -d '' -a arr_ifaces < <(printf "%s\n" $ifaces && printf '\0')
  local current_iface
  current_iface=$(logic_get_json '.networking.iface.dev // "auto"')
  local opts=("auto")
  for i in "${arr_ifaces[@]}"; do
    [ "$i" = "auto" ] && continue
    opts+=("$i")
  done
  iface=$(ui_choice "Select primary network interface" "$current_iface" "${opts[@]}")
  [ -n "$iface" ] && logic_set_json '.networking.iface.dev=$v' "$iface"

  ui_title "IP Mode"
  local ipmenu
  ipmenu=$(ui_prompt_menu "IP configuration mode" 1 0 dhcp static)
  ipmode="${ipmenu#*:}"
  [ -n "$ipmode" ] && logic_set_json '.networking.iface.ipconfig=$v' "$ipmode"

  if [ "$ipmode" = "static" ]; then
    ui_title "Static IP"
    local ip subnet gw dns search
    ip=$(ui_prompt_input "Static IP (e.g. 192.168.1.10)" "" 0)
    subnet=$(ui_prompt_input "Subnet mask (e.g. 255.255.255.0)" "" 0)
    gw=$(ui_prompt_input "Gateway (e.g. 192.168.1.1)" "" 0)
    dns=$(ui_prompt_input "DNS (comma-separated)" "" 0)
    search=$(ui_prompt_input "DNS search domain" "" 0)
    [ -n "$ip" ] && logic_set_json '.networking.iface.ipaddr=$v' "$ip"
    [ -n "$subnet" ] && logic_set_json '.networking.iface.subnet_mask=$v' "$subnet"
    [ -n "$gw" ] && logic_set_json '.networking.iface.gateway=$v' "$gw"
    [ -n "$dns" ] && logic_set_json '.networking.iface.dns=$v' "$dns"
    [ -n "$search" ] && logic_set_json '.networking.iface.dns_search=$v' "$search"
  fi
}

menu_ha() {
  ui_title "High Availability"
  ui_msg "NOTE: keepalived is deprecated and will be probably  removed in the future. Use kubevip instead."
  local ha
  local out
  out=$(ui_prompt_menu "HA type" 1 0 none keepalived kubevip)
  ha="${out#*:}"
  [ -n "$ha" ] && logic_set_json '.cluster.ha.type=$v' "$ha"
  if [ "$ha" != "none" ]; then
    local vip iface subnet
    vip=$(ui_prompt_input "API endpoint VIP" "" 0)
    iface=$(ui_prompt_input "HA interface" "auto" 0)
    if [ "$ha" = "keepalived" ]; then
      subnet=$(ui_prompt_input "VIP subnet size (e.g. 24)" "24" 0)
      [ -n "$subnet" ] && logic_set_json '.cluster.ha.apiControlEndpointSubnetSize=$v' "$subnet"
    fi
    [ -n "$vip" ] && logic_set_json '.cluster.ha.apiControlEndpoint=$v' "$vip"
    [ -n "$iface" ] && logic_set_json '.cluster.ha.interface=$v' "$iface"
  fi
}

menu_cluster() {
  while true; do
    ui_title "K4All Installer - Cluster"
    local out
    out=$(ui_prompt_menu "Breadcrumb: Cluster" 1 0 \
      "API endpoint uses hostname" \
      "Custom API endpoint (hostname)" \
      "High Availability" \
      "Back")
    local choice="${out#*:}"
    case "$choice" in
      "API endpoint uses hostname")
        local current
        current=$(logic_get_json '.cluster.apiEndPointUseHostName // "true"')
        local sel
        sel=$(ui_choice "Choose: apiEndPointUseHostName" "$current" true false short)
        [ -n "$sel" ] && logic_set_json '.cluster.apiEndPointUseHostName=$v' "$sel"
        ;;
      "Custom API endpoint (hostname)")
        local host
        host=$(ui_prompt_input "Custom API endpoint hostname (leave blank to clear)" "" 0)
        logic_set_json '.cluster.customApiEndPoint=$v' "$host"
        ;;
      "High Availability")
        menu_ha
        ;;
      Back)
        return 0
        ;;
    esac
  done
}

menu_features() {
  while true; do
    ui_title "Features"
    local out
    out=$(ui_prompt_menu "Features" 1 0 \
      "Argo CD" \
      "Gateway API (Kong)" \
      "CNI" \
      "Virtualization" \
      "Firewall" \
      "Back")
    local choice="${out#*:}"
    case "$choice" in
      "Argo CD")
        if ui_prompt_yesno "Enable Argo CD?" yes 0; then
          logic_set_json '.features.argocd.enabled=$v' "true"
        else
          logic_set_json '.features.argocd.enabled=$v' "false"
        fi
        ;;
      "Gateway API (Kong)")
        if ui_prompt_yesno "Enable Gateway API (Kong)?" no 0; then
          logic_set_json '.features.gateway.enabled=$v' "true"
        else
          logic_set_json '.features.gateway.enabled=$v' "false"
        fi
        ;;
      "CNI")
        local current
        current=$(logic_get_json '.networking.cni.type // "calico"')
        local cni
        cni=$(ui_choice "Select CNI" "$current" calico cilium)
        [ -n "$cni" ] && logic_set_json '.networking.cni.type=$v' "$cni"
        ;;
      "Virtualization")
        if ui_prompt_yesno "Enable virtualization?" no 0; then
          logic_set_json '.features.virt.enabled=$v' "true"
        else
          logic_set_json '.features.virt.enabled=$v' "false"
        fi
        local emu_menu
        emu_menu=$(ui_prompt_menu "Emulation" 3 0 true false auto)
        local emu="${emu_menu#*:}"
        [ -n "$emu" ] && logic_set_json '.features.virt.emulation=$v' "$emu"
        ;;
      "Firewall")
        if ui_prompt_yesno "Enable firewalld?" no 0; then
          logic_set_json '.networking.firewalld.enabled=$v' "true"
        else
          logic_set_json '.networking.firewalld.enabled=$v' "false"
        fi
        ;;
      Back)
        return 0
        ;;
    esac
  done
}

menu_disk() {
  ui_title "Disk"
  local keep_lvm size_mib disk
  disk=$(ui_prompt_input "Install disk (e.g. /dev/sda)" "" 0)
  [ -n "$disk" ] && logic_set_json '.disk.root.disk=$v' "$disk"
  size_mib=$(ui_prompt_input "Root size (MiB or % e.g. 20000 or 20%)" "20%" 0)
  [ -n "$size_mib" ] && logic_set_json '.disk.root.size_mib=$v' "$size_mib"
  if ui_prompt_yesno "Keep existing LVM (true/false)?" no 0; then
    logic_set_json '.disk.keep_lvm=$v' "true"
  else
    logic_set_json '.disk.keep_lvm=$v' "false"
  fi
}

menu_proxy() {
  ui_title "Proxy"
  local http https np
  http=$(logic_get_json '.proxy.http_proxy // ""')
  https=$(logic_get_json '.proxy.https_proxy // ""')
  np=$(logic_get_json '.proxy.no_proxy // ""')
  http=$(ui_prompt_input "HTTP proxy (leave empty to clear)" "$http" 0)
  https=$(ui_prompt_input "HTTPS proxy (leave empty to clear)" "$https" 0)
  np=$(ui_prompt_input "NO_PROXY (comma-separated; leave empty to clear)" "$np" 0)
  logic_set_json '.proxy.http_proxy=$v' "$http"
  logic_set_json '.proxy.https_proxy=$v' "$https"
  logic_set_json '.proxy.no_proxy=$v' "$np"
}

menu_auto_join() {
  ui_title "Auto join cluster"
  ui_msg "NOTE: This will prompt for a remote SSH password; password could be asked 1 ore more times"
  local user host password
  user=$(ui_prompt_input "Remote SSH username" "core" 0)
  host=$(ui_prompt_input "Remote host/IP" "" 0)
  # password=$(ui_prompt_password "Remote SSH password")
  ui_msg "Running remote join..."
  joins_string=$(ih_run_remote_join "$user" "$host" || true)
  echo "$joins_string"
  if [ -z "$joins_string" ]; then
    ui_msg "No join data received."
    ui_pause
    return 0
  fi

  # Validate with helper and save if valid
  if ih_validate_join_b64 "$joins_string"; then
    logic_set_json '.autoJoin=$v' "$joins_string"
    ui_msg "Auto join saved to config at key: autoJoin"
  else
    ui_msg "Join string invalid; not saving."
  fi
  ui_pause
}

menu_print_config() {
  ui_title "Current configuration"
  if [ -f "$TEMP_CONFIG_FILE" ]; then
    jq -r 'paths(scalars) as $p | [($p | join(".")), (getpath($p))] | "\"\(.[0])\" = \(.[1])"' "$TEMP_CONFIG_FILE" || true
  else
    ui_msg "No current configuration found (missing $TEMP_CONFIG_FILE)."
  fi
  ui_pause
}

main() {
  ui_init
  trap ui_end EXIT

  logic_copy_default

  if ! logic_check_deps; then
    ui_title "Missing dependencies"
    ui_msg "Required tools are missing (jq). Please install them in the environment."
    ui_pause
    exit 1
  fi

  if [[  "$SKIP_TIMEOUT" == "true" ]] || ui_timed_interactive_prompt "$TIMEOUT_SECONDS"; then
    local node_type
    node_type=$(logic_detect_node_type || echo "unknown")
    ui_title "Node: ${node_type} - K4All Installer"
    ui_msg "Entering interactive setup..."
    # ui_pause
    # echo "Interactive mode selected."
    interactive_flow || true
  fi

  if ! logic_validate; then
    # If interactive mode was not chosen, just exit non-zero (k4all-config.sh will handle)
    # If user chose interactive, loop until valid
    if ui_prompt_yesno "Configuration invalid. Edit again?" yes 0; then
      while ! logic_validate; do
        interactive_flow || true
      done
    else
      exit 1
    fi
  fi
}

main "$@"


