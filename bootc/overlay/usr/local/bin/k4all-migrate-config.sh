#!/bin/bash
# K4All Configuration Migration Script
# Migrates /etc/k4all-config.json between K4All versions.
# Also updates /etc/k4all-release.yaml with latest base component versions
# while preserving user customizations in the `custom` section.
#
# Usage: k4all-migrate-config.sh [--dry-run]
set -euo pipefail

CONFIG_FILE="/etc/k4all-config.json"
RELEASE_FILE="/etc/k4all-release.yaml"
BASE_CONFIG="/usr/local/share/default-cluster-config.json"
BASE_RELEASE="/usr/local/share/k4all-release.yaml"
BACKUP_DIR="/opt/k4all/config-backups"
DRY_RUN=false

if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN=true
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[k4all-migrate]${NC} $1"; }
warn() { echo -e "${YELLOW}[k4all-migrate WARN]${NC} $1"; }
err()  { echo -e "${RED}[k4all-migrate ERROR]${NC} $1" >&2; }

# --- Version comparison ---
version_lt() {
    local IFS=.
    local i ver1=($1) ver2=($2)
    for ((i=${#ver1[@]}; i<${#ver2[@]}; i++)); do ver1[i]=0; done
    for ((i=${#ver2[@]}; i<${#ver1[@]}; i++)); do ver2[i]=0; done
    for ((i=0; i<${#ver1[@]}; i++)); do
        if ((10#${ver1[i]:-0} < 10#${ver2[i]:-0})); then return 0; fi
        if ((10#${ver1[i]:-0} > 10#${ver2[i]:-0})); then return 1; fi
    done
    return 1
}

version_le() {
    [ "$1" = "$2" ] && return 0
    version_lt "$1" "$2"
}

# --- Backup ---
backup_file() {
    local src="$1"
    if [ -f "$src" ]; then
        mkdir -p "$BACKUP_DIR"
        local ts
        ts=$(date +%Y%m%d-%H%M%S)
        local base
        base=$(basename "$src")
        local dst="$BACKUP_DIR/${base}.${ts}.bak"
        cp "$src" "$dst"
        log "Backed up $src → $dst"
    fi
}

# ========================================================================
# Config migrations (k4all-config.json)
# Each migration function transforms the config JSON for a specific version bump.
# ========================================================================
migrate_config() {
    local old_version="$1"
    local config="$2"

    # Pre-1.6.1: "node" was renamed to "cluster", "customHostname" to "customApiEndPoint"
    if version_lt "$old_version" "1.6.1"; then
        log "  Applying migration: < 1.6.1 → rename node→cluster, customHostname→customApiEndPoint"
        config=$(echo "$config" | jq '
            if has("node") then .cluster = .node | del(.node) else . end |
            .cluster |= (if has("customHostname") then .customApiEndPoint = .customHostname | del(.customHostname) else . end)
        ')
    fi

    # Pre-1.8.0: add gateway feature, rename kubernetes-dashboard to headlamp
    if version_lt "$old_version" "1.8.0"; then
        log "  Applying migration: < 1.8.0 → add gateway feature"
        config=$(echo "$config" | jq '
            .features.gateway //= {"enabled": "false"}
        ')
    fi

    # Pre-2.0.0: add storage section, ingress section, cni section
    if version_lt "$old_version" "2.0.0"; then
        log "  Applying migration: < 2.0.0 → add storage, ingress, cni sections"
        config=$(echo "$config" | jq '
            .storage //= {"vg_data": {"enabled": "true", "disk": "auto", "size": "remaining"}} |
            .ingress //= {"nginx": {"enabled": "true", "isDefault": "true", "dedicatedIP": ""}, "cilium": {"enabled": "false", "isDefault": "false", "dedicatedIP": ""}} |
            .cni //= {"cilium": {"additionalDevices": "", "gatewayApi": "false", "l2announcements": "false", "hubble": "false"}} |
            .proxy //= {"http_proxy": "", "https_proxy": "", "no_proxy": ""}
        ')
    fi

    echo "$config"
}

# ========================================================================
# Main: Migrate k4all-config.json
# ========================================================================
migrate_k4all_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        if [ -f "$BASE_CONFIG" ]; then
            log "No config file found, creating from defaults"
            if [ "$DRY_RUN" = false ]; then
                cp "$BASE_CONFIG" "$CONFIG_FILE"
            fi
        else
            warn "No config file and no base config found"
        fi
        return 0
    fi

    local current_version
    current_version=$(jq -r '.version // "0.0.0"' "$CONFIG_FILE")

    local target_version
    if [ -f "$BASE_CONFIG" ]; then
        target_version=$(jq -r '.version // "2.0.0"' "$BASE_CONFIG")
    else
        target_version="2.0.0"
    fi

    log "Current config version: $current_version"
    log "Target config version:  $target_version"

    if [ "$current_version" = "$target_version" ]; then
        log "Configuration is already up to date"
        return 0
    fi

    if ! version_lt "$current_version" "$target_version"; then
        log "Configuration version ($current_version) is newer than target ($target_version), skipping"
        return 0
    fi

    if [ "$DRY_RUN" = false ]; then
        backup_file "$CONFIG_FILE"
    fi

    local config
    config=$(cat "$CONFIG_FILE")

    # Run migrations
    config=$(migrate_config "$current_version" "$config")

    # Deep merge with new defaults (add new fields, keep existing values)
    if [ -f "$BASE_CONFIG" ]; then
        config=$(jq -s '
        def deepmerge(a; b):
            if (a | type) == "object" and (b | type) == "object" then
                reduce (b | to_entries[]) as $item
                (a;
                    if .[$item.key] == null then .[$item.key] = $item.value
                    else .[$item.key] = deepmerge(.[$item.key]; $item.value) end)
            else a end;
        deepmerge(.[0]; .[1])' <(echo "$config") "$BASE_CONFIG")
    fi

    # Update version
    config=$(echo "$config" | jq --arg v "$target_version" '.version = $v')

    if [ "$DRY_RUN" = true ]; then
        log "DRY RUN — would write:"
        echo "$config" | jq .
    else
        echo "$config" | jq . > "$CONFIG_FILE"
        log "Configuration migrated to version $target_version"
    fi
}

# ========================================================================
# Main: Update k4all-release.yaml
# Updates component versions from the base release while preserving
# user customizations in the `custom:` section of each component.
# ========================================================================
migrate_release_manifest() {
    if [ ! -f "$BASE_RELEASE" ]; then
        warn "Base release manifest not found at $BASE_RELEASE, skipping"
        return 0
    fi

    if [ ! -f "$RELEASE_FILE" ]; then
        log "No user release manifest found, creating from base"
        if [ "$DRY_RUN" = false ]; then
            cp "$BASE_RELEASE" "$RELEASE_FILE"
        fi
        return 0
    fi

    if ! command -v yq &>/dev/null; then
        warn "yq not found, skipping release manifest migration"
        return 0
    fi

    local base_version
    base_version=$(yq e '.metadata.version' "$BASE_RELEASE")
    local current_version
    current_version=$(yq e '.metadata.version' "$RELEASE_FILE")

    log "Release manifest: current=$current_version, base=$base_version"

    if [ "$current_version" = "$base_version" ]; then
        log "Release manifest is already up to date"
        return 0
    fi

    if [ "$DRY_RUN" = false ]; then
        backup_file "$RELEASE_FILE"
    fi

    # For each component in the base release:
    # - Update version, source, repo, etc. from base
    # - Preserve user's `custom:` section
    local components
    components=$(yq e '.components | keys | .[]' "$BASE_RELEASE")

    local temp_file
    temp_file=$(mktemp)
    cp "$RELEASE_FILE" "$temp_file"

    while IFS= read -r comp; do
        [ -z "$comp" ] && continue

        # Preserve user custom section
        local user_custom
        user_custom=$(yq e ".components.${comp}.custom // {}" "$temp_file")

        # Copy all fields from base for this component
        local base_comp
        base_comp=$(yq e ".components.${comp}" "$BASE_RELEASE")

        yq e ".components.${comp} = ${base_comp}" -i "$temp_file" 2>/dev/null || \
            yq e -i ".components.${comp} = load(\"$BASE_RELEASE\").components.${comp}" "$temp_file" 2>/dev/null || true

        # Restore user custom section
        if [ "$user_custom" != "{}" ] && [ "$user_custom" != "null" ]; then
            yq e ".components.${comp}.custom = ${user_custom}" -i "$temp_file" 2>/dev/null || true
        fi
    done <<< "$components"

    # Update metadata version
    yq e ".metadata.version = \"$base_version\"" -i "$temp_file"

    if [ "$DRY_RUN" = true ]; then
        log "DRY RUN — would write release manifest:"
        cat "$temp_file"
        rm -f "$temp_file"
    else
        mv "$temp_file" "$RELEASE_FILE"
        log "Release manifest updated to version $base_version"
    fi
}

# ========================================================================
# Entry point
# ========================================================================
main() {
    log "K4All Configuration Migration"
    log "=============================="

    migrate_k4all_config
    migrate_release_manifest

    log "Migration complete."
}

main "$@"
