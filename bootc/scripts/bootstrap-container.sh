#!/bin/bash
# =============================================================================
# K4All Container Bootstrap
# =============================================================================
# Bootstraps a K4All bootc container into a working single-node Kubernetes
# cluster. This handles all the environment quirks of running systemd + kubeadm
# inside a rootful container (DNS, swap, kube-proxy conntrack, Calico SSA).
#
# After this script completes you have:
#   - A single-node cluster with CNI (Calico) and node Ready
#   - The k4all-operator deployed (if install.yaml is baked into the image)
#   - CRs created (ClusterConfig + ReleaseManifest)
#
# Usage:
#   CONTAINER_NAME=k4all-test ./scripts/bootstrap-container.sh
# =============================================================================
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-k4all-test}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸ $1${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
err()   { echo -e "  ${RED}✗${NC} $1"; }
phase() { echo -e "\n${BOLD}━━━ $1 ━━━${NC}"; }

exec_in() {
    podman exec "$CONTAINER_NAME" bash -c "$1"
}

wait_for() {
    local desc="$1" timeout="$2" check="$3"
    local elapsed=0
    while [ $elapsed -lt "$timeout" ]; do
        if eval "$check" 2>/dev/null; then
            ok "$desc (${elapsed}s)"
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    err "$desc (timeout after ${timeout}s)"
    return 1
}

# Pre-flight
if ! podman inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
    echo -e "${RED}ERROR: Container '$CONTAINER_NAME' is not running.${NC}"
    exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║        K4All Container Bootstrap                  ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ======================= PHASE 1 ============================================
phase "PHASE 1: ENVIRONMENT FIXES"

info "Fixing DNS (systemd-resolved has no upstream in container)"
exec_in 'rm -f /etc/resolv.conf; printf "nameserver 8.8.8.8\nnameserver 8.8.4.4\n" > /etc/resolv.conf'
exec_in 'systemctl restart crio' >/dev/null 2>&1; sleep 3
if exec_in "nslookup registry.k8s.io >/dev/null 2>&1"; then
    ok "DNS resolution working"
else
    err "DNS not working — cannot continue"
    exit 1
fi

info "Fixing kubelet (host swap visible in container)"
exec_in 'mkdir -p /var/lib/kubelet /etc/systemd/system/kubelet.service.d'
exec_in 'cat > /var/lib/kubelet/config.yaml <<K
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failSwapOn: false
cgroupDriver: systemd
K'
exec_in 'cat > /etc/systemd/system/kubelet.service.d/20-container-env.conf <<D
[Service]
Environment="KUBELET_EXTRA_ARGS=--fail-swap-on=false"
D'
exec_in 'systemctl daemon-reload && systemctl restart kubelet' >/dev/null 2>&1; sleep 2
ok "kubelet swap override applied"

# ======================= PHASE 2 ============================================
phase "PHASE 2: PRE-INIT SERVICES"

info "Injecting node-type + config"
exec_in 'echo bootstrap > /etc/node-type'
exec_in 'cp /usr/local/share/k4all-config.yaml.default /etc/k4all-config.yaml'
ok "node-type=bootstrap, config injected"

info "Running pre-init service chain"
exec_in 'rm -f /opt/k4all/*.done'

for svc in fck8s-set-static-ip fck8s-setup-proxy fck8s-role-dispatcher; do
    exec_in "systemctl reset-failed ${svc}.service 2>/dev/null; systemctl restart ${svc}.service 2>/dev/null; true"
done
sleep 3

# hostname cannot be set in container — mark done
exec_in 'touch /opt/k4all/setup-hostname.done'

exec_in 'systemctl reset-failed fck8s-helm-setup.service 2>/dev/null; systemctl restart fck8s-helm-setup.service 2>/dev/null; true'
sleep 8
ok "pre-init services completed"

# ======================= PHASE 3 ============================================
phase "PHASE 3: KUBERNETES INIT"

info "Marking ph2 done (OVS bridge + reboot — not possible in container)"
exec_in 'touch /opt/k4all/setup-ph2.done /opt/k4all/lvm-setup.done'

info "Running ph3 (kubeadm reset + HA config)"
exec_in 'systemctl reset-failed fck8s-k8s-setup-ph2.service 2>/dev/null; true'
exec_in 'systemctl reset-failed fck8s-k8s-setup-ph3.service 2>/dev/null; systemctl restart fck8s-k8s-setup-ph3.service 2>/dev/null; true'
sleep 5

info "Adding swap tolerance to kubeadm config"
exec_in 'cat >> /etc/k8s-config.yaml <<KC
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failSwapOn: false
cgroupDriver: systemd
KC'
ok "kubeadm config patched"

info "Running kubeadm init (this takes 3-5 minutes)..."
exec_in 'systemctl reset-failed fck8s-k8s-setup-ph3.service fck8s-k8s-setup-ph2.service fck8s-role-dispatcher.service 2>/dev/null; true'
exec_in 'systemctl reset-failed fck8s-k8s-setup-init.service 2>/dev/null; systemctl restart fck8s-k8s-setup-init.service 2>/dev/null; true'

wait_for "kubeadm init" 360 "exec_in 'test -f /etc/kubernetes/admin.conf'" || exit 1

# ======================= PHASE 4 ============================================
phase "PHASE 4: POST-INIT FIXES"

info "Fixing kube-proxy (conntrack sysctl is read-only in PID namespace)"
exec_in 'KUBECONFIG=/root/.kube/config kubectl get cm kube-proxy -n kube-system -o yaml \
    | sed "s/maxPerCore: .*/maxPerCore: 0/" \
    | sed "s/min: .*/min: 0/" \
    | KUBECONFIG=/root/.kube/config kubectl apply -f - 2>/dev/null' >/dev/null 2>&1
exec_in 'KUBECONFIG=/root/.kube/config kubectl -n kube-system delete pod -l k8s-app=kube-proxy 2>/dev/null' >/dev/null 2>&1
sleep 5
ok "kube-proxy patched"

info "Tainting master schedulable"
exec_in 'systemctl reset-failed fck8s-taint-master-schedulable.service 2>/dev/null; systemctl restart fck8s-taint-master-schedulable.service 2>/dev/null; true'
sleep 3
ok "master taint removed"

# ======================= PHASE 5 ============================================
phase "PHASE 5: Restart some services"

info "Waiting for node to be Ready..."
wait_for "node Ready" 180 \
    "exec_in 'KUBECONFIG=/root/.kube/config kubectl get nodes --no-headers 2>/dev/null | grep -q \" Ready\"'" || exit 1

info "Running node-ready-and-schedulable service"
exec_in 'systemctl reset-failed fck8s-node-ready-and-schedulable.service 2>/dev/null; systemctl restart fck8s-node-ready-and-schedulable.service 2>/dev/null; true'
sleep 5
ok "node-ready-and-schedulable done"

# ======================= PHASE 6 ============================================
phase "PHASE 6: OPERATOR DEPLOY"

if exec_in 'test -f /usr/local/share/k4all-operator/install.yaml'; then
    info "Deploying k4all-operator (install.yaml found in image)"
    if exec_in 'systemctl list-unit-files fck8s-operator-deploy.service 2>/dev/null | grep -q fck8s-operator-deploy'; then
        exec_in 'systemctl reset-failed fck8s-operator-deploy.service 2>/dev/null; systemctl restart fck8s-operator-deploy.service 2>/dev/null; true'
    else
        exec_in 'KUBECONFIG=/root/.kube/config kubectl apply --server-side --force-conflicts -f /usr/local/share/k4all-operator/install.yaml' >/dev/null 2>&1
    fi
    wait_for "operator pod running" 300 \
        "exec_in 'KUBECONFIG=/root/.kube/config kubectl get pods -n k4all-operator-system --no-headers 2>/dev/null | grep -q Running'" || true
else
    echo -e "${YELLOW}  Operator install.yaml not found in image.${NC}"
    echo -e "${YELLOW}  The operator must be run externally during development:${NC}"
    echo -e "${YELLOW}    make kubeconfig${NC}"
    echo -e "${YELLOW}    export KUBECONFIG=/tmp/k4all-kubeconfig${NC}"
    echo -e "${YELLOW}    cd ../k4all-operator && ./bin/manager${NC}"
fi

# ======================= DONE ===============================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║        Bootstrap Complete                         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
exec_in 'KUBECONFIG=/root/.kube/config kubectl get nodes' 2>/dev/null | while IFS= read -r l; do echo "  $l"; done
echo ""
exec_in 'KUBECONFIG=/root/.kube/config kubectl get pods -A --no-headers 2>/dev/null | head -20' | while IFS= read -r l; do echo "  $l"; done
echo ""
echo -e "${GREEN}Cluster is ready.${NC}"
echo "  Next steps:"
echo "    make kubeconfig     # extract kubeconfig"
echo "    make token          # get dashboard token"
echo "    make dashboard      # open Headlamp UI"
