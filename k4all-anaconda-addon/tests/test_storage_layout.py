from pathlib import Path
from unittest.mock import patch

import pytest

from com_k4all_installer.storage_layout import (
    LayoutNotApplied,
    StorageLayoutError,
    apply_layout,
    build_kickstart_layout,
    discover_unattended_layout,
    existing_biosboot_partitions,
)

# The partitions of a k4all 1.x node (Fedora CoreOS image), vg_data on sda5.
FCOS_NODE = {
    "disk_partitions": ["sda1", "sda2", "sda3", "sda4", "sda5"],
    "preserved_vgs": {"vg_data": ["sda5"]},
    "pv_parent_disks": {"sda5": "sda"},
}


def test_fresh_disk_is_80_20_without_swap():
    ks = build_kickstart_layout("vda", 61440, os_percent=80)

    # (61440 - 1024 boot - 1 biosboot - 100 margin) * 80%
    assert "part pv.01 --size=48252 --ondisk=vda" in ks
    assert "part pv.02 --size=1 --grow --ondisk=vda" in ks
    assert "volgroup vg_data pv.02" in ks
    assert "clearpart --all --initlabel --disklabel=gpt --drives=vda" in ks
    assert "swap" not in ks.lower()


def test_efi_layout_has_efi_and_no_biosboot():
    ks = build_kickstart_layout("nvme0n1", 61440, is_efi=True)

    assert "part /boot/efi --fstype=efi --size=600 --ondisk=nvme0n1" in ks
    assert "biosboot" not in ks


def test_generated_layout_parses_with_real_pykickstart_when_available():
    try:
        from pykickstart.parser import KickstartParser
        from pykickstart.version import makeVersion
    except (ImportError, ModuleNotFoundError):
        pytest.skip("real pykickstart is not installed")

    parser = KickstartParser(makeVersion())
    parser.readKickstartFromString(
        build_kickstart_layout("vda", 61440, os_percent=80))


def test_existing_vg_data_pv_on_target_is_never_cleared():
    ks = build_kickstart_layout(
        "vda",
        61440,
        disk_partitions=["vda1", "vda2", "vda3", "vda4"],
        preserved_vgs={"vg_data": ["/dev/vda4"]},
        pv_parent_disks={"/dev/vda4": "vda"},
    )

    clear_line = next(line for line in ks.splitlines()
                      if line.startswith("clearpart"))
    assert clear_line == "clearpart --list=vda1,vda2,vda3"
    assert "vda4" not in clear_line
    assert "--all" not in clear_line
    assert "--initlabel" not in clear_line
    assert "volgroup vg_data --noformat" in ks
    assert "pv.02" not in ks
    assert "swap" not in ks.lower()


def test_vg_data_on_other_disk_is_visible_but_never_cleared():
    ks = build_kickstart_layout(
        "vda",
        61440,
        disk_partitions=["vda1", "vda2"],
        preserved_vgs={"vg_data": ["sdb1"]},
        pv_parent_disks={"sdb1": "sdb"},
    )

    assert "ignoredisk --only-use=vda,sdb" in ks
    assert "clearpart --all --initlabel --disklabel=gpt --drives=vda" in ks
    assert "sdb1" not in next(
        line for line in ks.splitlines() if line.startswith("clearpart"))
    assert "volgroup vg_data --noformat" in ks


def test_kept_label_reuses_the_existing_biosboot():
    # gpillon/k4all#52: a new 1 MiB biosboot cannot be allocated in the
    # label of a Fedora CoreOS image on a Smart Array P420 (optimal I/O size
    # 1.5 MiB).  The layout reuses sda1 and keeps vg_data.  This is the
    # layout tried on a disk with the P420 geometry (scsi_debug) and
    # installed on the replica of the node.
    ks = build_kickstart_layout(
        "sda", 102400, biosboot_partitions=["sda1"], **FCOS_NODE)

    assert ks == (
        "ignoredisk --only-use=sda\n"
        "clearpart --list=sda2,sda3,sda4\n"
        "bootloader --location=mbr --boot-drive=sda\n"
        "part biosboot --fstype=biosboot --onpart=sda1\n"
        "part /boot --fstype=xfs --size=1024 --ondisk=sda\n"
        "part pv.01 --size=1 --grow --ondisk=sda\n"
        "volgroup rootvg pv.01\n"
        "logvol / --vgname=rootvg --fstype=xfs --size=1 --grow --name=rootlv\n"
        "volgroup vg_data --noformat\n"
    )


