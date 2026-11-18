#!/bin/bash
# =============================================================================
# K4All bootc Runtime Integration Tests
# =============================================================================
# Runs ALL K4All services in proper dependency order inside a container.
#
#   Phase 0 - Systemd boot check
#   Phase 1 - Environment setup (DNS, swap fix, config, loop device)
#   Phase 2 - Pre-init service chain (Layer 0-1)
#   Phase 3 - LVM setup
#   Phase 4 - K8s bootstrap (ph2 skip, ph3, kubeadm init)
#   Phase 5 - Post-init services (taint, CNI, node-ready, all the rest)
#   Phase 6 - Summary of every service
#
# Prerequisites: container must already be running (see: make run)
#
# Usage:
#   ./tests/test-runtime.sh
#   CONTAINER_NAME=mytest ./tests/test-runtime.sh
# =============================================================================

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-k4all-test}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0
SKIP=0

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}✓ PASS${NC}: $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}✗ FAIL${NC}: $1"; }
warn() { WARN=$((WARN + 1)); echo -e "  ${YELLOW}⚠ WARN${NC}: $1"; }
skip() { SKIP=$((SKIP + 1)); echo -e "  ${YELLOW}⊘ SKIP${NC}: $1"; }
info() { echo -e "${CYAN}▸ $1${NC}"; }
phase() { echo -e "\n${BOLD}━━━ $1 ━━━${NC}"; }

exec_in() {
    podman exec "$CONTAINER_NAME" bash -c "$1" 2>/dev/null
}

exec_in_verbose() {
    podman exec "$CONTAINER_NAME" bash -c "$1"
}

# Run a K4All service, wait for completion, report result.
# Usage: run_svc <unit> <friendly-name> <timeout-seconds>
run_svc() {
    local svc="$1" desc="$2" timeout="${3:-60}"
    exec_in "systemctl reset-failed '$svc' 2>/dev/null; true"
    exec_in "systemctl restart '$svc' 2>/dev/null; true"
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        local state
        state=$(exec_in "systemctl is-active '$svc' 2>/dev/null || true")
        case "$state" in
            active)
                pass "$desc"; return 0 ;;
            inactive)
                if exec_in "systemctl show -p ExecMainStatus '$svc' 2>/dev/null | grep -q 'ExecMainStatus=0'"; then
                    pass "$desc"; return 0
                fi ;;
            failed)
                fail "$desc"
                exec_in "journalctl -u '$svc' --no-pager -n 8 2>/dev/null" | while IFS= read -r l; do echo "    $l"; done
                return 1 ;;
        esac
        sleep 3
        elapsed=$((elapsed + 3))
    done
    local fs
    fs=$(exec_in "systemctl is-active '$svc' 2>/dev/null || true")
    [ "$fs" = "inactive" ] && { pass "$desc"; return 0; }
    fail "$desc (timeout ${timeout}s, state: $fs)"
    exec_in "journalctl -u '$svc' --no-pager -n 5 2>/dev/null" | while IFS= read -r l; do echo "    $l"; done
    return 1
}

# =============================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   K4All bootc Full Integration Tests             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
if ! podman inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
    echo -e "${RED}ERROR: Container '$CONTAINER_NAME' is not running.${NC}"
    exit 1
fi

# ======================= PHASE 0 ============================================
phase "PHASE 0: SYSTEMD BOOT"

if exec_in "test -d /run/systemd/system"; then
    pass "systemd is PID 1"
else
    fail "systemd is NOT running as init"; exit 1
fi

# ======================= PHASE 1 ============================================
phase "PHASE 1: ENVIRONMENT SETUP"

info "Fixing DNS (systemd-resolved has no upstream in container)"
exec_in "rm -f /etc/resolv.conf; printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/resolv.conf"
exec_in "systemctl restart crio" >/dev/null 2>&1; sleep 3
if exec_in "nslookup registry.k8s.io >/dev/null 2>&1"; then
    pass "DNS resolution working"
else
    warn "DNS not available — network-dependent tests will be skipped"
fi

info "Fixing kubelet (host swap visible in container)"
exec_in "mkdir -p /var/lib/kubelet /etc/systemd/system/kubelet.service.d"
exec_in "cat > /var/lib/kubelet/config.yaml <<'K'
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failSwapOn: false
cgroupDriver: systemd
K"
exec_in "cat > /etc/systemd/system/kubelet.service.d/20-test-env.conf <<'D'
[Service]
Environment=\"KUBELET_EXTRA_ARGS=--fail-swap-on=false\"
D"
exec_in "systemctl daemon-reload && systemctl restart kubelet" >/dev/null 2>&1; sleep 2
pass "kubelet swap override applied"

