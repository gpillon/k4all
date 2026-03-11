#!/bin/bash
# K4All Restore Script
# Restores a K4All backup archive placed by the installer (or manually).
# This script runs early in the boot sequence, BEFORE kubeadm init/join.
#
# Behavior by node type:
#   bootstrap: Restore etcd snapshot, PKI, configs → the init service detects the restore
#              flag and skips kubeadm init (cluster is already initialized from etcd)
#   control:   Restore PKI, configs → let auto-join rejoin the cluster
#   worker:    Restore configs → let auto-join rejoin the cluster
set -euo pipefail

RESTORE_DIR="/var/opt/k4all/restore"
RESTORE_DONE="/opt/k4all/restore.done"
RESTORE_MARKER="K4ALL_BACKUP_V2"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[k4all-restore]${NC} $1"; }
warn() { echo -e "${YELLOW}[k4all-restore WARN]${NC} $1"; }
err()  { echo -e "${RED}[k4all-restore ERROR]${NC} $1" >&2; }

# ========================================================================
# Helper: find a backup archive in known locations
# ========================================================================
find_backup_archive() {
    local search_paths=(
        "$RESTORE_DIR"
        "/var/opt/k4all/backups"
        "/run/media"
        "/mnt"
    )

    for dir in "${search_paths[@]}"; do
        if [ -d "$dir" ]; then
            local found
            found=$(find "$dir" -maxdepth 3 -name 'k4all-backup-*.tar.gz' -type f 2>/dev/null | sort -r | head -1)
            if [ -n "$found" ]; then
                if tar -tzf "$found" metadata/backup-info.json &>/dev/null; then
                    echo "$found"
                    return 0
                fi
            fi
        fi
    done
    return 1
}

# ========================================================================
# Node-type-specific restore functions
# ========================================================================
restore_bootstrap() {
    log "Performing BOOTSTRAP restore (cluster restore)..."

    if [ -f "$WORK_DIR/etcd/snapshot.db" ]; then
        log "Restoring etcd from snapshot..."
        mkdir -p /var/lib/etcd-restore

        local etcd_args=(
            --data-dir=/var/lib/etcd-restore
            --skip-hash-check=true
        )

        if command -v etcdutl &>/dev/null; then
            etcdutl snapshot restore "$WORK_DIR/etcd/snapshot.db" "${etcd_args[@]}"
        elif command -v etcdctl &>/dev/null; then
            ETCDCTL_API=3 etcdctl snapshot restore "$WORK_DIR/etcd/snapshot.db" "${etcd_args[@]}"
        else
            warn "Neither etcdutl nor etcdctl available, attempting raw copy"
            if [ -d "$WORK_DIR/etcd/data" ]; then
                cp -a "$WORK_DIR/etcd/data" /var/lib/etcd-restore
            fi
        fi

        if [ -d /var/lib/etcd-restore ] && [ "$(ls -A /var/lib/etcd-restore 2>/dev/null)" ]; then
            rm -rf /var/lib/etcd
            mv /var/lib/etcd-restore /var/lib/etcd
            log "  + etcd data restored"
        fi
    elif [ -d "$WORK_DIR/etcd/data" ]; then
        log "Restoring etcd from raw data copy..."
        rm -rf /var/lib/etcd
        cp -a "$WORK_DIR/etcd/data" /var/lib/etcd
        log "  + etcd data directory restored"
    else
        warn "No etcd snapshot or data found in backup"
    fi

    # Restore static pod manifests
    if [ -d "$WORK_DIR/kubernetes/manifests" ]; then
        mkdir -p /etc/kubernetes/manifests
        cp -a "$WORK_DIR/kubernetes/manifests/"* /etc/kubernetes/manifests/ 2>/dev/null || true
        log "  + static pod manifests restored"
    fi

    # Restore kubeconfig files
    for f in admin.conf kubelet.conf controller-manager.conf scheduler.conf super-admin.conf; do
        if [ -f "$WORK_DIR/kubernetes/$f" ]; then
            cp "$WORK_DIR/kubernetes/$f" /etc/kubernetes/
            log "  + /etc/kubernetes/$f"
        fi
    done

    # Signal the init service to skip kubeadm init
    touch /opt/k4all/restore-bootstrap-cluster.flag
    log "  Bootstrap restore complete. Init service will detect the restore flag."
}

restore_control() {
    log "Performing CONTROL node restore..."
    for f in admin.conf kubelet.conf controller-manager.conf scheduler.conf; do
        if [ -f "$WORK_DIR/kubernetes/$f" ]; then
            cp "$WORK_DIR/kubernetes/$f" /etc/kubernetes/
            log "  + /etc/kubernetes/$f"
        fi
    done
    log "  Control node restore complete. Auto-join will handle cluster rejoin."
}

