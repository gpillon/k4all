#!/bin/bash
# =============================================================================
# K4All bootc ISO Install Test (QEMU/KVM)
# =============================================================================
# End-to-end test of the unattended Anaconda ISO: boots the ISO, drives the
# real kickstart install (partitioning, K4All addon, kubeadm init), reboots
# into the installed system, and verifies the cluster comes up.
#
# This exercises what the container-based tests (test-image.sh, test-runtime.sh)
# cannot: real disk partitioning, the actual Anaconda/kickstart flow, and a
# real kernel boot (ph2 OVS bridge + reboot, systemd first-boot chain, etc).
#
# Two phases, two separate QEMU processes:
#   Phase A (install): boot vmlinuz/initrd extracted from the ISO directly,
#     with console=ttyS0 so the whole Anaconda install is captured to a
#     serial log. -no-reboot makes QEMU exit by itself when the kickstart's
#     `reboot` fires at the end of install — that's how we know it's done.
#   Phase B (verify):  boot the resulting qcow2 disk normally (no ISO, no
#     -kernel), wait for SSH, then check the cluster is Ready.
#
# Requires: qemu-kvm (or qemu-system-x86_64), xorriso, sshpass, python3.
#
# Usage:
#   ./tests/test-iso-install.sh path/to/k4all-bootstrap.iso
#   ISO=output/k4all-bootstrap.iso ./tests/test-iso-install.sh
#
# KS_FILE: some ISOs (e.g. the "attended" build) embed a kickstart that
#   requires interactive storage configuration and cannot auto-install. Set
#   KS_FILE to a standalone kickstart (e.g. iso/ks/ks-bootstrap.cfg) to
#   override it: the file is served over HTTP to the guest (host reachable at
#   10.0.2.2 under QEMU user networking) via inst.ks=, replacing whatever
#   inst.ks the ISO's own grub.cfg baked in.
#
# VNC_DISPLAY: set to watch/interact with the VM live (e.g. VNC_DISPLAY=:1
#   listens on 127.0.0.1:5901 under QEMU's numbering: port = 5900 + display).
#   Connect with any VNC client, or drive it headlessly with vncdotool:
#     pip install vncdotool
#     vncdo -s 127.0.0.1::5901 capture screen.png
#     vncdo -s 127.0.0.1::5901 key alt-f2                # switch VT (shell)
#     vncdo -s 127.0.0.1::5901 type 'some command' key enter
#   Note: vncdotool's `type` does not reliably send shift for symbols (seen:
#   '*' -> '8', '>' -> '.', '_' -> '-') — avoid those chars, or use a regex
#   dot in place of `_`/`*` when grepping, and read output on-screen (via
#   `capture`) rather than redirecting to a file.
#
# NO_AUTO_REBOOT: for manual/interactive debugging (e.g. via VNC). Anaconda
#   reboots automatically both on a normal kickstart completion AND on a
#   fatal non-interactive error (e.g. incomplete mandatory spokes) — this
#   races you against the clock. When set, a debug kickstart is generated
#   from the real one (iso/ks/ks-bootstrap.cfg, unless KS_FILE is already
#   set) with an extra early `%pre` that masks systemd's reboot/poweroff/halt
#   targets, so nothing can actually restart the VM. The script then just
#   waits on the QEMU process (foreground) instead of running Phase A's
#   completion checks or Phase B/C — stop it yourself (Ctrl-C) when done.
#
# Tunables (env vars):
#   DISK_SIZE       (default: 60G)
#   MEM_MB          (default: 8192)
#   SMP             (default: 4)
#   SSH_PORT        (default: 2222)
#   HTTP_PORT       (default: random 8000-8999 — only used with KS_FILE)
#   KS_FILE         (default: none — use the ISO's own embedded kickstart)
#   VNC_DISPLAY     (default: none — set e.g. ":1" to enable a VNC display)
#   NO_AUTO_REBOOT  (default: false — see above)
#   KEEP_VM_RUNNING (default: false — after all checks, leave the installed VM
#                    running until Ctrl-C or shutdown from inside the guest)
#   INSTALL_TIMEOUT (default: 2400  seconds — Anaconda install)
#   BOOT_TIMEOUT    (default: 300   seconds — first real boot to SSH)
#   CLUSTER_TIMEOUT (default: 600   seconds — kubeadm init + node Ready)
#   OPERATOR_TIMEOUT (default: 900  seconds — operator and managed workloads)
#   WORK_DIR        (default: subfolder of VM_VOLUMES_DIR, see below)
#   VM_VOLUMES_DIR  (default: /mnt/f/fcos/k4all-qemu-test if present, else /tmp)
#   KEEP_WORK_DIR   (default: false — set true to inspect logs/disk after run)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTC_DIR="$(dirname "$SCRIPT_DIR")"

