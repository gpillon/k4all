#!/bin/bash
# K4All - Set Hostname: the node is named kube-<node type>-<5 random
# characters>, plus the DNS domain of its network when the network gives one
# (DHCP).
#
# The name is final once setup-hostname.done is written: kubeadm registers
# the node under it. A first boot without network (no DHCP lease yet, the
# cable unplugged, the VLAN not passed) must not fix a name without the
# domain, so the node is named for good only once it has a network. Until
# then it waits here, as long as it takes, under the name without the
# domain. The first-boot steps after this one wait with it (they are ordered
# after fck8s-set-hostname.service), and the setup goes on in the same boot
# as soon as the network is there.

# Enable strict mode and pipefail for robust error handling
set -euo pipefail

# K4ALL_ROOT: the tests run the script against a fake root.
ROOT="${K4ALL_ROOT:-}"
DONE_FILE="$ROOT/opt/k4all/setup-hostname.done"
# The name without the domain while the node waits for its network: every
# try, and a reboot in between, keeps the same random characters.
BASE_FILE="$ROOT/opt/k4all/setup-hostname.base"
NODE_TYPE_FILE="$ROOT/etc/node-type"

if [ -f "$DONE_FILE" ]; then
  echo "Hostname setup already done. Exiting."
  exit 0
fi

source "$ROOT/usr/local/bin/k4all-utils"

# A node that is already in a cluster is registered under its current name:
# renaming it would break its kubelet. It keeps the name.
if [ -f "$ROOT/etc/kubernetes/kubelet.conf" ] || [ -f "$ROOT/etc/kubernetes/admin.conf" ]; then
  echo "This node is already in a cluster as $(hostname): it keeps its name."
  touch "$DONE_FILE"
  exit 0
fi

# Function to generate random suffix
generate_random_suffix() {
    echo "$(openssl rand -base64 64 | tr -dc 'a-z0-9' | head -c 5)"
}

# Function to check for node type and adjust hostname accordingly
set_static_hostname() {
    local node_type_suffix="unknown" # Default value if file does not exist or is empty

    if [ -f "$NODE_TYPE_FILE" ]; then
        # Read content, trim spaces/newlines, and append
        # shellcheck disable=SC2155 # kept: split, a failure here would stop set -e callers
        local content=$(cat "$NODE_TYPE_FILE" | tr -d ' \n')
        if [[ -n "$content" ]]; then
            node_type_suffix="$content"
        fi
    fi

    echo "kube-$node_type_suffix-$(generate_random_suffix)"
}

# The name without the domain: the one kept from an earlier try, or a new one.
STATIC_HOSTNAME=""
if [ -f "$BASE_FILE" ]; then
    STATIC_HOSTNAME=$(tr -d '[:space:]' < "$BASE_FILE")
fi
if [ -z "$STATIC_HOSTNAME" ]; then
    STATIC_HOSTNAME=$(set_static_hostname)
    echo "$STATIC_HOSTNAME" > "$BASE_FILE"
fi

# No network yet: the node takes the name without the domain meanwhile, and
# waits for the network to learn the domain.
if ! node_has_network; then
    hostnamectl set-hostname "$STATIC_HOSTNAME"
    echo "Hostname set to $STATIC_HOSTNAME until the node has a network"
    wait_for_node_network "naming the node"
fi

# The DNS domain of the network (DHCP), from systemd-resolved
function get_domain() {
    local domain=""
    local retry_count=0
    local max_retries="${K4ALL_DOMAIN_TRIES:-5}"
    local sleep_interval="${K4ALL_DOMAIN_SLEEP:-5}"  # Wait time between retries in seconds

    while [[ $retry_count -lt $max_retries ]]; do
        # The first domain only: with two links on DHCP every link lists
        # it, and a name with a newline in it is refused by hostnamectl.
        domain=$(systemd-resolve --status 2>/dev/null | grep "DNS Domain:" | awk '{print $3}' | head -n 1 || echo "")

        if [[ -n "$domain" ]]; then
            echo "$domain"
            return
        fi

        retry_count=$((retry_count + 1))
        if [[ $retry_count -lt $max_retries ]]; then
            echo "DNS domain not found, retrying in $sleep_interval seconds..." 1>&2
            sleep "$sleep_interval"
        fi
    done
}

# Attempt to retrieve the domain part from DHCP
DOMAIN=$(get_domain)

# Determine the full hostname
if [[ -z "$DOMAIN" ]]; then
    echo "The network gives no DNS domain: the name has none."
    FULL_HOSTNAME="$STATIC_HOSTNAME"
else
    FULL_HOSTNAME="$STATIC_HOSTNAME.$DOMAIN"
fi

# Set the hostname using the hostnamectl command
hostnamectl set-hostname "$FULL_HOSTNAME"

echo "Hostname set to $FULL_HOSTNAME"
touch "$DONE_FILE"
rm -f "$BASE_FILE"
