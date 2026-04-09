#!/bin/bash
# K4All Role Dispatcher
# Copies role-specific scripts to /var/opt/k4all/bin/ (writable under bootc composefs)
# based on the node type defined in /etc/node-type

set -euo pipefail

DONE_FILE="/opt/k4all/role-dispatcher.done"
K4ALL_BIN="/var/opt/k4all/bin"

if [ -f "$DONE_FILE" ]; then
    echo "Role dispatcher already completed."
    exit 0
fi

NODE_TYPE_FILE="/etc/node-type"
OVERRIDES_BASE="/usr/local/bin/overrides"

if [ ! -f "$NODE_TYPE_FILE" ]; then
    echo "ERROR: $NODE_TYPE_FILE not found. Cannot determine node role."
    exit 1
fi

NODE_TYPE=$(cat "$NODE_TYPE_FILE" | tr -d '[:space:]')
echo "Node type: $NODE_TYPE"

mkdir -p "$K4ALL_BIN"

# Scripts go to /var/opt/k4all/bin/, config files (k8s-config-*.yaml) go to /etc/k8s-config.yaml
copy_overrides() {
    local src_dir="$1"
    if [ -d "$src_dir" ]; then
        echo "Copying overrides from $src_dir..."
        for file in "$src_dir"/*; do
            if [ -f "$file" ]; then
                local base
                base=$(basename "$file")
                if [[ "$base" == k8s-config-*.yaml ]]; then
                    cp -f "$file" /etc/k8s-config.yaml
                    echo "  - $base → /etc/k8s-config.yaml"
                else
                    cp -f "$file" "$K4ALL_BIN/"
                    chmod +x "$K4ALL_BIN/$base"
                    echo "  - $base → $K4ALL_BIN/$base"
                fi
            fi
        done
    fi
}

case "$NODE_TYPE" in
    bootstrap)
        # Bootstrap node: needs bootstrap + bootstrap-control overrides
        copy_overrides "$OVERRIDES_BASE/bootstrap"
        copy_overrides "$OVERRIDES_BASE/bootstrap-control"
        systemctl enable --now fck8s-operator-deploy.service
        systemctl enable --now fck8s-node-ready-and-schedulable.service
        systemctl enable --now fck8s-taint-master-schedulable.service
        systemctl enable --now fck8s-update-routes.timer
        ;;
    control)
        # Control plane node: needs control + bootstrap-control + control-worker overrides
        copy_overrides "$OVERRIDES_BASE/control"
        copy_overrides "$OVERRIDES_BASE/bootstrap-control"
        copy_overrides "$OVERRIDES_BASE/control-worker"
        systemctl enable --now fck8s-operator-deploy.service
        systemctl enable --now fck8s-node-ready-and-schedulable.service
        systemctl enable --now fck8s-taint-master-schedulable.service
        ;;
    worker)
        # Worker node: needs worker + control-worker overrides
        copy_overrides "$OVERRIDES_BASE/worker"
        copy_overrides "$OVERRIDES_BASE/control-worker"
        systemctl enable --now fck8s-operator-deploy.service
        ;;
    *)
        echo "WARNING: Unknown node type '$NODE_TYPE'. No role-specific overrides applied."
        ;;
esac

# Mark as done
mkdir -p /opt/k4all
touch "$DONE_FILE"
echo "Role dispatcher completed for node type: $NODE_TYPE"

