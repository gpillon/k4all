#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/setup-proxy.done" ]; then
  echo "Proxy setup already done. Exiting."
  exit 0
fi

source /usr/local/bin/k4all-utils

# Shared constants
CONF_DIR="/etc/systemd/system.conf.d"
CONF_FILE="$CONF_DIR/proxy.conf"

# Ensure proxy.conf exists and has a [Manager] section
function ensure_proxy_conf_ready() {
    mkdir -p "$CONF_DIR"
    touch "$CONF_FILE"

    if ! grep -q '^\[Manager\]' "$CONF_FILE"; then
        tmp_file=$(mktemp)
        {
            echo "[Manager]"
            cat "$CONF_FILE"
        } > "$tmp_file"
        mv "$tmp_file" "$CONF_FILE"
    fi
}

# Upsert a DefaultEnvironment line for a given VAR to the given VALUE
function upsert_default_env() {
    local var_name="$1"
    local var_value="$2"

    if grep -qE "^DefaultEnvironment=\"${var_name}=" "$CONF_FILE"; then
        awk -v vname="$var_name" -v vval="$var_value" '
            $0 ~ "^DefaultEnvironment=\"" vname "=" {
                print "DefaultEnvironment=\"" vname "=" vval "\""
                next
            }
            { print }
        ' "$CONF_FILE" > "$CONF_FILE.tmp" && mv "$CONF_FILE.tmp" "$CONF_FILE"
    else
        echo "DefaultEnvironment=\"${var_name}=${var_value}\"" >> "$CONF_FILE"
    fi
}

function set_proxy_if_present() {
    local var_name="$1"
    local yaml_path="$2"

    local value
    value=$(yq e "$yaml_path" "$K4ALL_CONFIG_FILE")
    if [ -n "$value" ] && [ "$value" != "null" ] && [ "$value" != '""' ]; then
        ensure_proxy_conf_ready
        upsert_default_env "$var_name" "$value"
    else
        if [ -f "$CONF_FILE" ]; then
            sed -i "/^DefaultEnvironment=\"${var_name}=/d" "$CONF_FILE"
        fi
    fi
}


function setup_proxy() {
    set_proxy_if_present "HTTP_PROXY" '.spec.proxy.httpProxy'
    set_proxy_if_present "http_proxy" '.spec.proxy.httpProxy'
    echo "Success: Setup HTTP Proxy"
    set_proxy_if_present "HTTPS_PROXY" '.spec.proxy.httpsProxy'
    set_proxy_if_present "https_proxy" '.spec.proxy.httpsProxy'
    echo "Success: Setup HTTPS Proxy"
    set_proxy_if_present "NO_PROXY" '.spec.proxy.noProxy'
    set_proxy_if_present "no_proxy" '.spec.proxy.noProxy'
    echo "Success: Setup No Proxy"
    systemctl daemon-reload
    systemctl restart systemd-resolved
    systemctl restart NetworkManager
}

if [ ! -f "$K4ALL_CONFIG_FILE" ]; then
    echo "Warning: config file not found, skipping proxy setup"
    touch /opt/k4all/setup-proxy.done
    exit 0
fi

setup_proxy

touch /opt/k4all/setup-proxy.done