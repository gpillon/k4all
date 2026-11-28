#!/bin/bash
# =============================================================================
# K4All bootc Image Validation Tests
# =============================================================================
# Builds the K4All bootc image (or takes an existing one) and checks it
# against this source tree: every script of the overlay is in the image and
# executable, every unit of bootc/systemd is installed, the image enables
# exactly the units the Containerfile enables (the role dispatcher enables
# the role-specific ones at first boot), and the labels carry the versions
# of the Containerfile. The expectations come from the tree, so they follow
# it: test an image built from the same commit.
#
# Usage:
#   ./tests/test-image.sh                # Build + test
#   ./tests/test-image.sh --skip-build   # Test existing image
#   IMAGE_NAME=myimage IMAGE_TAG=dev ./tests/test-image.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"
CONTAINERFILE="$BOOTC_DIR/Containerfile"
OVERLAY_BIN="$BOOTC_DIR/overlay/usr/local/bin"

IMAGE_NAME="${IMAGE_NAME:-ghcr.io/gpillon/k4all-bootc}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
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

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}✓ PASS${NC}: $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}✗ FAIL${NC}: $1"; }
warn() { WARN=$((WARN + 1)); echo -e "  ${YELLOW}⚠ WARN${NC}: $1"; }
info() { echo -e "${CYAN}▸ $1${NC}"; }

