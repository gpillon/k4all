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
import yaml

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


def keyfile(path, iface, uuid=None):
    path.write_text("[connection]\nid=%s\nuuid=%s\ninterface-name=%s\n"
                    % (path.stem, uuid or path.stem, iface))


@pytest.fixture
def nm(tmp_path):
    """The restored profiles, as k4all-restore.sh has copied them to nm/."""
    restored, nm_dir, aside = tmp_path / "restored", tmp_path / "nm", tmp_path / "aside"
    restored.mkdir()
    nm_dir.mkdir()
    keyfile(restored / "ovs-port-eth-int.nmconnection", "ens18", "u-port")
    keyfile(restored / "ovs-bridge.nmconnection", "ovs-bridge", "u-bridge")
    # A v1 node's static profile from before the bridge, inactive there.
    keyfile(restored / "ens18.nmconnection.disabled", "ens18", "u-old")
    for f in restored.iterdir():
        (nm_dir / f.name).write_text(f.read_text())
    keyfile(nm_dir / "ens18.nmconnection", "ens18", "u-installer")   # the installer's DHCP
    keyfile(nm_dir / "ens20.nmconnection", "ens20", "u-ens20")       # a NIC the backup does not have

    def run(active=None):
        active_file = tmp_path / "active-connections.txt"
        if active is not None:
            active_file.write_text("".join("%s:dev\n" % u for u in active))
        proc = run_restore_function('disable_conflicting_nm_profiles "%s" "%s" "%s" "%s"'
                                    % (restored, nm_dir, active_file, aside), dict(os.environ))
        assert proc.returncode == 0, proc.stderr
        return (sorted(os.listdir(nm_dir)),
                sorted(os.listdir(aside)) if aside.exists() else [])

    return run


def test_what_was_active_on_the_old_node_keeps_the_nic(nm):
    kept, aside = nm(active=["u-port", "u-bridge"])
    assert kept == ["ens20.nmconnection", "ovs-bridge.nmconnection",
                    "ovs-port-eth-int.nmconnection"]
    # Out of system-connections: NetworkManager loads keyfiles whatever their name.
    assert aside == ["ens18.nmconnection", "ens18.nmconnection.disabled"]


def test_without_the_active_list_only_the_installer_profiles_move(nm):
    kept, aside = nm(active=None)
    assert "ens18.nmconnection.disabled" in kept
    assert aside == ["ens18.nmconnection"]


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


@pytest.fixture
def restored_config(tmp_path):
    """deploy-operator.sh's handling of the installer's ClusterConfig on a
    restored cluster, on a copy of the image's default config."""
    if YQ is None:
        pytest.skip("needs mikefarah yq v4 (K4ALL_TEST_YQ or PATH)")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "yq").symlink_to(YQ)
    config = tmp_path / "k4all-config.yaml"
    script = read(DEPLOY_OPERATOR)
    functions = tmp_path / "functions.sh"
    functions.write_text(script[script.index("RESTORED_FROM_FILE="):
                                script.index("create_release_manifest_cr() {")])
    marker = tmp_path / "restored-from-version"
    env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
               RESTORED_FROM_FILE=str(marker), CONFIG_YAML=str(config))

    def run(version, spec_edit=None):
        default = yaml.safe_load(read(BOOTC, "overlay", "etc", "k4all-config.yaml.default"))
        if spec_edit:
            spec_edit(default["spec"])
        config.write_text(yaml.safe_dump(default))
        if version:
            marker.write_text(version + "\n")
        proc = subprocess.run(
            ["bash", "-c", 'source "$1"; drop_new_install_defaults', "bash",
             str(functions)], env=env, capture_output=True, text=True, check=False)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        return yaml.safe_load(config.read_text())["spec"]

    return run


def test_a_cluster_restored_from_1x_gets_no_new_install_settings(restored_config):
    # The installer wrote the defaults of a new v2.7.0 install. A cluster
    # restored from 1.x was not made by this release (its components stay
    # Unmanaged): maxPods 250 would roll its nodes' kubelets, the metadata
    # service would come with virt. Absent, k4all owns neither (spec §3).
    spec = restored_config("1.8.0")
    assert "nodes" not in spec
    assert "metadata" not in spec["features"]["virt"]
    assert spec["features"]["rook"] == {"enabled": False}


def test_a_new_cluster_or_a_2x_restore_keeps_the_installer_settings(restored_config):
    for version in (None, "2.6.1"):
        spec = restored_config(version)
        assert spec["nodes"] == {"kubelet": {"maxPods": 250}}
        assert spec["features"]["virt"]["metadata"] == {"enabled": True, "scope": "Labelled"}


def test_a_1x_restore_keeps_what_the_kickstart_chose(restored_config):
    def chosen(spec):
        spec["nodes"]["kubelet"]["maxPods"] = 300
        spec["features"]["virt"]["metadata"]["scope"] = "All"
    spec = restored_config("1.8.0", chosen)
    assert spec["nodes"] == {"kubelet": {"maxPods": 300}}
    assert spec["features"]["virt"]["metadata"] == {"enabled": True, "scope": "All"}


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


