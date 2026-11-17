from pathlib import Path
from unittest.mock import patch

import pytest

from com_k4all_installer.storage_layout import (
    StorageLayoutError,
    build_kickstart_layout,
    discover_unattended_layout,
)


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
