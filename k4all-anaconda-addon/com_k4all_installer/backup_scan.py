# K4All Anaconda Addon - backup archive discovery
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""Find K4All backup archives on the disks the installer sees.

The graphical and text Storage & Backup spokes share this module. Every
device is mounted read-only: the scan runs before the user chose what to
keep, so it must not change any filesystem (an xfs log replay included).
"""

import glob
import json
import os
import subprocess
import tarfile

ARCHIVE_PREFIX = "k4all-backup-"
ARCHIVE_SUFFIX = ".tar.gz"
BACKUP_MARKER = "K4ALL_BACKUP_V2"
MAX_DEPTH = 5

# Where k4all-backup.sh writes by default, below /var. On an ostree root
# (FCOS for v1.x, bootc for v2.x) /var is ostree/deploy/<stateroot>/var,
# deeper than MAX_DEPTH, so these are looked up explicitly.
KNOWN_VAR_DIRS = ("opt/k4all/backups", "opt/k4all/restore")

LV_TYPES = ("lvmlv", "lvmthinlv")


def unpack(val):
    """Unpack a GLib/dasbus Variant to a plain Python value."""
    if hasattr(val, "unpack"):
        return val.unpack()
    return val


def validate_backup(archive_path):
    """Return the backup's metadata, or None if it is not a K4All backup."""
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            member = next(
                (m for m in tf.getmembers()
                 if m.name.lstrip("./") == "metadata/backup-info.json"),
                None)
            if member is None:
                return None
            fh = tf.extractfile(member)
            if fh:
                data = json.loads(fh.read())
                if data.get("marker") == BACKUP_MARKER:
                    return data
    except Exception:
        pass
    return None


def _is_archive(name):
    return name.startswith(ARCHIVE_PREFIX) and name.endswith(ARCHIVE_SUFFIX)


def find_archives(base_dir):
    """Paths of backup archives below base_dir.

    Walks MAX_DEPTH levels, then the default backup directories of an
    ostree /var, which sit deeper.
    """
    found = []
    for root, dirs, files in os.walk(base_dir):
        depth = root.count(os.sep) - base_dir.count(os.sep)
        if depth > MAX_DEPTH:
            dirs.clear()
            continue
        found.extend(os.path.join(root, f) for f in sorted(files)
                     if _is_archive(f))
    var_dirs = [os.path.join(base_dir, "var")]
    var_dirs += sorted(glob.glob(os.path.join(base_dir, "ostree", "deploy",
                                              "*", "var")))
    for var in var_dirs:
        for sub in KNOWN_VAR_DIRS:
            for f in sorted(glob.glob(os.path.join(var, sub, "*"))):
                if _is_archive(os.path.basename(f)) and os.path.isfile(f):
                    found.append(f)
    unique = []
    for f in found:
        if f not in unique:
            unique.append(f)
    return unique


def volume_groups(dt_proxy, dev_name):
    """Names of the LVM volume groups an LV sits on.

    The parents in the device tree are device ids ("LVM-vg_data"), and a
    thin LV's parent is its pool: walk up to the lvmvg devices and use
    their names, which are what vgchange takes.
    """
    names = []
    pending = list(unpack(dt_proxy.GetDeviceData(dev_name).get("parents", [])))
    seen = set()
    while pending:
        dev = pending.pop(0)
        if dev in seen:
            continue
        seen.add(dev)
        data = dt_proxy.GetDeviceData(dev)
        if unpack(data.get("type", "")) == "lvmvg":
            name = unpack(data.get("name", ""))
            if name and name not in names:
                names.append(name)
        else:
            pending.extend(unpack(data.get("parents", [])))
    return names


def mountable_devices(dt_proxy):
    """Device ids worth scanning: mountable filesystems and optical media."""
    devices = []
    try:
        for dev_name in dt_proxy.GetDevices():
            try:
                fdata = dt_proxy.GetFormatData(dev_name)
                mountable = unpack(fdata.get("mountable", False))
                ftype = unpack(fdata.get("type", ""))
                if mountable and ftype not in ("", "biosboot", "lvmpv",
                                               "swap"):
                    devices.append(dev_name)
            except Exception:
                pass
    except Exception:
        pass
    try:
        for dev in dt_proxy.FindOpticalMedia():
            if dev not in devices:
                devices.append(dev)
    except Exception:
        pass
    return devices


def mount_read_only(dt_proxy, dev_name, mount_point, activated,
                    run=subprocess.run):
    """Mount dev_name read-only on mount_point.

    Volume groups activated on the way are added to ``activated``.
    Returns a function that unmounts it, or None if nothing was mounted.
    """
    data = dt_proxy.GetDeviceData(dev_name)
    dtype = unpack(data.get("type", ""))
    path = unpack(data.get("path", ""))

    if dtype in LV_TYPES:
        for vg in volume_groups(dt_proxy, dev_name):
            if vg in activated:
                continue
            r = run(["vgchange", "-ay", vg], capture_output=True, timeout=30)
            if r.returncode == 0:
                activated.append(vg)

    try:
        dt_proxy.MountDevice(dev_name, mount_point, "ro")
        return lambda: dt_proxy.UnmountDevice(dev_name, mount_point)
    except Exception:
        pass

    if not path:
        return None
    # norecovery: a read-only xfs with a dirty log refuses to mount
    # otherwise, and replaying the log would write to the disk.
    for opts in ("ro", "ro,norecovery"):
        r = run(["mount", "-o", opts, path, mount_point],
                capture_output=True, timeout=30)
        if r.returncode == 0:
            return lambda: run(["umount", mount_point],
                               capture_output=True, timeout=30)
    return None


def scan(dt_proxy, mount_base, persist,
         static_dirs=("/mnt/sysimage", "/run/media", "/mnt", "/tmp"),
         run=subprocess.run):
    """Look for backups on every device and in static_dirs.

    persist(path) copies an archive somewhere that survives partitioning
    and returns the copy's path. Returns [{"path", "info", "source"}].
    """
    found = []

    def collect(base, source):
        for archive in find_archives(base):
            info = validate_backup(archive)
            if info:
                found.append({"path": persist(archive), "info": info,
                              "source": source})

    activated = []
    os.makedirs(mount_base, exist_ok=True)
    if dt_proxy is not None:
        for dev_name in mountable_devices(dt_proxy):
            mount_point = os.path.join(mount_base, dev_name.replace("/", "_"))
            os.makedirs(mount_point, exist_ok=True)
            try:
                unmount = mount_read_only(dt_proxy, dev_name, mount_point,
                                          activated, run=run)
            except Exception:
                unmount = None
            if not unmount:
                continue
            try:
                collect(mount_point, dev_name)
            finally:
                try:
                    unmount()
                except Exception:
                    pass
    # Leave the volume groups as the installer found them.
    for vg in activated:
        try:
            run(["vgchange", "-an", vg], capture_output=True, timeout=30)
        except Exception:
            pass

    for static_dir in static_dirs:
        if os.path.isdir(static_dir):
            collect(static_dir, static_dir)

    unique = []
    seen = set()
    for b in found:
        if b["path"] not in seen:
            seen.add(b["path"])
            unique.append(b)
    return unique
