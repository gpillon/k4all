# K4All Anaconda Addon - shared storage layout
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""Build the K4All Kickstart storage layout.

The graphical/TUI spokes and unattended ``%pre`` scripts use this module as
their single source of truth.  Existing ``vg_data`` physical volumes are
never included in a ``clearpart`` command.
"""

import argparse
import json
import os
import subprocess


DEFAULT_OS_PERCENT = 80
MIN_OS_MIB = 8192
MIN_DISK_MIB = 10240
BOOT_MIB = 1024
EFI_MIB = 600
BIOSBOOT_MIB = 1
LAYOUT_MARGIN_MIB = 100


class StorageLayoutError(RuntimeError):
    """Raised when a safe automatic layout cannot be produced."""


def _device_name(value):
    """Return the Kickstart device name (without the ``/dev/`` prefix)."""
    value = str(value or "").strip()
    if value.startswith("/dev/"):
        return value[5:]
    return value


def _unique(values):
    result = []
    for value in values:
        value = _device_name(value)
        if value and value not in result:
            result.append(value)
    return result


def build_kickstart_layout(
        disk_name, disk_mib, is_efi=False, os_percent=DEFAULT_OS_PERCENT,
        disk_partitions=(), preserved_vgs=None, pv_parent_disks=None):
    """Return Kickstart commands for the K4All disk layout.

    ``preserved_vgs`` maps existing VG names to their PV device names.
    Partitions backing those PVs are excluded from selective clearing.  If a
    preserved PV is on the target disk, all other target partitions are
    cleared explicitly; the disk label itself is left untouched.
    """
    disk_name = _device_name(disk_name)
    if not disk_name:
        raise StorageLayoutError("no installation disk selected")
    if not 10 <= int(os_percent) <= 90:
        raise StorageLayoutError("OS percentage must be between 10 and 90")
    if int(disk_mib) < MIN_DISK_MIB:
        raise StorageLayoutError(
            "disk /dev/%s is too small (%s MiB; minimum %s MiB)" %
            (disk_name, disk_mib, MIN_DISK_MIB))

    preserved_vgs = preserved_vgs or {}
    preserved_vgs = {
        str(name): _unique(pvs)
        for name, pvs in preserved_vgs.items()
        if name and pvs
    }
    pv_parent_disks = {
        _device_name(pv): _device_name(parent)
        for pv, parent in (pv_parent_disks or {}).items()
    }
    target_partitions = _unique(disk_partitions)
    preserved_pvs = {
        pv for pvs in preserved_vgs.values() for pv in pvs
    }
    unmapped_pvs = {
        pv for pv in preserved_pvs
        if pv != disk_name and not pv_parent_disks.get(pv)
    }
    if unmapped_pvs:
        raise StorageLayoutError(
            "cannot safely locate preserved PV(s): %s" %
            ", ".join(sorted(unmapped_pvs)))
    target_preserved_pvs = {
        pv for pv in preserved_pvs
        if pv_parent_disks.get(pv) == disk_name or pv == disk_name
    }

    visible_disks = [disk_name]
    for pv in sorted(preserved_pvs):
        parent = pv_parent_disks.get(pv)
        if parent and parent not in visible_disks:
            visible_disks.append(parent)

    lines = [
        "ignoredisk --only-use=%s" % ",".join(visible_disks),
    ]

    if target_preserved_pvs:
        deletable = [
            part for part in target_partitions
            if part not in target_preserved_pvs
        ]
        if deletable:
            lines.append("clearpart --list=%s" % ",".join(deletable))
    else:
        lines.extend([
            "zerombr",
            ("clearpart --all --initlabel --disklabel=gpt --drives=%s" %
             disk_name),
        ])

    lines.append(
        "bootloader --location=mbr --boot-drive=%s" % disk_name)
    if is_efi:
        lines.append(
            "part /boot/efi --fstype=efi --size=%d --ondisk=%s" %
            (EFI_MIB, disk_name))
        platform_mib = EFI_MIB
    else:
        lines.append(
            "part biosboot --fstype=biosboot --size=%d --ondisk=%s" %
            (BIOSBOOT_MIB, disk_name))
        platform_mib = BIOSBOOT_MIB

    lines.append(
        "part /boot --fstype=xfs --size=%d --ondisk=%s" %
        (BOOT_MIB, disk_name))

    # An existing vg_data keeps its current size.  The OS therefore consumes
    # the free space created by removing the old non-data partitions.  On a
    # fresh disk the requested percentage is applied to usable space and the
    # remainder becomes vg_data.
    create_vg_data = "vg_data" not in preserved_vgs
    if create_vg_data:
        usable_mib = int(disk_mib) - BOOT_MIB - platform_mib - LAYOUT_MARGIN_MIB
        os_mib = usable_mib * int(os_percent) // 100
        if os_mib < MIN_OS_MIB:
            raise StorageLayoutError(
                "80/20 layout leaves less than %s MiB for the OS" % MIN_OS_MIB)
        lines.extend([
            "part pv.01 --size=%d --ondisk=%s" %
            (os_mib, disk_name),
            "part pv.02 --size=1 --grow --ondisk=%s" % disk_name,
        ])
    else:
        lines.append(
            "part pv.01 --size=1 --grow --ondisk=%s" % disk_name)

    lines.extend([
        "volgroup rootvg pv.01",
        ("logvol / --vgname=rootvg --fstype=xfs --size=1 --grow "
         "--name=rootlv"),
    ])

    if create_vg_data:
        lines.append("volgroup vg_data pv.02")
    else:
        for vg_name in sorted(preserved_vgs):
            lines.append("volgroup %s --noformat" % vg_name)

    return "\n".join(lines) + "\n"


def _run_json(command):
    result = subprocess.run(
        command, check=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True)
    return json.loads(result.stdout)


def _flatten_lsblk(nodes, parent=None):
    result = []
    for node in nodes:
        item = dict(node)
        if not item.get("pkname") and parent:
            item["pkname"] = parent.get("kname") or parent.get("name")
        result.append(item)
        result.extend(_flatten_lsblk(node.get("children", []), item))
    return result


def _block_inventory():
    data = _run_json([
        "lsblk", "--json", "--bytes",
        "--output", "NAME,KNAME,PATH,TYPE,SIZE,PKNAME,RM,RO,MOUNTPOINT",
    ])
    return _flatten_lsblk(data.get("blockdevices", []))


def _find_node(inventory, device):
    wanted = _device_name(device)
    for node in inventory:
        candidates = {
            _device_name(node.get("name")),
            _device_name(node.get("kname")),
            _device_name(node.get("path")),
        }
        if wanted in candidates:
            return node
    return None


def _root_disk_name(inventory, device):
    node = _find_node(inventory, device)
    seen = set()
    while node and node.get("type") != "disk":
        marker = node.get("kname") or node.get("name")
        if marker in seen:
            return ""
        seen.add(marker)
        parent = node.get("pkname")
        if not parent:
            return ""
        node = _find_node(inventory, parent)
    return _device_name((node or {}).get("kname") or (node or {}).get("name"))


def _existing_vg_data_pvs():
    data = _run_json([
        "pvs", "--reportformat", "json", "--units", "b", "--nosuffix",
        "--options", "pv_name,vg_name",
    ])
    pvs = []
    for report in data.get("report", []):
        for pv in report.get("pv", []):
            if str(pv.get("vg_name", "")).strip() == "vg_data":
                name = str(pv.get("pv_name", "")).strip()
                if name:
                    pvs.append(name)
    return _unique(pvs)


def discover_unattended_layout(disk_name=""):
    """Discover target disk and any existing ``vg_data`` PVs."""
    inventory = _block_inventory()
    disks = [
        node for node in inventory
        if node.get("type") == "disk"
        and not bool(node.get("ro"))
        and int(node.get("size") or 0) >= MIN_DISK_MIB * 1024 * 1024
    ]
    if disk_name:
        selected = _find_node(disks, disk_name)
        if not selected:
            raise StorageLayoutError(
                "requested installation disk %s is not usable" % disk_name)
    else:
        # Prefer fixed disks.  Stable kernel order is safer than silently
        # choosing the largest disk, which is often the user's data disk.
        disks.sort(key=lambda item: (
            bool(item.get("rm")),
            _device_name(item.get("kname") or item.get("name"))))
        if not disks:
            raise StorageLayoutError("no usable installation disk found")
        selected = disks[0]

    target = _device_name(selected.get("kname") or selected.get("name"))
    disk_mib = int(selected.get("size") or 0) // (1024 * 1024)
    vg_data_pvs = _existing_vg_data_pvs()

    pv_parent_disks = {}
    for pv in vg_data_pvs:
        parent = _root_disk_name(inventory, pv)
        if not parent:
            raise StorageLayoutError(
                "cannot determine the parent disk for vg_data PV %s" % pv)
        pv_parent_disks[_device_name(pv)] = parent

    partitions = []
    for node in inventory:
        if node.get("type") != "part":
            continue
        name = _device_name(node.get("kname") or node.get("name"))
        if _root_disk_name(inventory, name) == target:
            partitions.append(name)

    return {
        "disk_name": target,
        "disk_mib": disk_mib,
        "disk_partitions": partitions,
        "preserved_vgs": {"vg_data": vg_data_pvs} if vg_data_pvs else {},
        "pv_parent_disks": pv_parent_disks,
    }


def write_unattended_layout(output, disk_name="",
                            os_percent=DEFAULT_OS_PERCENT):
    """Discover storage and write the unattended Kickstart include."""
    # Existing swap can prevent Anaconda from deleting an old OS partition.
    # This only affects the installer environment; the generated target has
    # no swap partition or logical volume.
    subprocess.run(
        ["swapoff", "--all"], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, check=False)
    layout = discover_unattended_layout(disk_name=disk_name)
    text = build_kickstart_layout(
        is_efi=os.path.isdir("/sys/firmware/efi"),
        os_percent=os_percent,
        **layout
    )
    with open(output, "w", encoding="utf-8") as stream:
        stream.write(text)
    return text


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Generate the safe K4All Anaconda storage layout")
    parser.add_argument("--output", required=True)
    parser.add_argument("--disk", default="")
    parser.add_argument(
        "--os-percent", type=int, default=DEFAULT_OS_PERCENT)
    args = parser.parse_args(argv)
    try:
        text = write_unattended_layout(
            args.output, disk_name=args.disk, os_percent=args.os_percent)
    except (OSError, subprocess.SubprocessError, ValueError,
            StorageLayoutError) as error:
        parser.exit(1, "k4all storage layout: %s\n" % error)
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
