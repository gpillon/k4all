#!/bin/bash
# K4All Backup Script
# Creates a full application-level backup of a K4All node for restore after reinstallation.
#
# Usage:
#   k4all-backup.sh [output-path]
#
# output-path:
#   - if omitted: backup is written under /var/opt/k4all/backups/
#   - if it is a directory: backup is written there with an auto-generated filename
#   - if it ends with .tar.gz: it is treated as the full archive path
#
# Note:
#   Automatic restore discovery looks for files matching:
#     k4all-backup-*.tar.gz
#   If you choose a custom filename not matching that pattern, auto-detection may not find it.

set -euo pipefail

trap 'rc=$?; echo "[k4all-backup ERROR] line $LINENO: $BASH_COMMAND (rc=$rc)" >&2' ERR

BACKUP_MARKER="K4ALL_BACKUP_V2"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
NODE_TYPE="$(cat /etc/node-type 2>/dev/null || echo "unknown")"
HOSTNAME_VAL="$(hostname)"
OUTPUT_ARG="${1:-/var/opt/k4all/backups}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[k4all-backup]${NC} $1"; }
warn() { echo -e "${YELLOW}[k4all-backup WARN]${NC} $1"; }
err()  { echo -e "${RED}[k4all-backup ERROR]${NC} $1" >&2; }

is_etcd_node() {
    [ -f /etc/kubernetes/manifests/etcd.yaml ] || [ -d /var/lib/etcd/member ]
}

save_etcd_snapshot_host() {
    local snapshot_path="$1"
    local endpoint="$2"
    local cacert="$3"
    local cert="$4"
    local key="$5"

    ETCDCTL_API=3 etcdctl snapshot save "$snapshot_path" \
        --endpoints="$endpoint" \
        --cacert="$cacert" \
        --cert="$cert" \
        --key="$key"
}

save_etcd_snapshot_podman() {
    local snapshot_path="$1"
    local endpoint="$2"
    local cacert_host="$3"
    local cert_host="$4"
    local key_host="$5"
    local manifest="$6"

    local etcd_image
    etcd_image="$(awk '/image:/ {print $2; exit}' "$manifest" 2>/dev/null || true)"

    if [ -z "${etcd_image:-}" ]; then
        warn "Unable to detect etcd image from $manifest"
        return 1
    fi

    local snapshot_dir snapshot_file
    snapshot_dir="$(dirname "$snapshot_path")"
    snapshot_file="$(basename "$snapshot_path")"

    log "  - host etcdctl unavailable or failed, trying via podman image: $etcd_image"

    podman run --rm --net=host \
        --security-opt label=disable \
        --entrypoint /usr/local/bin/etcdctl \
        -v /etc/kubernetes:/etc/kubernetes:ro \
        -v "$snapshot_dir:/backup:Z" \
        "$etcd_image" \
        snapshot save "/backup/$snapshot_file" \
        --endpoints="$endpoint" \
        --cacert="$cacert_host" \
        --cert="$cert_host" \
        --key="$key_host"
}

if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root"
    exit 1
fi

# ============================================================================
# Output path handling
# ============================================================================

DEFAULT_ARCHIVE_NAME="k4all-backup-${NODE_TYPE}-${HOSTNAME_VAL}-${TIMESTAMP}.tar.gz"

if [ -d "$OUTPUT_ARG" ]; then
    BACKUP_DIR="$OUTPUT_ARG"
    ARCHIVE_PATH="${BACKUP_DIR}/${DEFAULT_ARCHIVE_NAME}"
elif [[ "$OUTPUT_ARG" == *.tar.gz ]]; then
    BACKUP_DIR="$(dirname "$OUTPUT_ARG")"
    ARCHIVE_PATH="$OUTPUT_ARG"
else
    BACKUP_DIR="$OUTPUT_ARG"
    ARCHIVE_PATH="${BACKUP_DIR}/${DEFAULT_ARCHIVE_NAME}"
fi

mkdir -p "$BACKUP_DIR"