restore_worker() {
    log "Performing WORKER node restore..."
    if [ -f "$WORK_DIR/kubernetes/kubelet.conf" ]; then
        mkdir -p /etc/kubernetes
        cp "$WORK_DIR/kubernetes/kubelet.conf" /etc/kubernetes/kubelet.conf
        log "  + /etc/kubernetes/kubelet.conf"
    fi
    log "  Worker node restore complete. Auto-join will handle cluster rejoin."
}

# ========================================================================
# Main
# ========================================================================

if [ -f "$RESTORE_DONE" ]; then
    exit 0
fi

ARCHIVE=$(find_backup_archive) || true

if [ -z "$ARCHIVE" ]; then
    log "No backup archive found — fresh installation, skipping restore."
    mkdir -p /opt/k4all
    touch "$RESTORE_DONE"
    exit 0
fi

log "Found backup archive: $ARCHIVE"

WORK_DIR=$(mktemp -d /tmp/k4all-restore.XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

tar -xzf "$ARCHIVE" -C "$WORK_DIR"

# Validate backup marker
BACKUP_MARKER_VAL=$(jq -r '.marker // ""' "$WORK_DIR/metadata/backup-info.json" 2>/dev/null || echo "")
if [ "$BACKUP_MARKER_VAL" != "$RESTORE_MARKER" ]; then
    err "Invalid backup archive (marker mismatch: expected $RESTORE_MARKER, got $BACKUP_MARKER_VAL)"
    exit 1
fi

BACKUP_NODE_TYPE=$(jq -r '.node_type' "$WORK_DIR/metadata/backup-info.json")
BACKUP_HOSTNAME=$(jq -r '.hostname' "$WORK_DIR/metadata/backup-info.json")
BACKUP_VERSION=$(jq -r '.k4all_version' "$WORK_DIR/metadata/backup-info.json")

log "Restoring backup from: ${BACKUP_HOSTNAME} (${BACKUP_NODE_TYPE} node, K4All ${BACKUP_VERSION})"

# --- Restore configuration files ---
log "Restoring K4All configuration files..."
if [ -d "$WORK_DIR/config" ]; then
    for f in k4all-config.json node-type k4all-release.yaml k8s-config.yaml; do
        if [ -f "$WORK_DIR/config/$f" ]; then
            cp "$WORK_DIR/config/$f" "/etc/$f"
            log "  + /etc/$f"
        fi
    done

    if [ -f "$WORK_DIR/config/hostname" ]; then
        cp "$WORK_DIR/config/hostname" /etc/hostname
        hostnamectl set-hostname "$(cat /etc/hostname)" 2>/dev/null || true
        log "  + hostname restored: $(cat /etc/hostname)"
    fi
fi

# --- Restore network configuration ---
if [ -d "$WORK_DIR/network/nm-connections" ]; then
    log "Restoring NetworkManager connections..."
    mkdir -p /etc/NetworkManager/system-connections
    cp -a "$WORK_DIR/network/nm-connections/"* /etc/NetworkManager/system-connections/ 2>/dev/null || true
    log "  + NetworkManager connections"
fi
if [ -f "$WORK_DIR/network/keepalived.conf" ]; then
    mkdir -p /etc/keepalived
    cp "$WORK_DIR/network/keepalived.conf" /etc/keepalived/keepalived.conf
    log "  + keepalived config"
fi

# --- Restore Kubernetes PKI ---
if [ -d "$WORK_DIR/kubernetes/pki" ]; then
    log "Restoring Kubernetes PKI certificates..."
    mkdir -p /etc/kubernetes
    cp -a "$WORK_DIR/kubernetes/pki" /etc/kubernetes/pki
    log "  + /etc/kubernetes/pki"
fi

# --- Restore kubelet configuration ---
if [ -d "$WORK_DIR/kubelet" ]; then
    log "Restoring kubelet configuration..."
    mkdir -p /var/lib/kubelet
    for f in config.yaml kubeadm-flags.env; do
        if [ -f "$WORK_DIR/kubelet/$f" ]; then
            cp "$WORK_DIR/kubelet/$f" /var/lib/kubelet/
            log "  + /var/lib/kubelet/$f"
        fi
    done
fi

# --- Restore user data ---
if [ -d "$WORK_DIR/user" ]; then
    for f in "$WORK_DIR/user/"*; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        case "$base" in
            .bash_profile) cp "$f" /root/.bash_profile ;;
            login_data) cp "$f" /etc/login_data ;;
        esac
    done
fi

# --- Run node-type-specific restore ---
NODE_TYPE=$(cat /etc/node-type 2>/dev/null || echo "$BACKUP_NODE_TYPE")

case "$NODE_TYPE" in
    bootstrap) restore_bootstrap ;;
    control)   restore_control ;;
    worker)    restore_worker ;;
    *)         warn "Unknown node type '$NODE_TYPE', performing generic restore" ;;
esac

mkdir -p /opt/k4all
echo "$ARCHIVE" > /opt/k4all/restore-source.txt
touch "$RESTORE_DONE"
log "Restore completed successfully from: $ARCHIVE"
