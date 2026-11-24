#!/bin/bash
# K4All - move a v2.0 .. v2.2.3 node to the v2.2.4 bridge release.
#
# Older images have no k4all-upgrade; this script is their one manual step.
# The bridge changes neither Kubernetes nor CRI-O nor Fedora. Still, move one
# node at a time: the bootstrap node, the other control planes, the workers.
# It reboots without a drain: on a cluster with more nodes, drain the node
# from a control plane first and uncordon it afterwards, and set mode: manual
# or managed in /etc/k4all-upgrade.yaml right after the bridge.
#
#   curl -fsSL https://github.com/gpillon/k4all/releases/latest/download/k4all-bridge.sh \
#     | sudo bash -s -- [--now]
#
# Options:
#   --now       reboot into the bridge right away (default: on next reboot)
#   --dry-run   run the checks, change nothing, and print the commands the
#               same options run without --dry-run. Pass the options you will
#               use: `--dry-run --now` shows the switch and the reboot,
#               `--dry-run` alone shows the staging for the next reboot.
#   --force     continue when a check only warns (unknown image, nodes not Ready)
#
# Right before the reboot each pod gets its own grace period to stop, at least
# 30 s and at most K4ALL_POD_STOP_MAX_SECONDS (default 300): first the pods on
# the pod network, then the host-network ones, so at most twice that.
set -euo pipefail

BRIDGE_VERSION="v2.2.4"
BRIDGE_REPO="ghcr.io/gpillon/k4all-bootc"
# Stamped by CI when the release is published; the tag is the fallback.
BRIDGE_DIGEST="@@BRIDGE_DIGEST@@"
ROOT="${K4ALL_ROOT:-}"
MIN_FREE_GIB=3
POD_STOP_SECONDS=30
POD_STOP_MAX_SECONDS="${K4ALL_POD_STOP_MAX_SECONDS:-300}"

NOW=false
DRY_RUN=false
FORCE=false
for arg in "$@"; do
    case "$arg" in
        --now) NOW=true ;;
        --dry-run) DRY_RUN=true ;;
        --force) FORCE=true ;;
        -h|--help)
            # the comment block at the top of this file
            awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' \
                "$0" 2>/dev/null || true
            exit 0 ;;
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
[[ "$POD_STOP_MAX_SECONDS" =~ ^[0-9]+$ ]] \
    || die "K4ALL_POD_STOP_MAX_SECONDS must be a number of seconds, got '$POD_STOP_MAX_SECONDS'"
[ "$POD_STOP_MAX_SECONDS" -ge "$POD_STOP_SECONDS" ] || POD_STOP_MAX_SECONDS=$POD_STOP_SECONDS
if [ "$DRY_RUN" = true ]; then
    if [ "$NOW" = true ]; then
        log "dry run: nothing changes; 'would run' lines are what --now runs"
    else
        log "dry run: nothing changes; 'would run' lines are what the same" \
            "options run, which stage the bridge for the next reboot" \
            "(add --now to see the switch and the reboot)"
    fi
fi
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

# A kube-vip manifest without settings (no address): the k4all-operator
# (v0.1.x to v0.4.x) rewrote it with the image alone, and kube-vip exits.
# When the API VIP does not answer either, this node is the one that held
# it: the bridge stops, because it runs on the old system and must not try
# to rebuild the manifest. The remedy is by hand.
KUBE_VIP_MANIFEST="$ROOT/etc/kubernetes/manifests/kube-vip.yaml"
KUBE_VIP_REMEDY="https://github.com/gpillon/k4all/blob/main/docs/upgrades.md#kube-vip-on-ha-clusters"
# The address of the VIP is `address`, or `vip_address` in older kube-vip
# manifests.
if [ -f "$ROOT/etc/kubernetes/admin.conf" ] && [ -f "$KUBE_VIP_MANIFEST" ] \
        && ! grep -Eq 'name: (vip_)?address\b' "$KUBE_VIP_MANIFEST"; then
    command -v kubectl >/dev/null \
        || die "$KUBE_VIP_MANIFEST has no settings and kubectl is missing, so the" \
               "bridge cannot tell whether the API VIP answers; see $KUBE_VIP_REMEDY"
    if kubectl --kubeconfig "$ROOT/etc/kubernetes/admin.conf" \
            get --raw /readyz --request-timeout=10s >/dev/null 2>&1; then
        log "WARNING: $KUBE_VIP_MANIFEST has no settings (rewritten by the"
        log "k4all-operator), but the API VIP answers. v2.4.0 writes it again;"
        log "see $KUBE_VIP_REMEDY"
    else
        die "$KUBE_VIP_MANIFEST has no settings (the k4all-operator rewrote it" \
            "with the image alone) and the API VIP does not answer. Set kube-vip" \
            "Unmanaged and put the k4all manifest back by hand first:" \
            "$KUBE_VIP_REMEDY"
    fi
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
            log "cluster with $count nodes: move one node at a time (the bootstrap"
            log "node, the other control planes, the workers), each Ready again"
            log "before the next. The bridge reboots without a drain: drain the"
            log "node first, and uncordon it once it is back:"
            log "  kubectl drain <node> --ignore-daemonsets --delete-emptydir-data"
            log "After the bridge, set 'mode: manual' (or 'managed' from v2.4.0) in"
            log "/etc/k4all-upgrade.yaml: the default 'auto' runs hops on its own."
        fi
    fi
