#!/bin/bash
# K4All Backup Script
# Creates a full application-level backup of a K4All node for restore after reinstallation.
# The backup archive can be placed on a USB drive, CD-ROM, or left on a data partition
# so the Anaconda installer can detect it and restore automatically.
#
# Usage: k4all-backup.sh [output-path]
#   output-path: directory or full path for the backup archive (default: /var/opt/k4all/backups/)
set -euo pipefail

BACKUP_MARKER="K4ALL_BACKUP_V2"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
NODE_TYPE=$(cat /etc/node-type 2>/dev/null || echo "unknown")
HOSTNAME_VAL=$(hostname)
OUTPUT_ARG="${1:-/var/opt/k4all/backups}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[k4all-backup]${NC} $1"; }
warn() { echo -e "${YELLOW}[k4all-backup WARN]${NC} $1"; }
err()  { echo -e "${RED}[k4all-backup ERROR]${NC} $1" >&2; }

if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root"
    exit 1
fi

# Determine output path
if [ -d "$OUTPUT_ARG" ]; then
    BACKUP_DIR="$OUTPUT_ARG"
else
    BACKUP_DIR=$(dirname "$OUTPUT_ARG")
fi
mkdir -p "$BACKUP_DIR"
ARCHIVE_NAME="k4all-backup-${NODE_TYPE}-${HOSTNAME_VAL}-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"