ISO="${1:-${ISO:-${BOOTC_DIR}/output/k4all-bootstrap.iso}}"

DISK_SIZE="${DISK_SIZE:-60G}"
MEM_MB="${MEM_MB:-8192}"
SMP="${SMP:-4}"
SSH_PORT="${SSH_PORT:-2222}"
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-2400}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-300}"
CLUSTER_TIMEOUT="${CLUSTER_TIMEOUT:-600}"
OPERATOR_TIMEOUT="${OPERATOR_TIMEOUT:-900}"
KS_FILE="${KS_FILE:-}"
HTTP_PORT="${HTTP_PORT:-$((8000 + RANDOM % 1000))}"
VNC_DISPLAY="${VNC_DISPLAY:-}"
VNC_ARGS=()
if [ -n "$VNC_DISPLAY" ]; then
    VNC_ARGS=(-vnc "$VNC_DISPLAY" -k en-us)
fi
NO_AUTO_REBOOT="${NO_AUTO_REBOOT:-false}"
KEEP_VM_RUNNING="${KEEP_VM_RUNNING:-false}"

# Test VM disks/logs are large — default to the /mnt/f/fcos volume when it's
# available (WSL's own disk is space-constrained) rather than /tmp.
DEFAULT_VM_VOLUMES_DIR="/tmp"
[ -d /mnt/f/fcos ] && DEFAULT_VM_VOLUMES_DIR="/mnt/f/fcos/k4all-qemu-test"
VM_VOLUMES_DIR="${VM_VOLUMES_DIR:-$DEFAULT_VM_VOLUMES_DIR}"
mkdir -p "$VM_VOLUMES_DIR"

WORK_DIR="${WORK_DIR:-$(mktemp -d "${VM_VOLUMES_DIR}/run.XXXXXX")}"
KEEP_WORK_DIR="${KEEP_WORK_DIR:-false}"

