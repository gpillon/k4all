"""Moving a node to a new install with k4all-backup.sh and k4all-restore.sh.

Found on a lab replica of a k4all 1.8 node restored on v2.6.1 (issue #50).
The functions run for real in bash, on temporary directories and with fake
podman, helm, kubectl and LVM commands.
"""

import os
import re
import shutil
import stat
import subprocess
import textwrap

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")
RESTORE = os.path.join(BIN, "k4all-restore.sh")
DEPLOY_OPERATOR = os.path.join(BIN, "deploy-operator.sh")
SETUP_LVM = os.path.join(BIN, "setup-lvm.sh")
SET_HOSTNAME = os.path.join(BIN, "set-hostname.sh")
RELEASE = os.path.join(BIN, "..", "share", "k4all-release.yaml")


def _mikefarah_yq():
    """deploy-operator.sh needs the yq the image ships (mikefarah v4); CI
    passes it as K4ALL_TEST_YQ, as for test_ingress_scripts.py."""
    for candidate in (os.environ.get("K4ALL_TEST_YQ"), shutil.which("yq")):
        if not candidate:
            continue
        try:
            out = subprocess.run([candidate, "--version"], capture_output=True,
                                 text=True, timeout=10, check=False).stdout
        except OSError:
            continue
        if "mikefarah" in out and re.search(r"version v?4\.", out):
            return candidate
    return None


YQ = _mikefarah_yq()


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


def fake(bin_dir, name, script):
    path = bin_dir / name
    path.write_text("#!/bin/bash\n" + textwrap.dedent(script))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def run_restore_function(function, env):
    return subprocess.run(["bash", "-c", 'source "$1"; %s' % function, "bash", RESTORE],
                          env=env, capture_output=True, text=True, check=False)


def keyfile(path, iface):
    path.write_text("[connection]\nid=%s\ninterface-name=%s\n" % (path.stem, iface))


# --- network -------------------------------------------------------------
def test_installer_profiles_for_a_restored_nic_are_set_aside(tmp_path):
    restored, nm = tmp_path / "restored", tmp_path / "nm"
    restored.mkdir()
    nm.mkdir()
    keyfile(restored / "ovs-port-eth-int.nmconnection", "ens18")
    keyfile(restored / "ovs-bridge.nmconnection", "ovs-bridge")
    for f in restored.iterdir():
        (nm / f.name).write_text(f.read_text())
    keyfile(nm / "ens18.nmconnection", "ens18")      # the installer's DHCP
    keyfile(nm / "ens20.nmconnection", "ens20")      # a NIC the backup has no profile for

    proc = run_restore_function('disable_conflicting_nm_profiles "%s" "%s"' % (restored, nm),
                                dict(os.environ))

    assert proc.returncode == 0, proc.stderr
    assert sorted(os.listdir(nm)) == [
        "ens18.nmconnection.k4all-replaced", "ens20.nmconnection",
        "ovs-bridge.nmconnection", "ovs-port-eth-int.nmconnection"]


def test_the_restore_runs_before_networkmanager_and_set_hostname():
    unit = read(BOOTC, "systemd", "fck8s-restore.service")
    assert "Before=NetworkManager.service" in unit
    assert "Before=fck8s-set-hostname.service" in unit


def test_the_restored_hostname_is_kept():
    script = read(RESTORE)
    hostname_block = script[script.index('cp -f "$WORK_DIR/config/hostname" /etc/hostname'):]
    assert "touch /opt/k4all/setup-hostname.done" in hostname_block[:600]


# --- etcd ----------------------------------------------------------------
@pytest.fixture
def podman(tmp_path):
    bin_dir, images = tmp_path / "bin", tmp_path / "images"
    bin_dir.mkdir()
    images.mkdir()
    (images / "registry.k8s.io_etcd_3.6.8-0.tar").write_text("archive")
    fake(bin_dir, "podman", """\
        case "$1 $2" in
          "image exists") [ "$3" = "$LOCAL_IMAGE" ] ;;
          "load -q") echo "Loaded image: registry.k8s.io/etcd:3.6.8-0" ;;
          *) exit 1 ;;
        esac
    """)
    env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
               K4ALL_IMAGES_DIR=str(images), LOCAL_IMAGE="")
    return env