fi

# --- 3. kube-vip belongs to the host ----------------------------------------
# The k4all-operator (v0.1.x to v0.4.x) applies a static-pod kube-vip by
# writing /etc/kubernetes/manifests/kube-vip.yaml with the image alone: no
# args, env or volumes. kube-vip exits and the API VIP is gone. It does so
# whenever it applies the component: a new kube-vip release while the
# version is "latest" (v2.2.x manifests), or the first manifest sync
# (v2.4.0). The manifest is the host's (setup-k8s-ph3.sh), so the operator
# must skip it: management Unmanaged. Best effort, on the bootstrap node; the
# ReleaseManifest sync keeps Unmanaged.
KUBE_VIP_UNMANAGED='{"spec":{"components":{"kube-vip":{"management":"Unmanaged"}}}}'
node_type=$(tr -d '[:space:]' < "$ROOT/etc/node-type" 2>/dev/null || true)
if [ "$node_type" = bootstrap ] && [ -n "${KC:-}" ]; then
    # --ignore-not-found: no ReleaseManifest prints nothing; an error is an
    # error (rc), never "absent".
    if rm_json=$(kubectl --kubeconfig "$KC" get releasemanifest k4all -o json \
            --ignore-not-found 2>/dev/null); then
        if [ -z "$rm_json" ]; then
            kube_vip=absent
        else
            kube_vip=$(echo "$rm_json" | jq -r '.spec.components["kube-vip"]
                | if . == null then "absent" else (.management // "Managed") end' \
                2>/dev/null || true)
        fi
    else
        kube_vip=""
    fi
    case "$kube_vip" in
        absent)
            log "kube-vip: not in the ReleaseManifest, nothing to change" ;;
        Unmanaged|Removed)
            log "kube-vip: already $kube_vip in the ReleaseManifest" ;;
        Managed)
            log "kube-vip: management Unmanaged in the ReleaseManifest, so that the" \
                "k4all-operator never rewrites its manifest"
            run kubectl --kubeconfig "$KC" patch releasemanifest k4all --type merge \
                -p "$KUBE_VIP_UNMANAGED" \
                || echo "[k4all-bridge] WARNING: could not set kube-vip Unmanaged;" \
                        "see docs/upgrades.md (kube-vip on HA clusters)" >&2 ;;
        *)
            echo "[k4all-bridge] WARNING: cannot read the ReleaseManifest; set" \
                 "kube-vip Unmanaged by hand: kubectl patch releasemanifest k4all" \
                 "--type merge -p '$KUBE_VIP_UNMANAGED'" >&2 ;;
    esac
fi

# --- 4. stop unattended reboots, then stage the bridge --------------------------
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

