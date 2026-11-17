#!/bin/bash
# K4All - move a v2.0 .. v2.2.3 node to the v2.2.4 bridge release.
#
# Older images have no k4all-upgrade; this script is their one manual step.
# The bridge changes neither Kubernetes nor CRI-O nor Fedora, so nodes can be
# moved in any order; still, do one node at a time, control planes first.
#
#   curl -fsSL https://github.com/gpillon/k4all/releases/download/v2.2.4/k4all-bridge.sh \
#     | sudo bash -s -- [--now]
#
# Options:
#   --now       reboot into the bridge right away (default: on next reboot)
#   --dry-run   run the checks and print what would happen
#   --force     continue when a check only warns (unknown image, nodes not Ready)
set -euo pipefail

BRIDGE_VERSION="v2.2.4"
BRIDGE_REPO="ghcr.io/gpillon/k4all-bootc"
# Stamped by CI when the release is published; the tag is the fallback.
BRIDGE_DIGEST="@@BRIDGE_DIGEST@@"
ROOT="${K4ALL_ROOT:-}"
MIN_FREE_GIB=3

NOW=false
DRY_RUN=false
FORCE=false
for arg in "$@"; do
    case "$arg" in
        --now) NOW=true ;;
        --dry-run) DRY_RUN=true ;;
        --force) FORCE=true ;;
        -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

log() { echo "[k4all-bridge] $*"; }
die() { echo "[k4all-bridge] ERROR: $*" >&2; exit 1; }
warn_or_die() {
    if [ "$FORCE" = true ]; then
        echo "[k4all-bridge] WARNING: $* (continuing: --force)" >&2
    else
        die "$* (use --force to continue anyway)"
    fi
}
run() {
    if [ "$DRY_RUN" = true ]; then
        log "would run: $*"
    else
        "$@"
    fi
}

if [[ "$BRIDGE_DIGEST" == sha256:* ]]; then
    BRIDGE_IMAGE="${BRIDGE_REPO}@${BRIDGE_DIGEST}"
else
    BRIDGE_IMAGE="${BRIDGE_REPO}:${BRIDGE_VERSION}"
fi
BRIDGE_IMAGE="${K4ALL_BRIDGE_IMAGE:-$BRIDGE_IMAGE}"

[ "$(id -u)" -eq 0 ] || [ -n "$ROOT" ] || die "run as root (sudo)"
command -v bootc >/dev/null || die "bootc not found: this is not a k4all 2.x node"

# --- 1. which release is this? -------------------------------------------
STATUS=$(bootc status --json)
BOOTED_REF=$(echo "$STATUS" | jq -r '.status.booted.image.image.image // ""')
STAGED_REF=$(echo "$STATUS" | jq -r '.status.staged.image.image.image // ""')

case "$BOOTED_REF" in
    "$BRIDGE_REPO"*|*/k4all-bootc*) ;;
    *) warn_or_die "booted image '$BOOTED_REF' is not a k4all bootc image" ;;
esac

version=""
manifest="$ROOT/usr/local/share/k4all-release.yaml"
if [ -f "$ROOT/usr/local/share/k4all-upgrade/version" ]; then
    version=$(tr -d '[:space:]' < "$ROOT/usr/local/share/k4all-upgrade/version")
fi
if [[ ! "$version" =~ ^v2\. ]] && [ -f "$manifest" ]; then
    version=$(yq e '.spec.osImage.imageTag // ""' "$manifest" 2>/dev/null || true)
fi
if [[ ! "$version" =~ ^v2\. ]]; then
    tag="${BOOTED_REF##*:}"
    version="${tag%-amd64}"
    version="${version%-arm64}"
fi
version="${version%-amd64}"
version="${version%-arm64}"

if [[ "$version" =~ ^v2\.([0-9]+)\.([0-9]+) ]]; then
    minor="${BASH_REMATCH[1]}"
    patch="${BASH_REMATCH[2]}"
    if [ "$minor" -gt 2 ] || { [ "$minor" -eq 2 ] && [ "$patch" -ge 4 ]; }; then
        log "this node runs $version: already on the bridge or newer."
        log "use 'k4all-upgrade status' and 'k4all-upgrade run' from here."
        exit 0
    fi
    log "this node runs $version"
else
    warn_or_die "cannot tell the k4all release of this node (got '$version')"
fi

# --- 2. preflight ----------------------------------------------------------
if [ -n "$STAGED_REF" ] && [ "$STAGED_REF" != "null" ]; then
    die "a deployment is already staged ($STAGED_REF); reboot into it or remove it first"
fi

free_kib=$(df --output=avail -k "$ROOT/sysroot" 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
if [ "${free_kib:-0}" -lt $((MIN_FREE_GIB * 1024 * 1024)) ]; then
    die "less than ${MIN_FREE_GIB} GiB free on /sysroot"
fi

if [ -f "$ROOT/etc/kubernetes/admin.conf" ] && command -v kubectl >/dev/null; then
    KC="$ROOT/etc/kubernetes/admin.conf"
    nodes=$(kubectl --kubeconfig "$KC" get nodes --no-headers 2>/dev/null || true)
    if [ -z "$nodes" ]; then
        warn_or_die "cannot reach the cluster with $KC"
    else
        not_ready=$(echo "$nodes" | awk '$2 != "Ready" {print $1}')
        [ -z "$not_ready" ] || warn_or_die "nodes not Ready: $(echo $not_ready)"
        count=$(echo "$nodes" | wc -l)
        if [ "$count" -gt 1 ]; then
            log "cluster with $count nodes: move one node at a time, control planes"
            log "first, and wait for each to be Ready again before the next."
        fi
    fi
fi

# --- 3. stop unattended reboots, then stage the bridge --------------------------
log "masking bootc-fetch-apply-updates.timer (k4all-upgrade replaces it)"
run systemctl mask --now bootc-fetch-apply-updates.timer

# bootc runs as a transient unit, as under its own services, so it enters the
# install_t SELinux domain whatever this script was started from (a service or
# a confined shell would keep it in a domain that cannot set file labels the
# running policy does not know yet).
# No --pipe: started from a service, systemd refuses the caller's pipes. bootc
# writes to the unit's journal, shown here when it fails.
bootc_unit() {
    local unit="k4all-bridge-bootc-$$"
    if ! run systemd-run --wait --collect --quiet --unit "$unit" -- bootc "$@"; then
        journalctl -u "$unit" -o cat --no-pager -n 40 >&2 || true
        die "bootc $* failed"
    fi
}

if [ "$NOW" = true ]; then
    log "switching to $BRIDGE_IMAGE and rebooting"
    bootc_unit switch --apply "$BRIDGE_IMAGE"
else
    log "staging $BRIDGE_IMAGE for the next reboot"
    bootc_unit switch "$BRIDGE_IMAGE"
    log "done. Reboot when convenient: systemctl reboot"
fi