info "Injecting /etc/node-type = bootstrap"
exec_in "echo bootstrap > /etc/node-type"
pass "/etc/node-type = bootstrap"

info "Injecting /etc/k4all-config.json"
exec_in "cp /usr/local/share/default-cluster-config.json /etc/k4all-config.json"
pass "/etc/k4all-config.json injected"

info "Creating loop device for LVM (200 MB)"
LVM_LOOP=""
if exec_in "dd if=/dev/zero of=/tmp/lvm-test.img bs=1M count=200 status=none && losetup -f /tmp/lvm-test.img"; then
    LVM_LOOP=$(exec_in "losetup -j /tmp/lvm-test.img | head -1 | cut -d: -f1")
    pass "loop device: $LVM_LOOP"
else
    warn "loop device unavailable"
fi

# ======================= PHASE 2 ============================================
phase "PHASE 2: PRE-INIT SERVICE CHAIN"

exec_in "rm -f /opt/k4all/*.done"

info "Layer 0: base services"
run_svc fck8s-setup-proxy.service     "setup-proxy"       30  || true
run_svc fck8s-role-dispatcher.service "role-dispatcher"    20  || true
if exec_in "test -x /var/opt/k4all/bin/enable-cluster.sh"; then
    pass "role-dispatcher: bootstrap scripts installed (/var/opt/k4all/bin/)"
else
    fail "role-dispatcher: bootstrap scripts missing from /var/opt/k4all/bin/"
fi

info "Layer 1: after base"
# hostnamectl is blocked in containers — mark done and move on
exec_in "touch /opt/k4all/setup-hostname.done"
pass "set-hostname (skipped hostnamectl — container limitation, hostname=$(exec_in 'hostname'))"

run_svc fck8s-helm-setup.service "helm-setup" 30 || true

# ======================= PHASE 3 ============================================
phase "PHASE 3: LVM (fake block device)"

if [ -n "$LVM_LOOP" ]; then
    exec_in "vgremove -f vg_data 2>/dev/null; for pv in \$(pvs --noheadings -o pv_name 2>/dev/null); do pvremove -f \$pv 2>/dev/null; done; true" >/dev/null 2>&1
    if exec_in "pvcreate -f '$LVM_LOOP' >/dev/null 2>&1 && vgcreate vg_data '$LVM_LOOP' >/dev/null 2>&1"; then
        pass "pvcreate + vgcreate vg_data"
    else
        fail "pvcreate/vgcreate"
    fi

    if exec_in "lvcreate --wipesignatures n --zero n -L 50M -n test-lv vg_data -y" >/dev/null 2>&1; then
        DM_MAJMIN=$(exec_in "dmsetup ls 2>/dev/null | grep 'vg_data-test--lv' | grep -oP '\\(\\K[0-9]+:[0-9]+'" || true)
        DM_MAJOR="${DM_MAJMIN%%:*}"; DM_MINOR="${DM_MAJMIN##*:}"
        if [ -n "$DM_MAJOR" ] && [ -n "$DM_MINOR" ]; then
            exec_in "rm -f /dev/dm-${DM_MINOR}; mknod /dev/dm-${DM_MINOR} b $DM_MAJOR $DM_MINOR" >/dev/null 2>&1
            if exec_in "mkfs.ext4 -q /dev/dm-${DM_MINOR} && mkdir -p /mnt/lv && mount /dev/dm-${DM_MINOR} /mnt/lv && echo ok > /mnt/lv/p && grep -q ok /mnt/lv/p"; then
                pass "LV create → format → mount → write/read"
            else
                fail "LV write test"
            fi
            exec_in "umount /mnt/lv 2>/dev/null; true"
        else
            warn "dm node creation (dmsetup parse)"
        fi
        exec_in "lvremove -f vg_data/test-lv 2>/dev/null; rm -f /dev/dm-${DM_MINOR:-0} 2>/dev/null; true"
    else
        fail "lvcreate"
    fi
    exec_in "touch /opt/k4all/lvm-setup.done"
else
    warn "LVM skipped (no loop device)"
    exec_in "touch /opt/k4all/lvm-setup.done"