def test_etcd_is_restored_from_the_image_k4all_ships(podman):
    proc = run_restore_function("prepare_etcd_image registry.k8s.io/etcd:3.5.21-0", podman)
    assert proc.stdout.strip() == "registry.k8s.io/etcd:3.6.8-0"


def test_an_etcd_image_already_in_local_storage_is_used_as_it_is(podman):
    podman["LOCAL_IMAGE"] = "registry.k8s.io/etcd:3.5.21-0"
    proc = run_restore_function("prepare_etcd_image registry.k8s.io/etcd:3.5.21-0", podman)
    assert proc.stdout.strip() == "registry.k8s.io/etcd:3.5.21-0"


# --- node customizations ---------------------------------------------------
def test_mounts_dispatchers_and_extra_fstab_lines_come_back(tmp_path):
    node, etc = tmp_path / "node", tmp_path / "etc"
    (node / "etc/systemd/system/ovsdb-server.service.d").mkdir(parents=True)
    (node / "etc/NetworkManager/dispatcher.d").mkdir(parents=True)
    (node / "etc/sysctl.d").mkdir(parents=True)
    (node / "etc/systemd/system/var-mnt-share.mount").write_text("[Mount]\n")
    (node / "etc/systemd/system/ovsdb-server.service.d/fix.conf").write_text("[Service]\n")
    (node / "etc/NetworkManager/dispatcher.d/90-ovs-arp.sh").write_text("# both bridges\n")
    (node / "etc/sysctl.d/90-user.conf").write_text("vm.x = 2\n")
    (node / "etc/sysctl.conf").write_text("fs.file-max = 2097152\n")
    (node / "etc/fstab").write_text(
        "UUID=old / xfs defaults 0 0\n"
        "UUID=oldboot /boot xfs defaults 0 0\n"
        "/dev/vg_data/media /var/mnt/media xfs defaults 0 0\n")
    (node / "enabled-units.txt").write_text("multi-user.target.wants var-mnt-share.mount\n")
    (etc / "sysctl.d").mkdir(parents=True)
    (etc / "sysctl.d/90-user.conf").write_text("vm.x = 1\n")
    (etc / "sysctl.conf").write_text("# defaults\n")
    (etc / "fstab").write_text("UUID=new / xfs defaults 0 0\nUUID=newboot /boot xfs defaults 0 0\n")

    proc = run_restore_function('restore_node_customizations "%s" "%s"' % (node, etc),
                                dict(os.environ))

    assert proc.returncode == 0, proc.stderr
    assert (etc / "systemd/system/var-mnt-share.mount").exists()
    link = etc / "systemd/system/multi-user.target.wants/var-mnt-share.mount"
    assert os.readlink(link) == "/etc/systemd/system/var-mnt-share.mount"
    assert (etc / "systemd/system/ovsdb-server.service.d/fix.conf").exists()
    assert (etc / "NetworkManager/dispatcher.d/90-ovs-arp.sh").read_text() == "# both bridges\n"
    assert (etc / "sysctl.d/90-user.conf").read_text() == "vm.x = 1\n", "the new system's file stays"
    assert (etc / "sysctl.conf").read_text() == "fs.file-max = 2097152\n"
    assert (etc / "fstab").read_text().splitlines() == [
        "UUID=new / xfs defaults 0 0", "UUID=newboot /boot xfs defaults 0 0",
        "/dev/vg_data/media /var/mnt/media xfs defaults 0 0"]


def test_the_backup_saves_the_node_customizations():
    script = read(BIN, "k4all-backup.sh")
    for what in ("/etc/systemd/system/*.mount", "/etc/NetworkManager/dispatcher.d/*",
                 "/etc/systemd/system/*.d/*.conf", "save_etc_file fstab",
                 "enabled-units.txt", "ostree admin config-diff"):
        assert what in script


def test_ph2_keeps_a_restored_dispatcher_script():
    script = read(BIN, "setup-k8s-ph2.sh")
    assert "if [ ! -e /etc/NetworkManager/dispatcher.d/90-ovs-arp.sh ]; then" in script