def test_efi_boot_clears_the_old_biosboot():
    ks = build_kickstart_layout(
        "sda", 102400, is_efi=True, biosboot_partitions=["sda1"],
        **FCOS_NODE)

    assert "clearpart --list=sda1,sda2,sda3,sda4" in ks
    assert "biosboot" not in ks
    assert "part /boot/efi --fstype=efi --size=600 --ondisk=sda" in ks


def test_new_label_allocates_a_new_biosboot():
    # zerombr + --initlabel write a new label whose usable area starts at
    # sector 34: the 1 MiB biosboot fits there on the P420 too.
    ks = build_kickstart_layout(
        "sda", 102400, disk_partitions=["sda1", "sda2"],
        biosboot_partitions=["sda1"])

    assert "clearpart --all --initlabel --disklabel=gpt --drives=sda" in ks
    assert "part biosboot --fstype=biosboot --size=1 --ondisk=sda" in ks
    assert "--onpart" not in ks


def test_biosboot_of_another_disk_or_a_kept_pv_is_not_reused():
    ks = build_kickstart_layout(
        "sda", 102400, biosboot_partitions=["sdb1", "sda5"], **FCOS_NODE)

    assert "clearpart --list=sda1,sda2,sda3,sda4" in ks
    assert "part biosboot --fstype=biosboot --size=1 --ondisk=sda" in ks
    assert "--onpart" not in ks


def test_reused_biosboot_layout_parses_with_real_pykickstart_when_available():
    try:
        from pykickstart.parser import KickstartParser
        from pykickstart.version import makeVersion
    except (ImportError, ModuleNotFoundError):
        pytest.skip("real pykickstart is not installed")

    parser = KickstartParser(makeVersion())
    parser.readKickstartFromString(build_kickstart_layout(
        "sda", 102400, biosboot_partitions=["sda1"], **FCOS_NODE))


def test_invalid_or_too_small_layout_fails_closed():
    with pytest.raises(StorageLayoutError):
        build_kickstart_layout("vda", 9000)
    with pytest.raises(StorageLayoutError):
        build_kickstart_layout("vda", 61440, os_percent=95)


def test_preserved_pv_without_known_parent_fails_closed():
    with pytest.raises(StorageLayoutError, match="cannot safely locate"):
        build_kickstart_layout(
            "vda",
            61440,
            disk_partitions=["vda1", "vda2"],
            preserved_vgs={"vg_data": ["vda2"]},
        )


def test_discovery_maps_vg_data_pv_to_its_parent_disk():
    inventory = [
        {"name": "vda", "kname": "vda", "path": "/dev/vda",
         "type": "disk", "size": 60 * 1024 ** 3, "rm": False,
         "ro": False},
        {"name": "vda1", "kname": "vda1", "path": "/dev/vda1",
         "type": "part", "size": 1024 ** 3, "pkname": "vda"},
        {"name": "vda2", "kname": "vda2", "path": "/dev/vda2",
         "type": "part", "size": 20 * 1024 ** 3, "pkname": "vda"},
        {"name": "vda3", "kname": "vda3", "path": "/dev/vda3",
         "type": "part", "size": 39 * 1024 ** 3, "pkname": "vda"},
    ]
    with patch(
            "com_k4all_installer.storage_layout._block_inventory",
            return_value=inventory), patch(
            "com_k4all_installer.storage_layout._existing_vg_data_pvs",
            return_value=["vda3"]):
        result = discover_unattended_layout()

    assert result["disk_name"] == "vda"
    assert result["disk_partitions"] == ["vda1", "vda2", "vda3"]
    assert result["preserved_vgs"] == {"vg_data": ["vda3"]}
    assert result["pv_parent_disks"] == {"vda3": "vda"}


def test_discovery_finds_the_biosboot_by_partition_type():
    inventory = [
        {"name": "sda", "kname": "sda", "path": "/dev/sda",
         "type": "disk", "size": 100 * 1024 ** 3, "rm": False,
         "ro": False},
        {"name": "sda1", "kname": "sda1", "type": "part", "pkname": "sda",
         "size": 1024 ** 2,
         "parttype": "21686148-6449-6E6F-744E-656564454649"},
        {"name": "sda2", "kname": "sda2", "type": "part", "pkname": "sda",
         "size": 127 * 1024 ** 2,
         "parttype": "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"},
        {"name": "sda5", "kname": "sda5", "type": "part", "pkname": "sda",
         "size": 60 * 1024 ** 3,
         "parttype": "0fc63daf-8483-4772-8e79-3d69d8477de4"},
    ]
    with patch(
            "com_k4all_installer.storage_layout._block_inventory",
            return_value=inventory), patch(
            "com_k4all_installer.storage_layout._existing_vg_data_pvs",
            return_value=["sda5"]):
        result = discover_unattended_layout()

    assert result["biosboot_partitions"] == ["sda1"]
    ks = build_kickstart_layout(is_efi=False, **result)
    assert "part biosboot --fstype=biosboot --onpart=sda1" in ks
    assert "clearpart --list=sda2" in ks