# One container for every check: `podman exec` instead of a container per check.
CONTAINER=""
cleanup() {
    if [ -n "$CONTAINER" ]; then
        podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

run_in_container() {
    podman exec "$CONTAINER" bash -c "$1"
}

# check DESCRIPTION COMMAND: pass when COMMAND succeeds in the container.
check() {
    if run_in_container "$2" >/dev/null 2>&1; then
        pass "$1"
    else
        fail "$1"
    fi
}

check_command()    { check "${2:-$1 is installed}" "command -v '$1'"; }
check_file()       { check "${2:-$1 exists}" "test -f '$1'"; }
check_executable() { check "${2:-$1 is executable}" "test -f '$1' && test -x '$1'"; }
check_dir()        { check "${2:-$1 exists}" "test -d '$1'"; }
check_file_contains() { check "${3:-$1 contains '$2'}" "grep -q -- '$2' '$1'"; }

# systemctl works offline on the image's unit files: no systemd runs here.
unit_state() {
    run_in_container "systemctl is-enabled '$1' 2>/dev/null" || true
}

# The units the Containerfile enables: `systemctl enable <unit>` on lines that
# are not comments.
containerfile_enabled_units() {
    grep -v '^[[:space:]]*#' "$CONTAINERFILE" \
        | grep -oE 'systemctl enable [^ &\\]+' \
        | awk '{print $3}' | sort -u
}

containerfile_arg() {
    sed -n "s/^ARG $1=//p" "$CONTAINERFILE" | head -n1
}

image_label() {
    podman image inspect "$FULL_IMAGE" --format "{{index .Config.Labels \"$1\"}}" 2>/dev/null || true
}

# =============================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   K4All bootc Image Validation Tests             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

if [ "$SKIP_BUILD" != "--skip-build" ]; then
    info "Building test image: $FULL_IMAGE"
    cd "$BOOTC_DIR"
    podman build --tag "$FULL_IMAGE" --file Containerfile . 2>&1 | tail -5
    echo ""
fi

if ! podman image exists "$FULL_IMAGE" 2>/dev/null; then
    echo -e "${RED}ERROR: Image $FULL_IMAGE not found. Run without --skip-build.${NC}"
    exit 1
fi

CONTAINER="$(podman run -d --rm --entrypoint sleep "$FULL_IMAGE" infinity)"

# =============================================================================
info "1. PACKAGES - Kubernetes and container runtime"
# =============================================================================
check_command "kubeadm"
check_command "kubelet"
check_command "kubectl"
check_command "crio" "CRI-O is installed (crio binary)"

info "2. PACKAGES - Networking, firewall, HA"
check_command "ovs-vsctl" "Open vSwitch is installed"
check_command "nmcli" "NetworkManager is installed"
check_command "firewall-cmd" "firewalld is installed"
check_command "keepalived"

info "3. PACKAGES - Tools"
for cmd in helm jq yq lvm openssl curl git python3; do
    check_command "$cmd"
done
check "yq is mikefarah yq v4 (the scripts need it)" "yq --version | grep -q 'mikefarah.*version v4'"

# =============================================================================
echo ""
info "4. SCRIPTS - every file of overlay/usr/local/bin is in the image, scripts executable"
# =============================================================================
# Executable: what is executable in the tree, plus what the Containerfile
# makes executable (*.sh and k4all-*). Sourced libraries (control-plane-utils)
# and kubeadm templates only have to be there.
while IFS= read -r path; do
    rel="${path#"$OVERLAY_BIN"/}"
    name="$(basename "$rel")"
    if [ -x "$path" ] || [[ "$name" == *.sh ]] || [[ "$name" == k4all-* ]]; then
        check_executable "/usr/local/bin/$rel" "$rel is executable"
    else
        check_file "/usr/local/bin/$rel" "$rel is in the image"
    fi
done < <(find "$OVERLAY_BIN" -type f | sort)

# =============================================================================
echo ""
info "5. SYSTEMD - every unit of bootc/systemd is installed"
# =============================================================================
mapfile -t UNITS < <(cd "$BOOTC_DIR/systemd" && ls -1 ./*.service ./*.timer ./*.path 2>/dev/null | sed 's|^\./||' | sort)
for unit in "${UNITS[@]}"; do
    check_file "/etc/systemd/system/$unit" "unit file $unit is installed"
done

# =============================================================================
echo ""
info "6. SYSTEMD - the image enables what the Containerfile enables"
# =============================================================================
mapfile -t ENABLED < <(containerfile_enabled_units)
if [ "${#ENABLED[@]}" -lt 3 ]; then
    fail "found only ${#ENABLED[@]} 'systemctl enable' units in the Containerfile: the parser is out of date"
fi
for unit in "${ENABLED[@]}"; do
    state="$(unit_state "$unit")"
    case "$state" in
        enabled|static|alias) pass "$unit is enabled" ;;
        *) fail "$unit is enabled (is-enabled: ${state:-unknown})" ;;
    esac
done

# The role dispatcher enables these at first boot, for the roles that run
# them: enabled in the image, they would run on every role.
for unit in "${UNITS[@]}"; do
    printf '%s\n' "${ENABLED[@]}" | grep -qxF "$unit" && continue
    state="$(unit_state "$unit")"
    case "$state" in
        enabled|enabled-runtime) fail "$unit is left to first boot, but the image enables it" ;;
        *) pass "$unit is left to first boot or to another unit (is-enabled: ${state:-unknown})" ;;
    esac
done

state="$(unit_state bootc-fetch-apply-updates.timer)"
if [ "$state" = "masked" ]; then
    pass "bootc-fetch-apply-updates.timer is masked (k4all-upgrade drives upgrades)"
else
    fail "bootc-fetch-apply-updates.timer is masked (is-enabled: ${state:-unknown})"
fi

# =============================================================================
echo ""
info "7. SYSTEMD - dependency chain"
# =============================================================================
check_file_contains "/etc/systemd/system/fck8s-k8s-setup-ph3.service" \
    "fck8s-role-dispatcher" "ph3 depends on role-dispatcher"
check_file_contains "/etc/systemd/system/fck8s-k8s-setup-init.service" \
    "fck8s-role-dispatcher" "init depends on role-dispatcher"
check_file_contains "/etc/systemd/system/fck8s-auto-join.service" \
    "fck8s-role-dispatcher" "auto-join depends on role-dispatcher"
check_file_contains "/etc/systemd/system/fck8s-k8s-setup-init.service" \
    "StartLimitBurst" "init has restart rate limiting"
check_file_contains "/etc/systemd/system/fck8s-auto-join.service" \
    "StartLimitBurst" "auto-join has restart rate limiting"
check_file_contains "/etc/systemd/system/k4all-login-info.service" \
    "After=.*fck8s-restore.service" "login-info runs after the restore"
check_file_contains "/etc/systemd/system/k4all-login-info.service" \
    "ExecStart=/usr/local/bin/k4all-login-info --update-profile" \
    "login-info rewrites the K4ALL HELPER block"

# =============================================================================
echo ""
info "8. CONFIGURATION FILES"
# =============================================================================
check_file "/etc/yum.repos.d/kubernetes.repo" "Kubernetes repo config exists"
check_file "/etc/sysctl.d/k8s.conf" "Kubernetes sysctl config exists"
check_file_contains "/etc/sysctl.d/k8s.conf" "net.ipv4.ip_forward = 1" "ip_forward enabled"
check_file_contains "/etc/sysctl.d/k8s.conf" "net.bridge.bridge-nf-call-iptables = 1" \
    "bridge-nf-call-iptables enabled"
check_file "/usr/local/share/k4all-config.yaml.default" "default node configuration exists"
check "default node configuration is a ClusterConfig" \
    "yq -e '.kind == \"ClusterConfig\"' /usr/local/share/k4all-config.yaml.default"
check "k4all-release.yaml is a ReleaseManifest" \
    "yq -e '.kind == \"ReleaseManifest\"' /usr/local/share/k4all-release.yaml"
check "k4all-release.yaml pins k4all-operator to a release tag" \
    "yq -e '.spec.components.k4all-operator.version | test(\"^v[0-9]+[.][0-9]+[.][0-9]+\$\")' /usr/local/share/k4all-release.yaml"
check "the operator manifest for deploy-operator.sh is in the image" \
    "test -s /usr/local/share/k4all-operator-install.yaml"
check "the upgrade graph of the image is valid JSON" \
    "python3 -c 'import json; json.load(open(\"/usr/local/share/k4all-upgrade/releases.json\"))'"

# =============================================================================
echo ""
info "9. DIRECTORIES"
# =============================================================================
check_dir "/opt/k4all" "/opt/k4all exists (link to /var/opt/k4all)"
check_dir "/root/.kube" "/root/.kube exists"

# =============================================================================
echo ""
info "10. IMAGE LABELS - the versions of the Containerfile"
# =============================================================================
if podman image inspect "$FULL_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.title"}}' 2>/dev/null \
        | grep -q "K4All"; then
    pass "OCI image title label is set"
else
    fail "OCI image title label is set"
fi

version="$(image_label org.opencontainers.image.version)"
if [ -n "$version" ] && [ "$version" = "$(image_label io.k4all.version)" ]; then
    pass "version labels agree ($version)"
else
    fail "version labels agree (org.opencontainers.image.version '$version', io.k4all.version '$(image_label io.k4all.version)')"
fi

for pair in "io.k4all.kubernetes:KUBERNETES_VERSION" "io.k4all.crio:CRIO_MINOR" "io.k4all.fedora:FEDORA_MAJOR"; do
    label="${pair%%:*}"
    arg="${pair#*:}"
    want="$(containerfile_arg "$arg")"
    got="$(image_label "$label")"
    if [ -n "$want" ] && [ "$got" = "$want" ]; then
        pass "$label is $want ($arg in the Containerfile)"
    else
        fail "$label is '$got', the Containerfile's $arg is '$want'"
    fi
done

kube="$(containerfile_arg KUBERNETES_VERSION)"
check "kubelet is $kube" "kubelet --version | grep -q 'v${kube}\$'"

# =============================================================================
echo ""
info "11. SCRIPT CONSISTENCY"
# =============================================================================
if run_in_container "grep -q 'rpm-ostree' /usr/local/bin/setup-k8s-ph1.sh" 2>/dev/null; then
    fail "setup-k8s-ph1.sh still references rpm-ostree (not bootc compatible)"
else
    pass "setup-k8s-ph1.sh is bootc compatible (no rpm-ostree)"
fi
check_file_contains "/usr/local/bin/k4all-utils" "K4ALL_CONFIG_FILE" "k4all-utils defines K4ALL_CONFIG_FILE"

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