ARCHIVE_BASENAME="$(basename "$ARCHIVE_PATH")"
if [[ ! "$ARCHIVE_BASENAME" =~ ^k4all-backup-.*\.tar\.gz$ ]]; then
    warn "Archive name '$ARCHIVE_BASENAME' does not match k4all-backup-*.tar.gz"
    warn "Automatic restore detection may not find it"
fi

WORK_DIR="$(mktemp -d /tmp/k4all-backup.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log "Starting K4All backup for ${NODE_TYPE} node '${HOSTNAME_VAL}'"

# ============================================================================
# Metadata
# ============================================================================

mkdir -p "$WORK_DIR/metadata"

K4ALL_VERSION="$(jq -r '.version // "unknown"' /etc/k4all-config.json 2>/dev/null || echo 'unknown')"
KUBELET_VERSION="$(kubelet --version 2>/dev/null | awk '{print $2}' || echo 'unknown')"

cat > "$WORK_DIR/metadata/backup-info.json" <<EOF
{
  "marker": "${BACKUP_MARKER}",
  "timestamp": "${TIMESTAMP}",
  "hostname": "${HOSTNAME_VAL}",
  "node_type": "${NODE_TYPE}",
  "k4all_version": "${K4ALL_VERSION}",
  "kubernetes_version": "${KUBELET_VERSION}"
}
EOF

log "  + metadata/backup-info.json"

# ============================================================================
# K4All configuration
# ============================================================================

log "Backing up K4All configuration..."
mkdir -p "$WORK_DIR/config"

for f in \
    /etc/k4all-config.json \
    /etc/node-type \
    /etc/k4all-release.yaml \
    /etc/k8s-config.yaml \
    /etc/hostname
do
    if [ -f "$f" ]; then
        cp -f "$f" "$WORK_DIR/config/"
        log "  + $f"
    fi
done

# ============================================================================
# Kubernetes files
# ============================================================================

log "Backing up Kubernetes files..."
mkdir -p "$WORK_DIR/kubernetes"

if [ -d /etc/kubernetes/pki ]; then
    cp -a /etc/kubernetes/pki "$WORK_DIR/kubernetes/pki"
    log "  + /etc/kubernetes/pki"
fi

for f in \
    /etc/kubernetes/admin.conf \
    /etc/kubernetes/kubelet.conf \
    /etc/kubernetes/controller-manager.conf \
    /etc/kubernetes/scheduler.conf \
    /etc/kubernetes/super-admin.conf
do
    if [ -f "$f" ]; then
        cp -f "$f" "$WORK_DIR/kubernetes/"
        log "  + $f"
    fi
done

if [ -d /etc/kubernetes/manifests ]; then
    cp -a /etc/kubernetes/manifests "$WORK_DIR/kubernetes/manifests"
    log "  + /etc/kubernetes/manifests"
fi

# ============================================================================
# etcd backup
# ============================================================================

if is_etcd_node; then
    log "Backing up etcd snapshot..."
    mkdir -p "$WORK_DIR/etcd"

    ETCD_ENDPOINT="https://127.0.0.1:2379"
    ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
    ETCD_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
    ETCD_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"
    ETCD_SNAPSHOT_PATH="$WORK_DIR/etcd/snapshot.db"
    ETCD_MANIFEST="/etc/kubernetes/manifests/etcd.yaml"

    snapshot_saved=0

    if [ -f "$ETCD_CACERT" ] && [ -f "$ETCD_CERT" ] && [ -f "$ETCD_KEY" ]; then
        if command -v etcdctl >/dev/null 2>&1; then
            if save_etcd_snapshot_host "$ETCD_SNAPSHOT_PATH" "$ETCD_ENDPOINT" "$ETCD_CACERT" "$ETCD_CERT" "$ETCD_KEY"; then
                snapshot_saved=1
                log "  + etcd snapshot saved with host etcdctl"
            else
                warn "Host etcdctl snapshot failed"
            fi
        fi

        if [ "$snapshot_saved" -ne 1 ] && command -v podman >/dev/null 2>&1 && [ -f "$ETCD_MANIFEST" ]; then
            if save_etcd_snapshot_podman "$ETCD_SNAPSHOT_PATH" "$ETCD_ENDPOINT" "$ETCD_CACERT" "$ETCD_CERT" "$ETCD_KEY" "$ETCD_MANIFEST"; then
                snapshot_saved=1
                log "  + etcd snapshot saved via podman"
            else
                warn "Podman-based etcd snapshot failed"
            fi
        fi
    else
        warn "etcd client certificates not found, snapshot backup may not be possible"
    fi

    if [ "$snapshot_saved" -ne 1 ]; then
        if [ -d /var/lib/etcd/member ]; then
            warn "Falling back to raw etcd data directory backup"
            cp -a /var/lib/etcd "$WORK_DIR/etcd/data"
            log "  + /var/lib/etcd (raw copy)"
        else
            warn "Skipping raw etcd backup: no local etcd member data found"
        fi
    fi