# Before the reboot: stop kubelet, then every pod. Otherwise the shutdown
# waits for each container's own grace period: ingress-nginx (300 s and a
# preStop hook) held reboots for 4 minutes in the lab. Each pod gets its own
# terminationGracePeriodSeconds (kubelet's annotation on its containers), at
# least POD_STOP_SECONDS and at most POD_STOP_MAX_SECONDS: with 30 s for
# every pod a VM's guest lost QEMU halfway through its shutdown (k4all#98).
# CRI-O takes crictl's --timeout as the deadline of the stop, keeps 2 s of it
# for the call and the infra container, and stops the containers of a pod in
# parallel; one crictl per pod, all at once. It tears the pod's network down
# first, so the pods on the pod network stop first, then the ones on the host
# network (the CNI agent, the static pods): with the agent stopping at the
# same time the teardown failed and left the containers alone. A stop that
# failed is tried again while the pod has time left (3 tries at most). The
# reboot waits at most twice POD_STOP_MAX_SECONDS. Listing the pods changes
# nothing, so a dry run lists them too.
stop_pods() {
    local crictl="crictl --runtime-endpoint unix:///run/crio/crio.sock" pods graces plan
    local networks host_pods
    log "stopping kubelet and the pods (each within its grace period: at least" \
        "${POD_STOP_SECONDS} s, at most ${POD_STOP_MAX_SECONDS} s)"
    run systemctl stop kubelet || true
    command -v crictl >/dev/null || return 0
    pods=$($crictl pods -q --state ready 2>/dev/null || true)
    [ -n "$pods" ] || return 0
    # "<pod id> <grace>" of each running container
    graces=$($crictl ps -o json 2>/dev/null | jq -r '.containers[]? | "\(.podSandboxId) \(
        .annotations["io.kubernetes.pod.terminationGracePeriod"] // "")"' 2>/dev/null) \
        || graces=unreadable
    if [ "$graces" = unreadable ]; then
        log "cannot read the grace periods of the pods: each gets up to ${POD_STOP_MAX_SECONDS} s"
    fi
    plan=$(for pod in $pods; do
        if [ "$graces" = unreadable ]; then
            echo "$POD_STOP_MAX_SECONDS $pod"
        else
            echo "$graces" | awk -v id="$pod" -v lo="$POD_STOP_SECONDS" \
                -v hi="$POD_STOP_MAX_SECONDS" '
                $1 == id && $2 ~ /^[0-9]+$/ && $2 + 0 > g { g = $2 + 0 }
                END { s = g < lo ? lo : g; print (s > hi ? hi : s), id }'
        fi
    done)
    # "<pod id> <NODE|POD>" of each pod: NODE is the host network
    # shellcheck disable=SC2086 # one argument per pod id
    if networks=$($crictl inspectp -o json $pods 2>/dev/null | jq -r 'if type == "array"
            then .[] else . end | "\(.status.id) \(.status.linux.namespaces.options.network // "")"' \
            2>/dev/null); then
        host_pods=$(echo "$networks" | awk '$2 == "NODE" { printf "%s ", $1 }')
    else
        log "cannot tell which pods are on the host network: every pod stops at once"
        host_pods=""
    fi
    stop_phase "$(echo "$plan" | awk -v host="$host_pods" '
        BEGIN { n = split(host, h, " "); for (i = 1; i <= n; i++) skip[h[i]] = 1 }
        !($2 in skip)')"
    stop_phase "$(echo "$plan" | awk -v host="$host_pods" '
        BEGIN { n = split(host, h, " "); for (i = 1; i <= n; i++) keep[h[i]] = 1 }
        $2 in keep')"
}

# stop_phase PLAN: stop the pods of PLAN ("<seconds> <pod id>" lines) at once.
stop_phase() {
    local crictl="crictl --runtime-endpoint unix:///run/crio/crio.sock"
    [ -n "$1" ] || return 0
    if [ "$DRY_RUN" = true ]; then
        echo "$1" | while read -r seconds pod; do
            log "would run: $crictl --timeout=$((seconds + 2))s stopp $pod"
        done
        return 0
    fi
    echo "$1" | xargs -r -n 2 -P 0 sh -c \
        "end=\$((\$(date +%s) + \$0)); t=\$((\$0 + 2)); n=0; while [ \$n -lt 3 ]; do n=\$((n + 1));
         $crictl --timeout=\${t}s stopp \"\$1\" >/dev/null 2>&1 && break;
         t=\$((end - \$(date +%s) + 1)); [ \$t -gt 2 ] || break; sleep 1; done" || true
}

if [ "$NOW" = true ]; then
    # Staged first, then the reboot: the pods keep running during the download.
    log "switching to $BRIDGE_IMAGE"
    bootc_unit switch "$BRIDGE_IMAGE"
    stop_pods
    log "rebooting into the bridge"
    run systemctl reboot
else
    log "staging $BRIDGE_IMAGE for the next reboot"
    bootc_unit switch "$BRIDGE_IMAGE"
    if [ "$DRY_RUN" = true ]; then
        log "dry run: nothing changed. Without --now the bridge waits for the" \
            "next reboot; with --now it switches and reboots right away"
    else
        log "done. Reboot when convenient: systemctl reboot"
    fi
fi
if [ "$DRY_RUN" = true ] && [ "$NOW" = true ]; then
    log "dry run: nothing changed"
fi
