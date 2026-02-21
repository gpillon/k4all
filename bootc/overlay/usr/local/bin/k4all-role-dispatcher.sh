#!/bin/bash
# K4All Role Dispatcher
# Copies the correct role-specific scripts from /usr/local/bin/overrides/ to /usr/local/bin/
# based on the node type defined in /etc/node-type

set -euo pipefail

DONE_FILE="/opt/k4all/role-dispatcher.done"

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

# Function to copy overrides from a directory
copy_overrides() {
    local src_dir="$1"
    if [ -d "$src_dir" ]; then
        echo "Copying overrides from $src_dir..."
        for file in "$src_dir"/*; do
            if [ -f "$file" ]; then
                cp -f "$file" /usr/local/bin/
                chmod +x "/usr/local/bin/$(basename "$file")"
                echo "  - $(basename "$file")"
            fi
        done
    fi
}

case "$NODE_TYPE" in
    bootstrap)
        # Bootstrap node: needs bootstrap + bootstrap-control overrides
        copy_overrides "$OVERRIDES_BASE/bootstrap"
        copy_overrides "$OVERRIDES_BASE/bootstrap-control"
        ;;
    control)
        # Control plane node: needs control + bootstrap-control + control-worker overrides
        copy_overrides "$OVERRIDES_BASE/control"
        copy_overrides "$OVERRIDES_BASE/bootstrap-control"
        copy_overrides "$OVERRIDES_BASE/control-worker"
        ;;
    worker)
        # Worker node: needs worker + control-worker overrides
        copy_overrides "$OVERRIDES_BASE/worker"
        copy_overrides "$OVERRIDES_BASE/control-worker"
        ;;
    *)
        echo "WARNING: Unknown node type '$NODE_TYPE'. No role-specific overrides applied."
        ;;
esac

# Mark as done
mkdir -p /opt/k4all
touch "$DONE_FILE"
echo "Role dispatcher completed for node type: $NODE_TYPE"