SSH_USER="core"
SSH_PASS="core"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}▸ $1${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1"; }
phase() { echo -e "\n${BOLD}━━━ $1 ━━━${NC}"; }

keep_vm_running_if_requested() {
    if [ "$KEEP_VM_RUNNING" = "true" ] && [ -n "$QEMU_PID" ] && kill -0 "$QEMU_PID" 2>/dev/null; then
        echo ""
        ok "Installed VM left running for interactive use."
        if [ -n "$VNC_DISPLAY" ]; then
            local vnc_port=$((5900 + ${VNC_DISPLAY#:}))
            info "VNC remains available at 127.0.0.1:${vnc_port}."
        fi
        info "SSH remains available at 127.0.0.1:${SSH_PORT}."
        info "Press Ctrl-C here, or shut down the guest, to stop the VM."
        wait "$QEMU_PID"
        QEMU_PID=""
    fi
}

QEMU_PID=""
HTTP_SERVER_PID=""
cleanup() {
    if [ -n "$QEMU_PID" ] && kill -0 "$QEMU_PID" 2>/dev/null; then
        kill "$QEMU_PID" 2>/dev/null || true
        wait "$QEMU_PID" 2>/dev/null || true
    fi
    if [ -n "$HTTP_SERVER_PID" ] && kill -0 "$HTTP_SERVER_PID" 2>/dev/null; then
        kill "$HTTP_SERVER_PID" 2>/dev/null || true
        wait "$HTTP_SERVER_PID" 2>/dev/null || true
    fi
    if [ "$KEEP_WORK_DIR" != "true" ]; then
        rm -rf "$WORK_DIR"
    else
        echo "Work dir kept at: $WORK_DIR"
    fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
phase "PRE-FLIGHT"

QEMU_BIN=""
for candidate in qemu-system-x86_64 qemu-kvm /usr/libexec/qemu-kvm; do
    if command -v "$candidate" &>/dev/null; then QEMU_BIN="$(command -v "$candidate")"; break; fi
    if [ -x "$candidate" ]; then QEMU_BIN="$candidate"; break; fi
done
[ -n "$QEMU_BIN" ] || { fail "qemu-kvm / qemu-system-x86_64 not found"; exit 1; }
ok "qemu binary: $QEMU_BIN"

command -v xorriso &>/dev/null || { fail "xorriso not found (dnf install xorriso)"; exit 1; }
command -v sshpass &>/dev/null || { fail "sshpass not found (dnf install sshpass)"; exit 1; }
command -v ss &>/dev/null || { fail "ss not found (dnf install iproute)"; exit 1; }

if [ -n "$KS_FILE" ]; then
    [ -f "$KS_FILE" ] || { fail "KS_FILE not found: $KS_FILE"; exit 1; }
    command -v python3 &>/dev/null || { fail "python3 not found (needed to serve KS_FILE over HTTP)"; exit 1; }
    ok "Custom kickstart: $KS_FILE (will override the ISO's embedded one)"
fi

KVM_ARGS="-accel kvm -cpu host"
if [ ! -r /dev/kvm ]; then
    echo -e "  ${YELLOW}⚠${NC} /dev/kvm not accessible — falling back to TCG (much slower)"
    KVM_ARGS="-accel tcg -cpu max"
fi

if [ -n "$VNC_DISPLAY" ]; then
    VNC_PORT=$((5900 + ${VNC_DISPLAY#:}))
    ok "VNC enabled: 127.0.0.1:${VNC_PORT} (display ${VNC_DISPLAY})"
fi

[ -f "$ISO" ] || { fail "ISO not found: $ISO (build it first: make iso-unattended-bootstrap)"; exit 1; }
ok "ISO: $ISO"
ok "Work dir: $WORK_DIR"

# Never let verification attach to an unrelated machine.  Without this
# guard QEMU can fail its hostfwd bind while the SSH polling loop connects to
# whatever was already listening on SSH_PORT, producing a false PASS.
if ss -H -ltn "sport = :${SSH_PORT}" | grep -q .; then
    fail "SSH port ${SSH_PORT} is already in use; refusing to run against an unrelated VM"
    ss -H -ltnp "sport = :${SSH_PORT}" 2>/dev/null | sed 's/^/    /' || true
    exit 1
fi

# QEMU's CD-ROM emulation reading directly off a DrvFS mount (/mnt/*, i.e. a
# Windows drive under WSL) has shown flaky, sometimes-hanging I/O in testing.
# Cache the ISO on local (ext4) storage and boot from that copy instead —
# only the qcow2 disk needs to live on the space-constrained volume.
QEMU_ISO="$ISO"
case "$ISO" in
    /mnt/*)
        ISO_CACHE_DIR="${BOOTC_DIR}/.cache/iso-cache"
        mkdir -p "$ISO_CACHE_DIR"
        ISO_CACHED="${ISO_CACHE_DIR}/$(basename "$ISO")"
        if [ ! -f "$ISO_CACHED" ] || [ "$(stat -c%s "$ISO")" != "$(stat -c%s "$ISO_CACHED" 2>/dev/null || echo -1)" ]; then
            info "Caching ISO locally (avoids flaky DrvFS CD-ROM I/O): $ISO_CACHED"
            cp "$ISO" "$ISO_CACHED.tmp" && mv "$ISO_CACHED.tmp" "$ISO_CACHED"
        fi
        QEMU_ISO="$ISO_CACHED"
        ok "Using local ISO cache: $QEMU_ISO"
        ;;
esac

DISK="$WORK_DIR/disk.qcow2"
qemu-img create -f qcow2 "$DISK" "$DISK_SIZE" >/dev/null
ok "Created disk: $DISK ($DISK_SIZE)"

# ---------------------------------------------------------------------------
# Extract kernel/initrd + boot args from the ISO
# ---------------------------------------------------------------------------
phase "EXTRACT BOOT ASSETS FROM ISO"

VMLINUZ="$WORK_DIR/vmlinuz"
INITRD="$WORK_DIR/initrd.img"

for kpath in /images/pxeboot/vmlinuz /isolinux/vmlinuz; do
    xorriso -osirrox on -indev "$QEMU_ISO" -extract "$kpath" "$VMLINUZ" 2>/dev/null && break
done
for ipath in /images/pxeboot/initrd.img /isolinux/initrd.img; do
    xorriso -osirrox on -indev "$QEMU_ISO" -extract "$ipath" "$INITRD" 2>/dev/null && break
done
[ -f "$VMLINUZ" ] || { fail "Could not find vmlinuz in ISO"; exit 1; }
[ -f "$INITRD" ]  || { fail "Could not find initrd.img in ISO"; exit 1; }
ok "Extracted vmlinuz + initrd.img"

GRUB_CFG="$WORK_DIR/grub.cfg"
for gpath in /EFI/BOOT/grub.cfg /boot/grub2/grub.cfg; do
    xorriso -osirrox on -indev "$QEMU_ISO" -extract "$gpath" "$GRUB_CFG" 2>/dev/null && break
done
[ -f "$GRUB_CFG" ] || { fail "Could not find grub.cfg in ISO"; exit 1; }

# Grab the kernel command line from the first (default, auto-boot) menuentry.
BASE_ARGS="$(awk '/^[[:space:]]*linux(efi)?[[:space:]]/{ $1=""; sub(/^[[:space:]]*\/images\/pxeboot\/vmlinuz[[:space:]]*/,""); print; exit }' "$GRUB_CFG" | sed 's/^ *//;s/ *$//')"
[ -n "$BASE_ARGS" ] || { fail "Could not parse kernel args from grub.cfg"; exit 1; }
ok "Base kernel args: $BASE_ARGS"

if [ "$NO_AUTO_REBOOT" = "true" ] && [ -z "$KS_FILE" ]; then
    REAL_KS="${BOOTC_DIR}/iso/ks/ks-bootstrap.cfg"
    [ -f "$REAL_KS" ] || { fail "NO_AUTO_REBOOT: real kickstart not found: $REAL_KS"; exit 1; }
    KS_FILE="$WORK_DIR/ks-noreboot.cfg"
    cp "$REAL_KS" "$KS_FILE"
    # Extra, separate %pre section — masks systemd's reboot/poweroff/halt
    # targets before anything (kickstart completion or a fatal cmdline
    # error) gets a chance to actually restart the VM.
    cat >>"$KS_FILE" <<'EOF'

%pre --interpreter=/bin/bash
systemctl mask reboot.target poweroff.target halt.target \
    systemd-reboot.service systemd-poweroff.service systemd-halt.service \
    ctrl-alt-del.target 2>/dev/null || true
%end
EOF
    ok "NO_AUTO_REBOOT: generated debug kickstart from $REAL_KS -> $KS_FILE"
fi

if [ -n "$KS_FILE" ]; then
    # Strip whatever inst.ks the ISO baked in and serve our own kickstart
    # over HTTP — the guest reaches the host at 10.0.2.2 under QEMU user
    # networking. ip=dhcp ensures the installer brings up networking early
    # enough in the initramfs to fetch it.
    BASE_ARGS="$(echo "$BASE_ARGS" | sed -E 's/inst\.ks=[^ ]+//')"

    HTTP_DIR="$WORK_DIR/http"
    mkdir -p "$HTTP_DIR"
    cp "$KS_FILE" "$HTTP_DIR/ks.cfg"
    python3 -m http.server "$HTTP_PORT" --directory "$HTTP_DIR" --bind 127.0.0.1 \
        >"$WORK_DIR/http-server.log" 2>&1 &
    HTTP_SERVER_PID=$!
    sleep 1
    kill -0 "$HTTP_SERVER_PID" 2>/dev/null || { fail "Kickstart HTTP server failed to start"; cat "$WORK_DIR/http-server.log"; exit 1; }
    ok "Serving $KS_FILE at http://10.0.2.2:${HTTP_PORT}/ks.cfg (pid $HTTP_SERVER_PID)"

    BASE_ARGS="$BASE_ARGS ip=dhcp inst.ks=http://10.0.2.2:${HTTP_PORT}/ks.cfg"
fi

# Force text-mode: we're headless (no VGA/display), and not every kickstart
# sets "text --non-interactive" itself (e.g. standalone ones meant for manual
# PXE use) — without it Anaconda tries to start a GUI and hangs forever here.
# Also mask brltty.service: it probes serial ports for braille displays,
# which collides with using ttyS0 as our console and can hang the boot.
APPEND="$BASE_ARGS inst.text systemd.mask=brltty.service console=ttyS0,115200n8 console=tty0"

# ---------------------------------------------------------------------------
# PHASE A: run the unattended install
# ---------------------------------------------------------------------------
phase "PHASE A: ANACONDA INSTALL (timeout ${INSTALL_TIMEOUT}s)"

INSTALL_LOG="$WORK_DIR/install-serial.log"
info "Serial log: $INSTALL_LOG (tail -f it in another shell to watch progress)"

# With NO_AUTO_REBOOT, reboot is masked *inside* the guest — drop -no-reboot
# here too so that if anything ever slips past the mask, QEMU just reboots
# the VM back into the same installer (via -kernel/-initrd) instead of
# exiting and losing the debug session.
NOREBOOT_FLAG=(-no-reboot)
NET_ARGS=(-netdev user,id=net0)
[ "$NO_AUTO_REBOOT" = "true" ] && NOREBOOT_FLAG=()
# With NO_AUTO_REBOOT, also forward SSH_PORT -> guest:22 — the debug console
# (or its %pre) is expected to enable sshd manually with a normal TCP
# listener (e.g. `cp sshd_config.anaconda sshd_config; systemctl start sshd`;
# vsock-only debugging via the built-in generator has its own quirks — see
# the module docstring — so plain TCP is the reliable path here).
[ "$NO_AUTO_REBOOT" = "true" ] && NET_ARGS=(-netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22")

# shellcheck disable=SC2086
$QEMU_BIN \
    -name k4all-install -machine q35 $KVM_ARGS \
    -m "$MEM_MB" -smp "$SMP" \
    -drive file="$DISK",if=none,format=qcow2,id=disk0 \
    -device virtio-blk-pci,drive=disk0,bootindex=1 \
    -cdrom "$QEMU_ISO" \
    -kernel "$VMLINUZ" -initrd "$INITRD" -append "$APPEND" \
    "${NET_ARGS[@]}" -device virtio-net-pci,netdev=net0 \
    -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0 \
    -serial file:"$INSTALL_LOG" \
    "${VNC_ARGS[@]}" -display none "${NOREBOOT_FLAG[@]}" \
    &
QEMU_PID=$!

if [ "$NO_AUTO_REBOOT" = "true" ]; then
    echo ""
    ok "NO_AUTO_REBOOT: reboot is masked inside the guest — this VM will stay up indefinitely."
    if [ -n "$VNC_DISPLAY" ]; then
        VNC_PORT=$((5900 + ${VNC_DISPLAY#:}))
        info "Connect via VNC (127.0.0.1:${VNC_PORT}) to debug interactively."
    fi
    info "SSH is forwarded to 127.0.0.1:${SSH_PORT} -> guest:22 (enable sshd yourself from the console)."
    info "Press Ctrl-C to stop the VM and exit."
    wait "$QEMU_PID"
    QEMU_PID=""
    exit 0
fi

elapsed=0
INSTALL_OK=false
while [ $elapsed -lt "$INSTALL_TIMEOUT" ]; do
    if ! kill -0 "$QEMU_PID" 2>/dev/null; then
        # QEMU exited on its own — that's the expected signal (kickstart `reboot` + -no-reboot)
        INSTALL_OK=true
        break
    fi
    sleep 10
    elapsed=$((elapsed + 10))
done
QEMU_PID=""

if ! $INSTALL_OK; then
    fail "Install did not finish within ${INSTALL_TIMEOUT}s — killing QEMU"
    echo "  Last 40 lines of $INSTALL_LOG:"
    tail -40 "$INSTALL_LOG" 2>/dev/null | sed 's/^/    /'
    exit 1
fi
ok "Anaconda install finished (QEMU exited on kickstart reboot)"

# Anaconda also reboots after a fatal non-interactive error.  A bare qcow2
# header is only a few hundred KiB, while a completed bootc installation is
# much larger, so reject the false-success case before trying Phase B.
DISK_FILE_SIZE=$(stat -c%s "$DISK")
MIN_INSTALLED_DISK_SIZE=$((10 * 1024 * 1024))
if [ "$DISK_FILE_SIZE" -lt "$MIN_INSTALLED_DISK_SIZE" ]; then
    fail "Anaconda rebooted without installing the disk (qcow2 is only ${DISK_FILE_SIZE} bytes)"
    echo "  This usually means a fatal kickstart/incomplete-spoke error."
    exit 1
fi
ok "Installed disk contains data ($(du -h "$DISK" | awk '{print $1}'))"

if grep -qiE 'traceback|installation failed' "$INSTALL_LOG"; then
    fail "Install log contains error markers"
    grep -iE 'traceback|installation failed' "$INSTALL_LOG" | tail -20 | sed 's/^/    /'
    exit 1
fi

# ---------------------------------------------------------------------------
# PHASE B: boot the installed disk for real, verify the cluster
# ---------------------------------------------------------------------------
phase "PHASE B: BOOT INSTALLED SYSTEM (timeout ${BOOT_TIMEOUT}s to SSH)"

BOOT_LOG="$WORK_DIR/boot-serial.log"
info "Serial log: $BOOT_LOG"

# shellcheck disable=SC2086
$QEMU_BIN \
    -name k4all-boot -machine q35 $KVM_ARGS \
    -m "$MEM_MB" -smp "$SMP" \
    -drive file="$DISK",if=none,format=qcow2,id=disk0 \
    -device virtio-blk-pci,drive=disk0,bootindex=1 \
    -netdev user,id=net0,hostfwd=tcp::"${SSH_PORT}"-:22 -device virtio-net-pci,netdev=net0 \
    -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0 \
    -serial file:"$BOOT_LOG" \
    "${VNC_ARGS[@]}" -display none \
    &
QEMU_PID=$!

# Host-forwarding errors happen during QEMU startup.  Catch them before the
# SSH loop can accidentally reach a pre-existing listener on the same port.
sleep 1
if ! kill -0 "$QEMU_PID" 2>/dev/null; then
    wait "$QEMU_PID" 2>/dev/null || true
    QEMU_PID=""
    fail "QEMU exited during boot startup (the SSH/VNC port may be in use)"
    tail -40 "$BOOT_LOG" 2>/dev/null | sed 's/^/    /'
    exit 1
fi

SSH() {
    sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o ConnectTimeout=5 -o LogLevel=ERROR \
        "${SSH_USER}@127.0.0.1" "$@"
}

elapsed=0
SSH_OK=false
while [ $elapsed -lt "$BOOT_TIMEOUT" ]; do
    kill -0 "$QEMU_PID" 2>/dev/null || { fail "QEMU exited unexpectedly during boot"; tail -40 "$BOOT_LOG" | sed 's/^/    /'; exit 1; }
    if SSH "true" 2>/dev/null; then
        # Check again after SSH: the connection is only valid while the QEMU
        # process launched above is still alive.
        kill -0 "$QEMU_PID" 2>/dev/null || { fail "QEMU exited while SSH became reachable"; exit 1; }
        SSH_OK=true
        break
    fi
    sleep 5
    elapsed=$((elapsed + 5))
done
$SSH_OK || { fail "SSH not reachable within ${BOOT_TIMEOUT}s"; tail -40 "$BOOT_LOG" | sed 's/^/    /'; exit 1; }
ok "SSH reachable (user: $SSH_USER)"

phase "PHASE C: STORAGE VERIFICATION"

STORAGE_OK=true
if SSH "sudo vgs rootvg vg_data >/dev/null 2>&1"; then
    ok "rootvg and vg_data exist"
else
    fail "Expected rootvg and vg_data were not both found"
    STORAGE_OK=false
fi

if SSH "test -z \"\$(sudo swapon --show --noheadings)\" && ! sudo lsblk -rno FSTYPE | grep -qx swap && ! sudo lvs --noheadings -o lv_name 2>/dev/null | grep -qi swap"; then
    ok "No active swap, swap filesystem, or swap LV exists"
else
    fail "Swap exists in the installed system"
    STORAGE_OK=false
fi

ROOTVG_MB=$(SSH "sudo vgs --units m --nosuffix --noheadings -o vg_size rootvg 2>/dev/null" | tr -d ' ' || true)
VGDATA_MB=$(SSH "sudo vgs --units m --nosuffix --noheadings -o vg_size vg_data 2>/dev/null" | tr -d ' ' || true)
OS_PERCENT=$(awk -v root="$ROOTVG_MB" -v data="$VGDATA_MB" 'BEGIN { if (root+data > 0) printf "%.1f", root*100/(root+data); else print "0" }')
if awk -v pct="$OS_PERCENT" 'BEGIN { exit !(pct >= 77 && pct <= 83) }'; then
    ok "LVM allocation is approximately 80/20 (OS: ${OS_PERCENT}%)"
else
    fail "Unexpected LVM allocation (rootvg=${ROOTVG_MB:-?} MiB, vg_data=${VGDATA_MB:-?} MiB, OS=${OS_PERCENT}%)"
    STORAGE_OK=false
fi

phase "PHASE D: CLUSTER VERIFICATION (timeout ${CLUSTER_TIMEOUT}s)"

elapsed=0
NODE_READY=false
while [ $elapsed -lt "$CLUSTER_TIMEOUT" ]; do
    if SSH "sudo test -f /etc/kubernetes/admin.conf && sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready'"; then
        NODE_READY=true
        break
    fi
    sleep 15
    elapsed=$((elapsed + 15))
done

if $NODE_READY; then
    ok "Node is Ready"
else
    fail "Node not Ready within ${CLUSTER_TIMEOUT}s"
fi

phase "PHASE E: K4ALL OPERATOR VERIFICATION (timeout ${OPERATOR_TIMEOUT}s)"

elapsed=0
OPERATOR_OK=false
while [ $elapsed -lt "$OPERATOR_TIMEOUT" ]; do
    if SSH "sudo systemctl is-active --quiet fck8s-operator-deploy.service && \
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get clusterconfig k4all-cluster-config >/dev/null 2>&1 && \
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get releasemanifest k4all >/dev/null 2>&1 && \
test \"\$(sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get clusterconfig k4all-cluster-config -o jsonpath='{.spec.features.ovsBridge.enabled}')\" = true && \
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl rollout status -n k4all-operator-system deployment/k4all-operator-controller-manager --timeout=5s >/dev/null 2>&1 && \
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl rollout status -n topolvm-system daemonset/topolvm-lvmd-0 --timeout=5s >/dev/null 2>&1 && \
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl rollout status -n topolvm-system daemonset/topolvm-node --timeout=5s >/dev/null 2>&1 && \
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl rollout status -n traefik daemonset/traefik --timeout=5s >/dev/null 2>&1 && \
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get pods -A --no-headers 2>/dev/null | awk '\$4 != \"Completed\" { split(\$3, ready, \"/\"); if (ready[1] != ready[2] || \$4 != \"Running\") exit 1 }'"; then
        OPERATOR_OK=true
        break
    fi
    if SSH "sudo systemctl is-failed --quiet fck8s-operator-deploy.service"; then
        break
    fi
    sleep 10
    elapsed=$((elapsed + 10))
done

if $OPERATOR_OK; then
    ok "Operator service, rollout, ClusterConfig, and ReleaseManifest are ready"
    ok "ClusterConfig has features.ovsBridge.enabled=true"
    ok "TopoLVM, Traefik, and all non-completed pods are ready"
else
    fail "K4All operator deployment did not become ready within ${OPERATOR_TIMEOUT}s"
    SSH "sudo systemctl status fck8s-operator-deploy.service --no-pager --full" | sed 's/^/    /' || true
    SSH "sudo journalctl -u fck8s-operator-deploy.service -b --no-pager -n 100" | sed 's/^/    /' || true
    SSH "sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl logs -n k4all-operator-system deployment/k4all-operator-controller-manager --all-containers --tail=100" | sed 's/^/    /' || true
fi

echo ""
info "Final state:"
SSH "sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get nodes -o wide 2>/dev/null" | sed 's/^/    /' || true
echo ""
SSH "sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get pods -A --no-headers 2>/dev/null | head -30" | sed 's/^/    /' || true
echo ""
info "Failed systemd units (if any):"
FAILED_UNITS=$(SSH "sudo systemctl --failed --no-legend --plain" || true)
if [ -z "${FAILED_UNITS//[[:space:]]/}" ]; then
    SYSTEMD_OK=true
    ok "No failed systemd units"
else
    SYSTEMD_OK=false
    fail "Failed systemd units found"
    echo "$FAILED_UNITS" | sed 's/^/    /'
fi

echo ""
if $NODE_READY && $STORAGE_OK && $OPERATOR_OK && $SYSTEMD_OK; then
    echo -e "${GREEN}ISO install + cluster bring-up: PASS${NC}"
    RESULT=0
else
    echo -e "${RED}ISO install + cluster bring-up: FAIL${NC}"
    RESULT=1
fi

keep_vm_running_if_requested
exit "$RESULT"