# --- components of a restored 1.x cluster ------------------------------------
@pytest.fixture
def deploy(tmp_path):
    if YQ is None:
        pytest.skip("needs mikefarah yq v4 (K4ALL_TEST_YQ or PATH)")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "yq").symlink_to(YQ)
    # Present: the helm releases cilium and argocd, KubeVirt's workloads,
    # multus and ovs-cni (arm64). Missing: everything else.
    fake(bin_dir, "helm", """\
        [ "$1" = status ] && case "$2" in cilium|argocd) exit 0 ;; esac
        exit 1
    """)
    fake(bin_dir, "kubectl", """\
        case "$*" in
          "-n kubevirt get deploy,ds,sts -o name") echo deployment.apps/virt-operator ;;
          "-n kube-system get ds kube-multus-ds") exit 0 ;;
          "-n kube-system get ds -o name") echo daemonset.apps/ovs-cni-arm64 ;;
          *) exit 1 ;;
        esac
    """)
    manifest = tmp_path / "k4all-release.yaml"
    manifest.write_text(read(RELEASE))
    script = read(DEPLOY_OPERATOR)
    functions = tmp_path / "functions.sh"
    start = script.index("RESTORED_FROM_FILE=")
    functions.write_text(script[start:script.index("create_release_manifest_cr() {")])
    marker = tmp_path / "restored-from-version"
    env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
               RESTORED_FROM_FILE=str(marker), RELEASE_MANIFEST=str(manifest))

    def run(version):
        if version:
            marker.write_text(version + "\n")
        proc = subprocess.run(
            ["bash", "-c", 'source "$1"; mark_restored_components_unmanaged', "bash",
             str(functions)], env=env, capture_output=True, text=True, check=False)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        out = subprocess.run(
            [YQ, "-r", '.spec.components | to_entries | .[] | '
             'select(.value.management == "Unmanaged") | .key', str(manifest)],
            capture_output=True, text=True, check=True)
        return sorted(out.stdout.split())

    return run


def test_a_cluster_restored_from_1x_keeps_what_it_runs(deploy):
    assert deploy("1.8.0") == ["argocd", "cilium", "kube-vip", "kubevirt", "multus-cni",
                              "ovs-cni"]


def test_a_new_cluster_or_a_2x_restore_changes_nothing(deploy):
    assert deploy(None) == ["kube-vip"]
    assert deploy("2.6.1") == ["kube-vip"]


# --- LVM --------------------------------------------------------------------
@pytest.fixture
def lvm(tmp_path):
    bin_dir, root = tmp_path / "bin", tmp_path / "root"
    bin_dir.mkdir()
    root.mkdir()
    log = tmp_path / "lvm.log"
    fake(bin_dir, "vgdisplay", "exit 0\n")
    fake(bin_dir, "lvdisplay", "exit 1\n")
    fake(bin_dir, "lvs", 'printf "%s\\n" "$LVS"\n')
    for cmd in ("lvrename", "lvcreate"):
        fake(bin_dir, cmd, 'echo "%s $*" >> "%s"\n' % (cmd, log))

    def run(lvs):
        env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
                   K4ALL_ROOT=str(root), LVS=lvs)
        proc = subprocess.run(["bash", SETUP_LVM], env=env, capture_output=True,
                              text=True, check=False)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        return log.read_text().splitlines() if log.exists() else []

    return run


def test_a_hand_made_thin_pool_is_renamed_to_thin_pool(lvm):
    calls = lvm("  pool0 thin-pool\n  pvc-a thin\n  multimedia linear")
    assert calls == ["lvrename vg_data pool0 thin-pool"]


def test_a_fresh_vg_data_gets_a_thin_pool(lvm):
    assert lvm("") == ["lvcreate -l 100%FREE -T -n thin-pool vg_data"]


def test_thick_volumes_without_a_pool_are_left_alone(lvm):
    assert lvm("  pvc-a linear") == []


# --- hostname ----------------------------------------------------------------
def test_one_domain_when_two_links_have_dhcp(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake(bin_dir, "systemd-resolve", """\
        echo "Link 2 (ens18)"; echo "  DNS Domain: example.lan"
        echo "Link 3 (ens19)"; echo "  DNS Domain: example.lan"
    """)
    script = read(SET_HOSTNAME)
    function = script[script.index("function get_domain()"):script.index("# Attempt to retrieve")]
    proc = subprocess.run(["bash", "-c", function + "\nget_domain"],
                          env=dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"])),
                          capture_output=True, text=True, check=False)
    assert proc.stdout == "example.lan\n"