class FakeDeviceTree:
    def __init__(self, formats):
        self.formats = formats

    def GetFormatData(self, name):
        if name not in self.formats:
            raise LookupError(name)
        return {"type": self.formats[name]}


def test_existing_biosboot_partitions_reads_the_device_tree():
    tree = FakeDeviceTree({
        "sda1": "biosboot", "sda2": "efi", "sda3": "ext4", "sda5": "lvmpv"})

    assert existing_biosboot_partitions(
        tree, ["sda1", "sda2", "sda3", "sda4", "sda5"]) == ["sda1"]


class FakeTask:
    def __init__(self, error=None):
        self.error = error


class FakePartitioning:
    def __init__(self, error=None):
        self.error = error

    def ConfigureWithTask(self):
        return FakeTask(self.error)


class FakeStorage:
    def __init__(self, partitioning=None, errors=()):
        self.partitioning = partitioning
        self.errors = list(errors)
        self.applied = []
        self.read = []

    def ReadKickstart(self, ks_text):
        self.read.append(ks_text)
        return {"error-messages": [{"message": e} for e in self.errors]}

    @property
    def CreatedPartitioning(self):
        return [self.partitioning] if self.partitioning else []

    def ApplyPartitioning(self, partitioning):
        self.applied.append(partitioning)


def run_task(task):
    if task.error:
        raise task.error


def test_apply_layout_configures_and_applies_the_partitioning():
    partitioning = FakePartitioning()
    storage = FakeStorage(partitioning)

    apply_layout(storage, "part /boot", lambda obj: obj, run_task)

    assert storage.read == ["part /boot"]
    assert storage.applied == [partitioning]


def test_apply_layout_fails_when_the_partitions_cannot_be_allocated():
    # What the P420 gave on 2026-11-21: the spoke said "Layout APPLIED".
    error = RuntimeError(
        "failed to add partition to disk: Unable to satisfy all "
        "constraints on the partition.")
    storage = FakeStorage(FakePartitioning(error))

    with pytest.raises(LayoutNotApplied, match="Unable to satisfy"):
        apply_layout(storage, "part biosboot", lambda obj: obj, run_task)
    assert storage.applied == []


def test_apply_layout_fails_on_kickstart_errors():
    storage = FakeStorage(FakePartitioning(), errors=["unknown option"])

    with pytest.raises(LayoutNotApplied, match="unknown option"):
        apply_layout(storage, "part /x", lambda obj: obj, run_task)
    assert storage.applied == []


def test_apply_layout_fails_without_a_partitioning():
    with pytest.raises(LayoutNotApplied, match="no partitioning"):
        apply_layout(FakeStorage(None), "", lambda obj: obj, run_task)


@pytest.mark.parametrize("spoke", [
    "com_k4all_installer/gui/spokes/k4all_storage.py",
    "com_k4all_installer/tui/spokes/k4all_storage.py",
])
def test_spokes_mark_the_layout_applied_only_through_apply_layout(spoke):
    source = (Path(__file__).resolve().parents[1] / spoke).read_text()

    assert "apply_layout(" in source
    assert "biosboot_partitions=biosboot_partitions" in source
    assert "SetDiskLayoutApplied(True)" not in source
    assert "_disk_layout_applied = True" not in source
    assert "ConfigureWithTask" not in source


@pytest.mark.parametrize("relative_path", [
    "bootc/iso/config/unattended-bootstrap.toml",
    "bootc/iso/config/unattended-control.toml",
    "bootc/iso/config/unattended-worker.toml",
    "bootc/iso/ks/ks-bootstrap.cfg",
    "bootc/iso/ks/ks-worker.cfg",
])
def test_unattended_kickstarts_use_shared_swapless_layout(relative_path):
    parents = Path(__file__).resolve().parents
    if len(parents) < 3:
        pytest.skip("repository bootc files are not present in this container")
    repository = parents[2]
    path = repository / relative_path
    if not path.exists():
        pytest.skip("repository bootc files are not present in this container")
    contents = path.read_text()

    assert "/com_k4all_installer/storage_layout.py" in contents
    assert "--os-percent 80" in contents
    assert "logvol swap" not in contents
    assert "SWAP_MB" not in contents
