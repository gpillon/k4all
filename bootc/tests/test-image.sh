#!/bin/bash
# =============================================================================
# K4All bootc Image Validation Tests
# =============================================================================
# This script builds the K4All bootc image and validates its contents
# by running a container and checking packages, scripts, systemd units, etc.
#
# Usage:
#   ./tests/test-image.sh                # Build + test
#   ./tests/test-image.sh --skip-build   # Test existing image
#   IMAGE_NAME=myimage IMAGE_TAG=dev ./tests/test-image.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_NAME="${IMAGE_NAME:-k4all-bootc-test}"
IMAGE_TAG="${IMAGE_TAG:-test}"
FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
SKIP_BUILD="${1:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

pass() { ((PASS++)); echo -e "  ${GREEN}✓ PASS${NC}: $1"; }
fail() { ((FAIL++)); echo -e "  ${RED}✗ FAIL${NC}: $1"; }
warn() { ((WARN++)); echo -e "  ${YELLOW}⚠ WARN${NC}: $1"; }
info() { echo -e "${CYAN}▸ $1${NC}"; }

# Run a command inside the test container
run_in_container() {
    podman run --rm --entrypoint="" "$FULL_IMAGE" bash -c "$1"
}

# Check if a command exists in the container
check_command() {
    local cmd="$1"
    local desc="${2:-$cmd is installed}"
    if run_in_container "command -v $cmd &>/dev/null" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# Check if a file exists in the container
check_file() {
    local path="$1"
    local desc="${2:-$path exists}"
    if run_in_container "test -f '$path'" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# Check if a file is executable
check_executable() {
    local path="$1"
    local desc="${2:-$path is executable}"
    if run_in_container "test -x '$path'" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# Check if a directory exists
check_dir() {
    local path="$1"
    local desc="${2:-$path exists}"
    if run_in_container "test -d '$path'" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# Check if a systemd unit is enabled
check_unit_enabled() {
    local unit="$1"
    local desc="${2:-systemd unit $unit is enabled}"
    if run_in_container "systemctl is-enabled '$unit' 2>/dev/null | grep -qE 'enabled|static'" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# Check if a systemd unit file exists
check_unit_file() {
    local unit="$1"
    local desc="${2:-systemd unit file $unit exists}"
    if run_in_container "test -f '/etc/systemd/system/$unit'" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# Check file contains a string
check_file_contains() {
    local path="$1"
    local pattern="$2"
    local desc="${3:-$path contains '$pattern'}"
    if run_in_container "grep -q '$pattern' '$path'" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# =============================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   K4All bootc Image Validation Tests             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Build image if needed
if [ "$SKIP_BUILD" != "--skip-build" ]; then
    info "Building test image: $FULL_IMAGE"
    cd "$BOOTC_DIR"
    podman build --tag "$FULL_IMAGE" --file Containerfile . 2>&1 | tail -5
    echo ""
fi

# Verify image exists
if ! podman image exists "$FULL_IMAGE" 2>/dev/null; then
    echo -e "${RED}ERROR: Image $FULL_IMAGE not found. Run without --skip-build.${NC}"
    exit 1
fi

# =============================================================================
info "1. PACKAGES - Kubernetes components"
# =============================================================================
check_command "kubeadm"  "kubeadm is installed"
check_command "kubelet"  "kubelet is installed"
check_command "kubectl"  "kubectl is installed"

info "2. PACKAGES - Container runtime"
check_command "crio"     "CRI-O is installed (crio binary)"

info "3. PACKAGES - Networking"
check_command "ovs-vsctl"       "Open vSwitch is installed"
check_command "nmcli"           "NetworkManager is installed"

info "4. PACKAGES - Tools"
check_command "helm"            "Helm is installed"
check_command "jq"              "jq is installed"
check_command "yq"              "yq is installed"
check_command "lvm"             "LVM2 is installed"
check_command "openssl"         "OpenSSL is installed"
check_command "curl"            "curl is installed"
check_command "git"             "git is installed"

info "5. PACKAGES - HA / Firewall"
check_command "keepalived"      "keepalived is installed"
check_command "firewall-cmd"    "firewalld is installed"

# =============================================================================
echo ""
info "6. SCRIPTS - Core scripts in /usr/local/bin/"
# =============================================================================
CORE_SCRIPTS=(
    setup-lvm.sh
    setup-proxy.sh
    set-static-ip.sh
    set-hostname.sh
    setup-k8s-ph1.sh
    setup-k8s-ph2.sh
    setup-helm.sh
    setup-cni.sh
    setup-cni-calico.sh
    setup-cni-cilium.sh
    setup-certmanager.sh
    setup-dashboard.sh
    setup-ingress.sh
    setup-metrics.sh
    setup-metallb.sh
    setup-topolvm.sh
    setup-ovs-cni.sh
    setup-features.sh
    setup-feature-virt.sh
    setup-feature-argocd.sh
    setup-custom-manifests.sh
    setup-taint-master-scheduleable.sh
    node-ready-and-schedulable.sh
    wait-default-service-account.sh
    update-routes.sh
    update-node.sh
    reinstall.sh
    k4all-role-dispatcher.sh
    k4all-utils
    install-status.sh
    check-ip.sh
    disk-helper.sh
)

for script in "${CORE_SCRIPTS[@]}"; do
    check_executable "/usr/local/bin/$script" "$script is executable"
done

# =============================================================================
echo ""
info "7. SCRIPTS - Override scripts (role-specific)"
# =============================================================================
OVERRIDE_SCRIPTS=(
    "overrides/bootstrap/setup-k8s-init.sh"
    "overrides/bootstrap/enable-cluster.sh"
    "overrides/bootstrap/generate-kubelet-config.sh"
    "overrides/bootstrap-control/setup-k8s-ph3.sh"
    "overrides/bootstrap-control/check-advertise-address.sh"
    "overrides/bootstrap-control/generate_join.sh"
    "overrides/control/setup-k8s-init.sh"
    "overrides/control/join_cluster.sh"
    "overrides/worker/setup-k8s-init.sh"
    "overrides/worker/setup-k8s-ph3.sh"
    "overrides/worker/join_cluster.sh"
    "overrides/control-worker/auto-join.sh"
)

for script in "${OVERRIDE_SCRIPTS[@]}"; do
    check_executable "/usr/local/bin/$script" "override: $script is executable"
done

# =============================================================================
echo ""
info "8. SYSTEMD UNITS - Unit files exist"
# =============================================================================
UNITS=(
    fck8s-role-dispatcher.service
    fck8s-set-static-ip.service
    fck8s-set-hostname.service
    fck8s-setup-proxy.service
    fck8s-k8s-setup-ph2.service
    fck8s-k8s-setup-ph3.service
    fck8s-k8s-setup-init.service
    fck8s-lvm-setup.service
    fck8s-helm-setup.service
    fck8s-node-ready-and-schedulable.service
    fck8s-taint-master-schedulable.service
    fck8s-cni-setup.service
    fck8s-metric-server-setup.service
    fck8s-dashboard-setup.service
    fck8s-ingress-setup.service
    fck8s-certmanager-setup.service
    fck8s-topolvm-setup.service
    fck8s-setup-ovs-cni.service
    fck8s-setup-metallb.service
    fck8s-setup-features.service
    fck8s-custom-manifests-setup.service
    fck8s-wait-default-service-account.service
    fck8s-auto-join.service
    fck8s-update-routes.service
    fck8s-update-routes.timer
)

for unit in "${UNITS[@]}"; do
    check_unit_file "$unit"
done

# =============================================================================
echo ""
info "9. SYSTEMD - Core services enabled"
# =============================================================================
check_unit_enabled "crio.service"           "CRI-O service is enabled"
check_unit_enabled "kubelet.service"        "kubelet service is enabled"
check_unit_enabled "openvswitch.service"    "Open vSwitch service is enabled"

# =============================================================================
echo ""
info "10. SYSTEMD - K4All services enabled"
# =============================================================================
for unit in "${UNITS[@]}"; do
    check_unit_enabled "$unit" "K4All unit $unit is enabled"
done

# =============================================================================
echo ""
info "11. SYSTEMD - Dependency chain validation"
# =============================================================================
# Check that ph3 and init depend on role-dispatcher
check_file_contains "/etc/systemd/system/fck8s-k8s-setup-ph3.service" \
    "fck8s-role-dispatcher" \
    "ph3 depends on role-dispatcher"

check_file_contains "/etc/systemd/system/fck8s-k8s-setup-init.service" \
    "fck8s-role-dispatcher" \
    "init depends on role-dispatcher"

check_file_contains "/etc/systemd/system/fck8s-auto-join.service" \
    "fck8s-role-dispatcher" \
    "auto-join depends on role-dispatcher"

# Check restart rate limiting
check_file_contains "/etc/systemd/system/fck8s-k8s-setup-init.service" \
    "StartLimitBurst" \
    "init has restart rate limiting"

check_file_contains "/etc/systemd/system/fck8s-auto-join.service" \
    "StartLimitBurst" \
    "auto-join has restart rate limiting"

# =============================================================================
echo ""
info "12. CONFIGURATION FILES"
# =============================================================================
check_file "/etc/yum.repos.d/kubernetes.repo"   "Kubernetes repo config exists"
check_file "/etc/sysctl.d/k8s.conf"             "Kubernetes sysctl config exists"
check_file "/usr/local/share/default-cluster-config.json" "Default cluster config exists"

# Validate sysctl values
check_file_contains "/etc/sysctl.d/k8s.conf" "net.ipv4.ip_forward = 1"     "ip_forward enabled"
check_file_contains "/etc/sysctl.d/k8s.conf" "net.bridge.bridge-nf-call-iptables = 1"  "bridge-nf-call-iptables enabled"

# Validate default config is valid JSON
if run_in_container "python3 -c 'import json; json.load(open(\"/usr/local/share/default-cluster-config.json\"))'" 2>/dev/null; then
    pass "Default cluster config is valid JSON"
else
    fail "Default cluster config is NOT valid JSON"
fi

# Check default config has storage section
if run_in_container "python3 -c 'import json; c=json.load(open(\"/usr/local/share/default-cluster-config.json\")); assert \"storage\" in c and \"vg_data\" in c[\"storage\"]'" 2>/dev/null; then
    pass "Default config has storage.vg_data section"
else
    fail "Default config missing storage.vg_data section"
fi

# =============================================================================
echo ""
info "13. DIRECTORIES"
# =============================================================================
check_dir "/opt/k4all"       "/opt/k4all directory exists"
check_dir "/root/.kube"      "/root/.kube directory exists"
check_dir "/home/core/.kube" "/home/core/.kube directory exists"

# =============================================================================
echo ""
info "14. IMAGE LABELS"
# =============================================================================
if podman inspect "$FULL_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.title"}}' 2>/dev/null | grep -q "K4All"; then
    pass "OCI image title label is set"
else
    fail "OCI image title label missing"
fi

if podman inspect "$FULL_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null | grep -q "2.0.0"; then
    pass "OCI image version label is set"
else
    fail "OCI image version label missing"
fi

# =============================================================================
echo ""
info "15. SCRIPT CONSISTENCY"
# =============================================================================
# Verify setup-k8s-ph1.sh doesn't use rpm-ostree
if run_in_container "grep -q 'rpm-ostree' /usr/local/bin/setup-k8s-ph1.sh" 2>/dev/null; then
    fail "setup-k8s-ph1.sh still references rpm-ostree (not bootc compatible)"
else
    pass "setup-k8s-ph1.sh is bootc compatible (no rpm-ostree)"
fi

# Verify setup-helm.sh checks for pre-installed helm
if run_in_container "grep -q 'command -v helm' /usr/local/bin/setup-helm.sh" 2>/dev/null; then
    pass "setup-helm.sh checks for pre-installed helm"
else
    warn "setup-helm.sh doesn't check for pre-installed helm"
fi

# Verify k4all-utils sources correctly
if run_in_container "grep -q 'K4ALL_CONFIG_FILE' /usr/local/bin/k4all-utils" 2>/dev/null; then
    pass "k4all-utils defines K4ALL_CONFIG_FILE"
else
    fail "k4all-utils doesn't define K4ALL_CONFIG_FILE"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║                  TEST SUMMARY                     ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo -e "  ${YELLOW}WARN${NC}: $WARN"
TOTAL=$((PASS + FAIL))
echo "  TOTAL: $TOTAL"
echo ""

if [ $FAIL -gt 0 ]; then
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
