#!/bin/bash
# K4All Node Update Script (bootc version)
# Updates the node to the latest K4All bootc image
set -euo pipefail

# Default image (can be overridden)
DEFAULT_IMAGE="ghcr.io/gpillon/k4all-bootc"
IMAGE_TAG="${1:-latest}"

# Full image reference
IMAGE="${K4ALL_IMAGE:-$DEFAULT_IMAGE}:$IMAGE_TAG"

CONFIG_FILE="/etc/k4all-config.json"
BACKUP_DIR="/opt/k4all/config-backups"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[K4All]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[K4All WARN]${NC} $1"
}

error() {
    echo -e "${RED}[K4All ERROR]${NC} $1" >&2
}

# Check if version $1 is less than version $2
version_lt() {
    local IFS=.
    local i ver1=($1) ver2=($2)

    for ((i=${#ver1[@]}; i<${#ver2[@]}; i++)); do
        ver1[i]=0
    done
    for ((i=${#ver2[@]}; i<${#ver1[@]}; i++)); do
        ver2[i]=0
    done

    for ((i=0; i<${#ver1[@]}; i++)); do
        if ((10#${ver1[i]} < 10#${ver2[i]})); then
            return 0
        elif ((10#${ver1[i]} > 10#${ver2[i]})); then
            return 1
        fi
    done
    return 1
}

# Check if version $1 is less than or equal to version $2
version_le() {
    if [ "$1" = "$2" ]; then
        return 0
    fi
    version_lt "$1" "$2"
}

# Function to migrate configuration between versions
migrate_config() {
    local old_version="$1"
    local new_version="$2"
    local config="$3"

    log "Migrating config from version $old_version to $new_version"

    # Migration from legacy versions
    if version_lt "$old_version" "1.6.1"; then
        log "Applying schema changes for version 1.6.1+"
        # Rename "node" to "cluster"
        config=$(echo "$config" | jq 'if has("node") then .cluster = .node | del(.node) else . end')
        # Rename "customHostname" to "customApiEndPoint" in "cluster"
        config=$(echo "$config" | jq '.cluster |= (if has("customHostname") then .customApiEndPoint = .customHostname | del(.customHostname) else . end)')
    fi

    # Migration to 2.0.0 (bootc version)
    if version_lt "$old_version" "2.0.0"; then
        log "Applying schema changes for version 2.0.0 (bootc)"
        # Add storage section if missing
        config=$(echo "$config" | jq 'if .storage == null then .storage = {"vg_data": {"enabled": "true", "disk": "auto", "size": "remaining"}} else . end')
    fi

    echo "$config"
}

# Backup current configuration
backup_config() {
    if [ -f "$CONFIG_FILE" ]; then
        mkdir -p "$BACKUP_DIR"
        local backup_file="$BACKUP_DIR/k4all-config.$(date +%Y%m%d-%H%M%S).json"
        cp "$CONFIG_FILE" "$backup_file"
        log "Configuration backed up to $backup_file"
    fi
}

# Update configuration with new defaults
update_config() {
    local default_config_file="/usr/local/share/default-cluster-config.json"
    
    if [ ! -f "$default_config_file" ]; then
        warn "Default config not found at $default_config_file, skipping config update"
        return 0
    fi

    # Create config if it doesn't exist
    if [ ! -f "$CONFIG_FILE" ]; then
        cp "$default_config_file" "$CONFIG_FILE"
        log "Created new config from defaults"
        return 0
    fi

    # Backup before update
    backup_config

    # Get versions
    local current_version=$(jq -r '.version // "0.0.0"' "$CONFIG_FILE")
    local default_version=$(jq -r '.version' "$default_config_file")

    log "Current config version: $current_version"
    log "New config version: $default_version"

    if version_le "$current_version" "$default_version"; then
        log "Merging configurations..."
        
        # Deep merge: current config takes precedence, but add new fields from default
        local merged_config=$(jq -s '
        def deepmerge(a; b):
            if (a | type) == "object" and (b | type) == "object" then
                reduce (b | to_entries[]) as $item
                (a;
                    if .[$item.key] == null then .[$item.key] = $item.value
                    else .[$item.key] = deepmerge(.[$item.key]; $item.value) end)
            else a end;
        deepmerge(.[0]; .[1])' "$CONFIG_FILE" "$default_config_file")

        # Apply migrations
        merged_config=$(migrate_config "$current_version" "$default_version" "$merged_config")

        # Update version
        merged_config=$(echo "$merged_config" | jq --arg v "$default_version" '.version = $v')

        # Write updated config
        echo "$merged_config" > "$CONFIG_FILE"
        log "Configuration updated to version $default_version"
    else
        log "Configuration is already up to date"
    fi
}

# Check current bootc status
check_status() {
    log "Current bootc status:"
    bootc status
    echo ""
}

# Perform the upgrade
do_upgrade() {
    log "Upgrading K4All node to image: $IMAGE"
    
    # Check if we need to switch images or just upgrade
    local current_image=$(bootc status --json | jq -r '.status.booted.image.imageDigest // empty' 2>/dev/null || echo "")
    
    if [ -z "$current_image" ]; then
        warn "Could not determine current image, proceeding with upgrade"
    fi

    # Perform the upgrade
    log "Running bootc upgrade..."
    if bootc upgrade; then
        log "Upgrade staged successfully!"
        log ""
        log "The new image will be activated on next reboot."
        log "Run 'systemctl reboot' to apply the update."
        return 0
    else
        # If upgrade fails, try switch (for image changes)
        warn "Upgrade failed, trying switch to $IMAGE..."
        if bootc switch "$IMAGE"; then
            log "Switch staged successfully!"
            log ""
            log "The new image will be activated on next reboot."
            log "Run 'systemctl reboot' to apply the update."
            return 0
        else
            error "Failed to upgrade or switch to $IMAGE"
            return 1
        fi
    fi
}

# Rollback to previous deployment
do_rollback() {
    log "Rolling back to previous deployment..."
    bootc rollback
    log "Rollback staged. Reboot to apply."
}

# Main
main() {
    local action="${1:-upgrade}"
    
    case "$action" in
        upgrade|update)
            shift || true
            IMAGE_TAG="${1:-latest}"
            IMAGE="${K4ALL_IMAGE:-$DEFAULT_IMAGE}:$IMAGE_TAG"
            
            log "K4All Node Update (bootc)"
            log "========================="
            echo ""
            
            check_status
            update_config
            do_upgrade
            ;;
        rollback)
            do_rollback
            ;;
        status)
            check_status
            ;;
        config)
            update_config
            ;;
        migrate)
            log "Running configuration migration..."
            /usr/local/bin/k4all-migrate-config.sh
            ;;
        *)
            echo "K4All Node Update Script"
            echo ""
            echo "Usage: $0 [command] [options]"
            echo ""
            echo "Commands:"
            echo "  upgrade [tag]   Upgrade to latest image (or specific tag)"
            echo "  rollback        Rollback to previous deployment"
            echo "  status          Show current bootc status"
            echo "  config          Update configuration only"
            echo ""
            echo "Examples:"
            echo "  $0 upgrade          # Upgrade to latest"
            echo "  $0 upgrade v2.1.0   # Upgrade to specific version"
            echo "  $0 rollback         # Rollback to previous"
            echo ""
            echo "Environment:"
            echo "  K4ALL_IMAGE     Override default image (default: $DEFAULT_IMAGE)"
            ;;
    esac
}

main "$@"