else
    log "No local etcd member detected on this node, skipping etcd backup."
fi

# ============================================================================
# Kubelet data
# ============================================================================

log "Backing up kubelet configuration..."
mkdir -p "$WORK_DIR/kubelet"

for f in /var/lib/kubelet/config.yaml /var/lib/kubelet/kubeadm-flags.env; do
    if [ -f "$f" ]; then
        cp -f "$f" "$WORK_DIR/kubelet/"
        log "  + $f"
    fi
done

if [ -d /var/lib/kubelet/pki ]; then
    cp -a /var/lib/kubelet/pki "$WORK_DIR/kubelet/"
    log "  + /var/lib/kubelet/pki"
fi

# ============================================================================
# K4All state markers
# ============================================================================

log "Backing up K4All state markers..."
mkdir -p "$WORK_DIR/state"

if [ -d /var/opt/k4all ]; then
    find /var/opt/k4all -maxdepth 1 -type f -name '*.done' -exec cp -f {} "$WORK_DIR/state/" \; 2>/dev/null || true
    log "  + /var/opt/k4all/*.done markers"
fi

# ============================================================================
# Network configuration
# ============================================================================

log "Backing up network configuration..."
mkdir -p "$WORK_DIR/network"

if [ -d /etc/NetworkManager/system-connections ]; then
    cp -a /etc/NetworkManager/system-connections "$WORK_DIR/network/nm-connections"
    log "  + /etc/NetworkManager/system-connections"
fi

if [ -f /etc/keepalived/keepalived.conf ]; then
    cp -f /etc/keepalived/keepalived.conf "$WORK_DIR/network/"
    log "  + /etc/keepalived/keepalived.conf"
fi

# ============================================================================
# Helm inventory
# ============================================================================

if command -v helm >/dev/null 2>&1 && [ -f /etc/kubernetes/admin.conf ]; then
    log "Saving helm release inventory..."
    mkdir -p "$WORK_DIR/helm"
    helm --kubeconfig=/etc/kubernetes/admin.conf list -A -o json > "$WORK_DIR/helm/releases.json" 2>/dev/null || true
    log "  + helm/releases.json"
fi

# ============================================================================
# Custom user data
# ============================================================================

log "Backing up custom user data..."
mkdir -p "$WORK_DIR/user"

for f in /root/.bash_profile /etc/login_data; do
    if [ -f "$f" ]; then
        cp -f "$f" "$WORK_DIR/user/"
        log "  + $f"
    fi
done

# ============================================================================
# Create archive
# ============================================================================

log "Creating backup archive: ${ARCHIVE_PATH}"
tar -czf "$ARCHIVE_PATH" -C "$WORK_DIR" .

ARCHIVE_SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
log "Backup complete: ${ARCHIVE_PATH} (${ARCHIVE_SIZE})"
log ""
log "To restore automatically, place this archive where the installer can find it:"
log "  - /var/opt/k4all/restore/"
log "  - a mounted USB drive"
log "  - a mounted data partition"
log "  - any location scanned by the restore script for k4all-backup-*.tar.gz"