# --- found on the second run (A2) ------------------------------------------
@pytest.mark.parametrize("before, after", [
    ('KUBELET_KUBEADM_ARGS="--volume-plugin-dir=/x"\n',
     'KUBELET_KUBEADM_ARGS="--node-ip=10.0.0.5 --volume-plugin-dir=/x"\n'),
    ('KUBELET_KUBEADM_ARGS="--node-ip=10.0.0.9"\n',
     'KUBELET_KUBEADM_ARGS="--node-ip=10.0.0.9"\n'),
])
def test_the_restored_node_keeps_its_ip(tmp_path, before, after):
    flags = tmp_path / "kubeadm-flags.env"
    flags.write_text(before)
    proc = run_restore_function('pin_node_ip "%s" 10.0.0.5' % flags, dict(os.environ))
    assert proc.returncode == 0, proc.stderr
    assert flags.read_text() == after


def test_the_backup_records_the_node_ip():
    script = read(BIN, "k4all-backup.sh")
    assert '"node_ip": "${NODE_IP}"' in script
    assert "pin_node_ip /var/lib/kubelet/kubeadm-flags.env" in read(RESTORE)


def test_restored_node_files_get_their_selinux_label(tmp_path):
    node, etc = tmp_path / "node", tmp_path / "etc"
    (node / "etc").mkdir(parents=True)
    (node / "etc/sysctl.conf").write_text("fs.file-max = 1\n")
    etc.mkdir()
    proc = run_restore_function(
        'restore_node_customizations "%s" "%s"; printf "%%s\\n" "${RESTORED_PATHS[@]}"'
        % (node, etc), dict(os.environ))
    assert proc.returncode == 0, proc.stderr
    assert str(etc / "sysctl.conf") in proc.stdout.split()
    script = read(RESTORE)
    # cp -a would keep the tmp_t label of the unpacked archive.
    assert 'cp --preserve=mode,ownership,timestamps "$node_dir/etc/$rel"' in script
    assert '"${RESTORED_PATHS[@]}"' in script[script.index("restore_selinux_contexts() {"):]


def test_a_renamed_pool_is_recorded(lvm, tmp_path):
    lvm("  pool0 thin-pool")
    assert (tmp_path / "root/opt/k4all/thin-pool-renamed-from").read_text() == "pool0\n"


def test_lvmd_follows_the_renamed_pool(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "kubectl.log"
    lvmd = "device-classes:\n  - name: default\n    thin-pool:\n      name: pool0\n"
    (tmp_path / "lvmd.yaml").write_text(lvmd)
    fake(bin_dir, "kubectl", """\
        echo "$*" >> "%s"
        case "$*" in
          "get cm -A -o jsonpath="*) echo "topolvm-system topolvm-lvmd-0" ;;
          "-n topolvm-system get cm topolvm-lvmd-0 -o jsonpath="*) cat "%s" ;;
          *"create cm topolvm-lvmd-0 --from-file=lvmd.yaml="*)
            for a in "$@"; do
              case "$a" in --from-file=lvmd.yaml=*) cp "${a#--from-file=lvmd.yaml=}" "%s/applied.yaml" ;; esac
            done ;;
          "get pods -A -l app.kubernetes.io/name=topolvm"*)
            echo "topolvm-system topolvm-controller-1"
            echo "topolvm-system topolvm-lvmd-0-abc"
            echo "topolvm-system topolvm-node-def" ;;
        esac
    """ % (log, tmp_path / "lvmd.yaml", tmp_path))
    marker = tmp_path / "thin-pool-renamed-from"
    marker.write_text("pool0\n")
    script = read(DEPLOY_OPERATOR)
    functions = tmp_path / "functions.sh"
    functions.write_text(script[script.index("POOL_RENAMED_FILE="):
                                script.index("create_release_manifest_cr() {")])
    env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
               POOL_RENAMED_FILE=str(marker))
    proc = subprocess.run(["bash", "-c", 'source "$1"; update_topolvm_after_pool_rename',
                           "bash", str(functions)], env=env, capture_output=True,
                          text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "name: thin-pool" in (tmp_path / "applied.yaml").read_text()
    deleted = [c for c in log.read_text().splitlines() if " delete pod " in c]
    assert deleted == ["-n topolvm-system delete pod topolvm-lvmd-0-abc --wait=false",
                       "-n topolvm-system delete pod topolvm-node-def --wait=false"]
    assert not marker.exists() and (tmp_path / "thin-pool-renamed-from.done").exists()


def test_ovs_transient_ports_wait_for_the_database():
    dropin = read(BOOTC, "overlay", "usr", "lib", "systemd", "system",
                  "ovs-delete-transient-ports.service.d", "10-k4all-after-ovsdb.conf")
    assert "After=ovsdb-server.service" in dropin
    assert "TimeoutStartSec=" in dropin
    assert "/usr/lib/systemd/system/ovs-delete-transient-ports.service.d/" in read(BOOTC, "Containerfile")