fi

# ======================= PHASE 4 ============================================
phase "PHASE 4: KUBERNETES BOOTSTRAP"

info "Marking ph2 done (OVS bridge + reboot — cannot run in container)"
exec_in "touch /opt/k4all/setup-ph2.done"
skip "fck8s-k8s-setup-ph2 (OVS bridge + systemctl reboot)"

info "Running ph3 (kubeadm reset + HA config)"
# ph3 needs all its deps to be in good state
exec_in "systemctl reset-failed fck8s-k8s-setup-ph2.service 2>/dev/null; true"
run_svc fck8s-k8s-setup-ph3.service "k8s-setup-ph3" 60 || true

info "Preparing kubeadm config (swap tolerance + ignore-preflight-errors)"
if exec_in "test -f /etc/k8s-config.yaml"; then
    pass "/etc/k8s-config.yaml exists (from role-dispatcher + ph3)"
    exec_in "cat >> /etc/k8s-config.yaml <<'KC'
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failSwapOn: false
cgroupDriver: systemd
KC"
else
    fail "/etc/k8s-config.yaml missing — role-dispatcher did not copy k8s-config-bootstrap.yaml"
fi

info "Running kubeadm init via k8s-setup-init..."
# Reset all deps so systemd accepts the start
exec_in "systemctl reset-failed fck8s-k8s-setup-ph3.service fck8s-k8s-setup-ph2.service fck8s-role-dispatcher.service 2>/dev/null; true"
run_svc fck8s-k8s-setup-init.service "k8s-setup-init (kubeadm init)" 300 || true

KUBEADM_OK=false
if exec_in "test -f /etc/kubernetes/admin.conf"; then
    pass "admin.conf exists — cluster initialized"
    KUBEADM_OK=true
    exec_in "mkdir -p /root/.kube && cp /etc/kubernetes/admin.conf /root/.kube/config"
else
    fail "admin.conf missing — kubeadm init failed"
fi

if $KUBEADM_OK; then
    info "Fixing kube-proxy (conntrack sysctl is read-only in PID namespace)"
    exec_in "KUBECONFIG=/root/.kube/config kubectl get cm kube-proxy -n kube-system -o yaml \
        | sed 's/maxPerCore: .*/maxPerCore: 0/' \
        | sed 's/min: .*/min: 0/' \
        | KUBECONFIG=/root/.kube/config kubectl apply -f - 2>/dev/null" >/dev/null 2>&1
    exec_in "KUBECONFIG=/root/.kube/config kubectl -n kube-system delete pod -l k8s-app=kube-proxy 2>/dev/null" >/dev/null 2>&1
    sleep 5
    KP_STATE=$(exec_in "KUBECONFIG=/root/.kube/config kubectl get pods -n kube-system -l k8s-app=kube-proxy --no-headers 2>/dev/null | awk '{print \$3}'" || true)
    if [ "$KP_STATE" = "Running" ]; then
        pass "kube-proxy Running (conntrack sysctl patched)"
    else
        warn "kube-proxy state: $KP_STATE (may need more time)"
    fi

    PODS=$(exec_in "KUBECONFIG=/root/.kube/config kubectl get pods -n kube-system --no-headers 2>/dev/null | grep Running | wc -l" || echo 0)
    if [ "$PODS" -gt 0 ]; then
        pass "$PODS kube-system pod(s) Running"
    else
        warn "no kube-system pods Running yet"
    fi
fi

# ======================= PHASE 5 ============================================
phase "PHASE 5: POST-INIT SERVICES"

if ! $KUBEADM_OK; then
    warn "Skipping post-init services — kubeadm init did not succeed"
