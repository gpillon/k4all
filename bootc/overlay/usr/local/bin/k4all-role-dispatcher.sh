#!/bin/bash
# K4All Role Dispatcher
# Copies role-specific scripts to /var/opt/k4all/bin/ (writable under bootc composefs)
# based on the node type defined in /etc/node-type.
#
# First boot: copies the role's scripts and kubeadm config, enables the role's
# services.
# Every later boot: when the image brings different override scripts (after a
# bootc switch), refreshes the scripts in /var/opt/k4all/bin. Scripts there come
# first in PATH, so without the refresh a node would keep running the scripts
# of the image it was installed with. /etc/k8s-config.yaml is never refreshed:
# it is edited in place after install (certSANs, endpoints).

set -euo pipefail

DONE_FILE="/opt/k4all/role-dispatcher.done"
STAMP_FILE="/var/opt/k4all/role-dispatcher.overrides.sha256"
K4ALL_BIN="/var/opt/k4all/bin"
NODE_TYPE_FILE="/etc/node-type"
OVERRIDES_BASE="${OVERRIDES_BASE:-/usr/local/bin/overrides}"

if [ ! -f "$NODE_TYPE_FILE" ]; then
    echo "ERROR: $NODE_TYPE_FILE not found. Cannot determine node role."
    exit 1
fi

NODE_TYPE=$(tr -d '[:space:]' < "$NODE_TYPE_FILE")
echo "Node type: $NODE_TYPE"

case "$NODE_TYPE" in
    bootstrap) ROLE_DIRS="bootstrap bootstrap-control" ;;
    control)   ROLE_DIRS="control bootstrap-control control-worker" ;;
    worker)    ROLE_DIRS="worker control-worker" ;;
    *)
        echo "WARNING: Unknown node type '$NODE_TYPE'. No role-specific overrides applied."
        ROLE_DIRS=""
        ;;
esac

overrides_digest() {
    local dir
    for dir in $ROLE_DIRS; do
        [ -d "$OVERRIDES_BASE/$dir" ] || continue
        find "$OVERRIDES_BASE/$dir" -maxdepth 1 -type f -print0 | sort -z \
            | xargs -0 -r sha256sum
    done | sha256sum | cut -d' ' -f1
}

# copy_overrides <dir> <scripts|all>
# Scripts go to /var/opt/k4all/bin/; with "all", config files
# (k8s-config-*.yaml) also go to /etc/k8s-config.yaml.
copy_overrides() {
    local src_dir="$1" mode="$2" file base
    [ -d "$src_dir" ] || return 0
    echo "Copying overrides from $src_dir ($mode)..."
    for file in "$src_dir"/*; do
        [ -f "$file" ] || continue
        base=$(basename "$file")
        if [[ "$base" == k8s-config-*.yaml ]]; then
            if [ "$mode" = "all" ]; then
                cp -f "$file" /etc/k8s-config.yaml
                echo "  - $base → /etc/k8s-config.yaml"
            fi
        else
            cp -f "$file" "$K4ALL_BIN/"
            chmod +x "$K4ALL_BIN/$base"
            echo "  - $base → $K4ALL_BIN/$base"
        fi
    done
}

mkdir -p "$K4ALL_BIN" /opt/k4all
DIGEST=$(overrides_digest)

if [ -f "$DONE_FILE" ]; then
    if [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$DIGEST" ]; then
        echo "Role dispatcher already completed; overrides unchanged."
        exit 0
    fi
    echo "The image brings new $NODE_TYPE overrides: refreshing scripts."
    for dir in $ROLE_DIRS; do
        copy_overrides "$OVERRIDES_BASE/$dir" scripts
    done
    echo "$DIGEST" > "$STAMP_FILE"
    exit 0
fi

for dir in $ROLE_DIRS; do
    copy_overrides "$OVERRIDES_BASE/$dir" all
done

case "$NODE_TYPE" in
    bootstrap)
        systemctl enable fck8s-taint-master-schedulable.service
        systemctl enable fck8s-node-ready-and-schedulable.service
        systemctl enable fck8s-operator-deploy.service
        systemctl enable fck8s-update-routes.timer
        ;;
    control)
        systemctl enable fck8s-taint-master-schedulable.service
        systemctl enable fck8s-node-ready-and-schedulable.service
        systemctl enable fck8s-auto-join.service
        ;;
    worker)
        systemctl enable fck8s-auto-join.service
        ;;
esac

echo "$DIGEST" > "$STAMP_FILE"
touch "$DONE_FILE"
echo "Role dispatcher completed for node type: $NODE_TYPE"
