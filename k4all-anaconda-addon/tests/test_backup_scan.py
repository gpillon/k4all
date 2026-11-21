"""Backup discovery shared by the Storage & Backup spokes."""

import io
import json
import tarfile
from types import SimpleNamespace

from com_k4all_installer import backup_scan


def make_backup(path, marker="K4ALL_BACKUP_V2"):
    path.parent.mkdir(parents=True, exist_ok=True)
    info = json.dumps({"marker": marker, "hostname": "node", "node_type": "bootstrap",
                       "k4all_version": "1.8.0"}).encode()
    with tarfile.open(path, "w:gz") as tf:
        ti = tarfile.TarInfo("./metadata/backup-info.json")
        ti.size = len(info)
        tf.addfile(ti, io.BytesIO(info))
    return path


class FakeTree:
    """The bits of Anaconda's DeviceTree proxy the scan uses."""

    def __init__(self, devices, mount_ok=True):
        self.devices = devices
        self.mount_ok = mount_ok
        self.mounts = []

    def GetDevices(self):
        return list(self.devices)

    def GetDeviceData(self, dev):
        return self.devices[dev]

    def GetFormatData(self, dev):
        return self.devices[dev].get("format", {})

    def FindOpticalMedia(self):
        return []

    def MountDevice(self, dev, mount_point, options):
        self.mounts.append((dev, options))
        if not self.mount_ok:
            raise RuntimeError("cannot mount")

    def UnmountDevice(self, dev, mount_point):
        pass


def lvm_tree(**kwargs):
    xfs = {"mountable": True, "type": "xfs"}
    return FakeTree({
        "sda5": {"type": "partition", "name": "sda5", "parents": ["sda"],
                 "format": {"mountable": False, "type": "lvmpv"}},
        "LVM-vg_data": {"type": "lvmvg", "name": "vg_data", "parents": ["sda5"]},
        "LVM-vg_data-pool0": {"type": "lvmthinpool", "name": "vg_data-pool0",
                              "parents": ["LVM-vg_data"]},
        "LVM-vg_data-multimedia": {"type": "lvmlv", "name": "vg_data-multimedia",
                                   "path": "/dev/mapper/vg_data-multimedia",
                                   "parents": ["LVM-vg_data"], "format": xfs},
        "LVM-vg_data-pvc": {"type": "lvmthinlv", "name": "vg_data-pvc",
                            "path": "/dev/mapper/vg_data-pvc",
                            "parents": ["LVM-vg_data-pool0"], "format": xfs},
    }, **kwargs)


class Runner:
    def __init__(self, ok=True):
        self.calls = []
        self.ok = ok

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        return SimpleNamespace(returncode=0 if self.ok else 1)


def test_volume_groups_are_named_not_device_ids():
    tree = lvm_tree()

    assert backup_scan.volume_groups(tree, "LVM-vg_data-multimedia") == ["vg_data"]
    # A thin LV's parent is its pool; the VG is one level up.
    assert backup_scan.volume_groups(tree, "LVM-vg_data-pvc") == ["vg_data"]


def test_an_lv_is_activated_by_vg_name_and_mounted_read_only(tmp_path):
    tree, run = lvm_tree(), Runner()
    activated = []

    unmount = backup_scan.mount_read_only(tree, "LVM-vg_data-multimedia",
                                          str(tmp_path), activated, run=run)

    assert unmount is not None
    assert run.calls == [["vgchange", "-ay", "vg_data"]]
    assert activated == ["vg_data"]
    assert tree.mounts == [("LVM-vg_data-multimedia", "ro")]


def test_the_fallback_mount_is_read_only_too(tmp_path):
    tree, run = lvm_tree(mount_ok=False), Runner()

    backup_scan.mount_read_only(tree, "LVM-vg_data-multimedia", str(tmp_path),
                                [], run=run)

    mounts = [c for c in run.calls if c[0] == "mount"]
    assert mounts == [["mount", "-o", "ro", "/dev/mapper/vg_data-multimedia",
                       str(tmp_path)]]


def test_the_default_backup_dir_of_an_ostree_root_is_found(tmp_path):
    # k4all-backup.sh's default on FCOS (v1.x): depth 6 from the root.
    deep = tmp_path / "ostree/deploy/fedora-coreos/var/opt/k4all/backups"
    archive = make_backup(deep / "k4all-backup-bootstrap-node-1.tar.gz")
    top = make_backup(tmp_path / "k4all-backup-bootstrap-node-2.tar.gz")

    found = backup_scan.find_archives(str(tmp_path))

    assert str(top) in found
    assert str(archive) in found


def test_other_files_deep_in_the_tree_are_not_walked(tmp_path):
    deep = tmp_path / "a/b/c/d/e/f/g"
    make_backup(deep / "k4all-backup-x.tar.gz")

    assert backup_scan.find_archives(str(tmp_path)) == []


def test_only_k4all_backups_validate(tmp_path):
    good = make_backup(tmp_path / "k4all-backup-good.tar.gz")
    bad = make_backup(tmp_path / "k4all-backup-bad.tar.gz", marker="OTHER")

    assert backup_scan.validate_backup(str(good))["hostname"] == "node"
    assert backup_scan.validate_backup(str(bad)) is None


def test_scan_finds_the_backup_on_an_lv_and_restores_the_vg_state(tmp_path):
    tree, run = lvm_tree(), Runner()
    mount_base = tmp_path / "scan"

    def mount_device(dev, mount_point, options):
        tree.mounts.append((dev, options))
        if dev == "LVM-vg_data-multimedia":
            make_backup(tmp_path / "scan" / dev / "k4all-backup-bootstrap-n.tar.gz")

    tree.MountDevice = mount_device
    persisted = []

    def persist(path):
        persisted.append(path)
        return path

    found = backup_scan.scan(tree, str(mount_base), persist, static_dirs=(), run=run)

    assert [b["source"] for b in found] == ["LVM-vg_data-multimedia"]
    assert found[0]["info"]["k4all_version"] == "1.8.0"
    assert all(opts == "ro" for _, opts in tree.mounts)
    assert ["vgchange", "-an", "vg_data"] in run.calls