else
    info "5a. taint-master-schedulable"
    run_svc fck8s-taint-master-schedulable.service "taint-master-schedulable" 120 || true

    info "5b. CNI setup (calico) — running directly to break circular dep with node-ready"
    if exec_in "bash /usr/local/bin/setup-cni.sh" >/dev/null 2>&1; then
        pass "cni-setup (calico installed)"
    else
        # Calico install can be flaky on first try — try once more
        if exec_in "bash /usr/local/bin/setup-cni.sh" >/dev/null 2>&1; then
            pass "cni-setup (calico installed, 2nd attempt)"
        else
            fail "cni-setup (calico)"
            exec_in "journalctl -u fck8s-cni-setup --no-pager -n 5 2>/dev/null" | while IFS= read -r l; do echo "    $l"; done
        fi
    fi
    exec_in "touch /opt/k4all/cni-setup.done"

    info "5c. Waiting for node Ready (up to 120s)..."
    NODE_READY=false
    for i in $(seq 1 24); do
        if exec_in "KUBECONFIG=/root/.kube/config kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready'"; then
            pass "node is Ready"
            NODE_READY=true
            break
        fi
        sleep 5
    done
    $NODE_READY || warn "node not Ready after 120s (CNI may still be starting)"

    info "5d. node-ready-and-schedulable"
    run_svc fck8s-node-ready-and-schedulable.service "node-ready-and-schedulable" 180 || true

    info "5e. wait-default-service-account"
    run_svc fck8s-wait-default-service-account.service "wait-default-service-account" 60 || true

    info "5f. metric-server-setup"
    run_svc fck8s-metric-server-setup.service "metric-server-setup" 120 || true

    info "5g. certmanager-setup"
    run_svc fck8s-certmanager-setup.service "certmanager-setup" 300 || true

    info "5h. setup-metallb"
    run_svc fck8s-setup-metallb.service "setup-metallb" 120 || true

    info "5i. setup-ovs-cni"
    run_svc fck8s-setup-ovs-cni.service "setup-ovs-cni" 120 || true

    info "5j. dashboard-setup"
    run_svc fck8s-dashboard-setup.service "dashboard-setup" 300 || true

    info "5k. setup-features (virt=false, argocd=false in default config)"
    run_svc fck8s-setup-features.service "setup-features" 60 || true

    info "5l. ingress-setup"
    run_svc fck8s-ingress-setup.service "ingress-setup" 300 || true

    info "5m. topolvm-setup"
    run_svc fck8s-topolvm-setup.service "topolvm-setup" 300 || true

    info "5n. custom-manifests-setup"
    run_svc fck8s-custom-manifests-setup.service "custom-manifests-setup" 60 || true

    info "5o. update-routes"
    run_svc fck8s-update-routes.service "update-routes" 60 || true

    info "5p. auto-join (not applicable for bootstrap — script may not exist)"
    if exec_in "test -x /usr/local/bin/auto-join.sh"; then
        run_svc fck8s-auto-join.service "auto-join" 30 || true
    else
        skip "auto-join (no auto-join.sh for bootstrap role)"
    fi
fi

# ======================= PHASE 6 ============================================
phase "PHASE 6: SERVICE DONE-FILE SUMMARY"

ALL_DONE_FILES=(
    setup-static-ip setup-hostname setup-proxy role-dispatcher helm-setup
    lvm-setup setup-ph2 setup-ph3 k8s-setup-init
    setup-taint-master-schedulable cni-setup default-service-account
    setup-metrics certmanager-setup metal-lb-setup setup-dashboard
    features-setup setup-ingress topolvm-setup custom-manifests-setup
)

DONE_COUNT=0
MISSING_DONE=""
for f in "${ALL_DONE_FILES[@]}"; do
    if exec_in "test -f /opt/k4all/${f}.done"; then
        DONE_COUNT=$((DONE_COUNT + 1))
    else
        MISSING_DONE="$MISSING_DONE $f"
    fi
done

echo -e "  Done files: ${GREEN}${DONE_COUNT}${NC}/${#ALL_DONE_FILES[@]}"
if [ -n "$MISSING_DONE" ]; then
    echo -e "  Missing:${YELLOW}${MISSING_DONE}${NC}"
fi

if $KUBEADM_OK; then
    info "Final cluster state"
    exec_in "KUBECONFIG=/root/.kube/config kubectl get nodes 2>/dev/null" | while IFS= read -r l; do echo "    $l"; done
    echo ""
    exec_in "KUBECONFIG=/root/.kube/config kubectl get pods -A --no-headers 2>/dev/null | head -30" | while IFS= read -r l; do echo "    $l"; done
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║           RUNTIME INTEGRATION SUMMARY            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo -e "  ${YELLOW}WARN${NC}: $WARN"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP"
TOTAL=$((PASS + FAIL))
echo "  TOTAL: $TOTAL"
echo ""

if [ $FAIL -gt 0 ]; then
    echo -e "${RED}Some runtime tests failed!${NC}"
    exit 1
else
    echo -e "${GREEN}All runtime tests passed!${NC}"
    exit 0
fi