WORK_DIR=$(mktemp -d /tmp/k4all-backup.XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

log "Starting K4All backup for ${NODE_TYPE} node '${HOSTNAME_VAL}'"

# --- Metadata ---
mkdir -p "$WORK_DIR/metadata"
cat > "$WORK_DIR/metadata/backup-info.json" <<EOF
{
  "marker": "${BACKUP_MARKER}",
  "timestamp": "${TIMESTAMP}",
  "hostname": "${HOSTNAME_VAL}",
  "node_type": "${NODE_TYPE}",
  "k4all_version": "$(jq -r '.version // "unknown"' /etc/k4all-config.json 2>/dev/null || echo 'unknown')",
  "kubernetes_version": "$(kubelet --version 2>/dev/null | awk '{print $2}' || echo 'unknown')"
}
EOF

# --- K4All configuration files ---
log "Backing up K4All configuration..."
mkdir -p "$WORK_DIR/config"
for f in /etc/k4all-config.json /etc/node-type /etc/k4all-release.yaml /etc/k8s-config.yaml /etc/hostname; do
    if [ -f "$f" ]; then
        cp "$f" "$WORK_DIR/config/"
        log "  + $f"
    fi
done

# --- Kubernetes PKI ---
log "Backing up Kubernetes PKI certificates..."
if [ -d /etc/kubernetes/pki ]; then
    mkdir -p "$WORK_DIR/kubernetes"
    cp -a /etc/kubernetes/pki "$WORK_DIR/kubernetes/pki"
    log "  + /etc/kubernetes/pki"
fi

# Kubernetes config files (admin.conf, kubelet.conf, etc.)
for f in /etc/kubernetes/admin.conf /etc/kubernetes/kubelet.conf /etc/kubernetes/controller-manager.conf /etc/kubernetes/scheduler.conf /etc/kubernetes/super-admin.conf; do
    if [ -f "$f" ]; then
        cp "$f" "$WORK_DIR/kubernetes/"
        log "  + $f"
    fi
done

# kubeadm config (for join/init reconstruction)
if [ -d /etc/kubernetes/manifests ]; then
    cp -a /etc/kubernetes/manifests "$WORK_DIR/kubernetes/manifests"
    log "  + /etc/kubernetes/manifests"
fi

# --- etcd backup (bootstrap/control nodes only) ---
if [ "$NODE_TYPE" = "bootstrap" ] || [ "$NODE_TYPE" = "control" ]; then
    log "Backing up etcd snapshot..."
    mkdir -p "$WORK_DIR/etcd"

    ETCD_CERT="/etc/kubernetes/pki/etcd/server.crt"
    ETCD_KEY="/etc/kubernetes/pki/etcd/server.key"
    ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
    ETCD_ENDPOINT="https://127.0.0.1:2379"

    if [ -f "$ETCD_CERT" ] && [ -f "$ETCD_KEY" ] && [ -f "$ETCD_CACERT" ]; then
        if command -v etcdctl &>/dev/null; then
            ETCDCTL_API=3 etcdctl snapshot save "$WORK_DIR/etcd/snapshot.db" \
                --endpoints="$ETCD_ENDPOINT" \
                --cacert="$ETCD_CACERT" \
                --cert="$ETCD_CERT" \
                --key="$ETCD_KEY" 2>/dev/null && \
                log "  + etcd snapshot saved" || \
                warn "etcd snapshot failed (is etcd running?)"
        elif [ -d /var/lib/etcd ]; then
            # etcdctl not available, try etcdutl or copy raw data
            if command -v etcdutl &>/dev/null; then
                etcdutl snapshot save "$WORK_DIR/etcd/snapshot.db" 2>/dev/null && \
                    log "  + etcd snapshot saved via etcdutl" || \
                    warn "etcdutl snapshot failed"
            else
                warn "etcdctl/etcdutl not found; backing up raw etcd data directory"
                cp -a /var/lib/etcd "$WORK_DIR/etcd/data"
                log "  + /var/lib/etcd (raw copy)"
            fi
        fi
    else
        warn "etcd certificates not found, skipping etcd backup"
    fi
fi

# --- Kubelet data ---
log "Backing up kubelet configuration..."
mkdir -p "$WORK_DIR/kubelet"
for f in /var/lib/kubelet/config.yaml /var/lib/kubelet/kubeadm-flags.env; do
    if [ -f "$f" ]; then
        cp "$f" "$WORK_DIR/kubelet/"
        log "  + $f"
    fi
done

# --- K4All state markers (which setup steps were completed) ---
log "Backing up K4All state markers..."
if [ -d /opt/k4all ] || [ -d /var/opt/k4all ]; then
    mkdir -p "$WORK_DIR/state"
    find /var/opt/k4all -maxdepth 1 -name '*.done' -exec cp {} "$WORK_DIR/state/" \; 2>/dev/null || true
    log "  + /var/opt/k4all/*.done markers"
fi

# --- Network configuration ---
log "Backing up network configuration..."
mkdir -p "$WORK_DIR/network"
if [ -d /etc/NetworkManager/system-connections ]; then
    cp -a /etc/NetworkManager/system-connections "$WORK_DIR/network/nm-connections"
    log "  + NetworkManager connections"
fi
if [ -f /etc/keepalived/keepalived.conf ]; then
    cp /etc/keepalived/keepalived.conf "$WORK_DIR/network/"
    log "  + keepalived config"
fi

# --- Helm releases list (for reference) ---
if command -v helm &>/dev/null && [ -f /etc/kubernetes/admin.conf ]; then
    log "Saving helm release inventory..."
    mkdir -p "$WORK_DIR/helm"
    helm --kubeconfig=/etc/kubernetes/admin.conf list -A -o json > "$WORK_DIR/helm/releases.json" 2>/dev/null || true
    log "  + helm release list"
fi

# --- Custom user data ---
mkdir -p "$WORK_DIR/user"
for f in /root/.bash_profile /etc/login_data; do
    if [ -f "$f" ]; then
        cp "$f" "$WORK_DIR/user/"
    fi
done

# --- Create archive ---
log "Creating backup archive: ${ARCHIVE_PATH}"
tar -czf "$ARCHIVE_PATH" -C "$WORK_DIR" .

ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)
log "Backup complete: ${ARCHIVE_PATH} (${ARCHIVE_SIZE})"
log ""
log "To restore, place this archive where the K4All installer can find it:"
log "  - On a USB drive at the root"
log "  - On an existing data partition (vg_data or any mounted disk)"
log "  - The installer will auto-detect files matching 'k4all-backup-*.tar.gz'"
