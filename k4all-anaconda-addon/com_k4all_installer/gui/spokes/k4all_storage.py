# K4All Anaconda Addon - Storage & Backup GUI Spoke
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""K4All Storage & Backup spoke for Anaconda's graphical interface."""

import logging
import os
import shutil
import json as _json
import subprocess
import tarfile
import threading

from gi.repository import GLib, Gtk

from pyanaconda.ui.gui.spokes import NormalSpoke
from pyanaconda.ui.common import FirstbootSpokeMixIn
from pyanaconda.modules.common.constants.services import STORAGE
from pyanaconda.modules.common.constants.objects import DEVICE_TREE, DISK_SELECTION

from com_k4all_installer.categories.k4all import K4AllCategory
from com_k4all_installer.constants import K4ALL

log = logging.getLogger(__name__)

__all__ = ["K4AllStorageSpoke"]

_ = lambda x: x
N_ = lambda x: x

SCAN_MOUNT_BASE = "/tmp/k4all-backup-scan"
SAFE_BACKUP_DIR = "/tmp/k4all-safe-backup"


def _unpack(val):
    """Unpack a GLib/dasbus Variant to a plain Python value."""
    if hasattr(val, "unpack"):
        return val.unpack()
    return val


class K4AllStorageSpoke(FirstbootSpokeMixIn, NormalSpoke):
    """K4All Storage & Backup spoke — separate hub button."""

    builderObjects = ["k4allStorageSpokeWindow", "osSizeAdjustment"]
    mainWidgetName = "k4allStorageSpokeWindow"
    uiFile = "k4all_storage.glade"
    category = K4AllCategory
    icon = "drive-harddisk-symbolic"
    title = N_("_K4All Storage & Backup")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._k4all_module = None
        self._storage_proxy = None
        self._dt_proxy = None
        self._ds_proxy = None
        self._found_backups = []
        self._existing_vgs = []
        self._vg_checkboxes = {}
        self._disk_layout_applied = False
        self._safe_backup_path = ""
        self._disks_cache = []

        try:
            self._k4all_module = K4ALL.get_proxy()
        except Exception:
            log.error("K4AllStorage spoke: failed to get K4All D-Bus proxy",
                      exc_info=True)

        try:
            self._storage_proxy = STORAGE.get_proxy()
            self._dt_proxy = STORAGE.get_proxy(DEVICE_TREE)
            self._ds_proxy = STORAGE.get_proxy(DISK_SELECTION)
        except Exception:
            log.error("K4AllStorage spoke: failed to get Storage D-Bus proxies",
                      exc_info=True)

    def initialize(self):
        super().initialize()
        log.info("K4AllStorage spoke: initializing")

        self._scan_button = self.builder.get_object("scanBackupsButton")
        self._scan_spinner = self.builder.get_object("scanSpinner")
        self._backup_combo = self.builder.get_object("backupArchiveCombo")
        self._restore_check = self.builder.get_object("restoreEnableCheck")
        self._backup_details = self.builder.get_object("backupDetailsLabel")

        self._vg_frame = self.builder.get_object("existingVGFrame")
        self._refresh_vg_button = self.builder.get_object("refreshVGButton")
        self._vg_list_box = self.builder.get_object("vgListBox")
        self._vg_status = self.builder.get_object("vgStatusLabel")

        self._disk_combo = self.builder.get_object("diskTargetCombo")
        self._disk_info_label = self.builder.get_object(
            "diskPartitionInfoLabel")
        self._os_scale = self.builder.get_object("osSizeScale")
        self._slider_info = self.builder.get_object("sliderInfoLabel")
        self._apply_button = self.builder.get_object("applyDiskLayoutButton")
        self._disk_status = self.builder.get_object("diskLayoutStatusLabel")

        # Keep references to the slider row widgets for sensitivity toggling
        self._slider_box = (self._os_scale.get_parent()
                            if self._os_scale else None)

        if self._scan_button:
            self._scan_button.connect("clicked", self._on_scan_clicked)
        if self._backup_combo:
            self._backup_combo.connect("changed", self._on_backup_selected)
        if self._restore_check:
            self._restore_check.connect("toggled", self._on_restore_toggled)
        if self._refresh_vg_button:
            self._refresh_vg_button.connect("clicked", self._on_refresh_vg)
        if self._apply_button:
            self._apply_button.connect("clicked", self._on_apply_layout)
        if self._os_scale:
            self._os_scale.connect("value-changed", self._on_slider_changed)
        if self._disk_combo:
            self._disk_combo.connect("changed", self._on_disk_changed)

        self._auto_scan_backups()

    # ------------------------------------------------------------------ #
    #  Spoke lifecycle                                                    #
    # ------------------------------------------------------------------ #

    def refresh(self):
        self._populate_disks()
        self._detect_existing_vgs()

    def apply(self):
        if not self._k4all_module:
            return
        try:
            restore_on = (self._restore_check.get_active()
                          if self._restore_check else False)
            self._k4all_module.SetRestoreEnabled(restore_on)

            if restore_on and self._safe_backup_path:
                self._k4all_module.SetBackupArchivePath(self._safe_backup_path)
            elif restore_on and self._found_backups:
                idx = (self._backup_combo.get_active()
                       if self._backup_combo else -1)
                if 0 <= idx < len(self._found_backups):
                    self._k4all_module.SetBackupArchivePath(
                        self._found_backups[idx]["path"])
        except Exception:
            log.error("K4AllStorage spoke: error during apply", exc_info=True)

    def execute(self):
        pass

    @property
    def ready(self):
        return True

    @property
    def completed(self):
        return True

    @property
    def mandatory(self):
        return False

    @property
    def status(self):
        parts = []
        if self._disk_layout_applied:
            parts.append("Disk layout applied")
        else:
            parts.append("Storage: not configured")

        restore = False
        if self._k4all_module:
            try:
                restore = self._k4all_module.RestoreEnabled
            except Exception:
                pass
        if restore:
            parts.append("Restore: enabled")
        if self._found_backups:
            parts.append("%d backup(s)" % len(self._found_backups))

        preserved = self._get_preserved_vg_names()
        if preserved:
            parts.append("Keep VGs: %s" % ", ".join(preserved))

        return " | ".join(parts)

    # ------------------------------------------------------------------ #
    #  Backup scanning                                                    #
    # ------------------------------------------------------------------ #

    def _auto_scan_backups(self):
        thread = threading.Thread(target=self._scan_worker, daemon=True)
        thread.start()

    def _on_scan_clicked(self, button):
        if self._scan_spinner:
            self._scan_spinner.set_visible(True)
            self._scan_spinner.start()
        if self._scan_button:
            self._scan_button.set_sensitive(False)
        thread = threading.Thread(target=self._scan_worker, daemon=True)
        thread.start()

    def _get_all_mountable_devices(self):
        devices = []
        if not self._dt_proxy:
            return devices
        try:
            for dev_name in self._dt_proxy.GetDevices():
                try:
                    fdata = self._dt_proxy.GetFormatData(dev_name)
                    mountable = _unpack(fdata.get("mountable", False))
                    ftype = _unpack(fdata.get("type", ""))
                    if mountable and ftype not in ("", "biosboot", "lvmpv",
                                                    "swap"):
                        devices.append(dev_name)
                except Exception:
                    pass
        except Exception:
            pass
        try:
            for dev in self._dt_proxy.FindOpticalMedia():
                if dev not in devices:
                    devices.append(dev)
        except Exception:
            pass
        return devices

    def _scan_worker(self):
        found = []
        os.makedirs(SCAN_MOUNT_BASE, exist_ok=True)

        for dev_name in self._get_all_mountable_devices():
            safe_name = dev_name.replace("/", "_")
            mount_point = os.path.join(SCAN_MOUNT_BASE, safe_name)
            os.makedirs(mount_point, exist_ok=True)
            mounted = False
            dbus_mount = False

            try:
                self._dt_proxy.MountDevice(dev_name, mount_point, "")
                mounted = True
                dbus_mount = True
            except Exception:
                pass

            if not mounted:
                try:
                    data = self._dt_proxy.GetDeviceData(dev_name)
                    dtype = _unpack(data.get("type", ""))
                    dpath = _unpack(data.get("path", ""))
                    if dtype == "lvmlv" and dpath:
                        parents = _unpack(data.get("parents", []))
                        for parent in parents:
                            try:
                                subprocess.run(
                                    ["vgchange", "-ay", parent],
                                    capture_output=True, timeout=10)
                            except Exception:
                                pass
                        r = subprocess.run(
                            ["mount", "-o", "ro", dpath, mount_point],
                            capture_output=True, timeout=15)
                        if r.returncode == 0:
                            mounted = True
                except Exception:
                    pass

            if mounted:
                try:
                    self._search_dir_for_backups(
                        mount_point, dev_name, found)
                finally:
                    try:
                        if dbus_mount:
                            self._dt_proxy.UnmountDevice(
                                dev_name, mount_point)
                        else:
                            subprocess.run(
                                ["umount", mount_point],
                                capture_output=True, timeout=10)
                    except Exception:
                        pass

        for static_dir in ["/mnt/sysimage", "/run/media", "/mnt", "/tmp"]:
            if os.path.isdir(static_dir):
                self._search_dir_for_backups(static_dir, static_dir, found)

        seen = set()
        unique = []
        for b in found:
            if b["path"] not in seen:
                seen.add(b["path"])
                unique.append(b)

        GLib.idle_add(self._scan_complete, unique)

    def _search_dir_for_backups(self, base_dir, source_label, results):
        try:
            for root, dirs, files in os.walk(base_dir):
                depth = root.count(os.sep) - base_dir.count(os.sep)
                if depth > 5:
                    dirs.clear()
                    continue
                for fname in files:
                    if (fname.startswith("k4all-backup-")
                            and fname.endswith(".tar.gz")):
                        full = os.path.join(root, fname)
                        info = self._validate_backup(full)
                        if info:
                            persisted = self._persist_backup(full)
                            results.append({
                                "path": persisted,
                                "info": info,
                                "source": source_label
                            })
        except Exception:
            pass

    @staticmethod
    def _persist_backup(archive_path):
        if archive_path.startswith(SAFE_BACKUP_DIR):
            return archive_path
        os.makedirs(SAFE_BACKUP_DIR, exist_ok=True)
        dst = os.path.join(SAFE_BACKUP_DIR, os.path.basename(archive_path))
        if os.path.isfile(dst):
            return dst
        try:
            shutil.copy2(archive_path, dst)
            return dst
        except Exception:
            return archive_path

    @staticmethod
    def _validate_backup(archive_path):
        try:
            with tarfile.open(archive_path, "r:gz") as tf:
                info_member = next(
                    (m for m in tf.getmembers()
                     if m.name.lstrip("./") == "metadata/backup-info.json"),
                    None)
                if info_member is None:
                    return None
                f = tf.extractfile(info_member)
                if f:
                    data = _json.loads(f.read())
                    if data.get("marker") == "K4ALL_BACKUP_V2":
                        return data
        except Exception:
            pass
        return None

    def _scan_complete(self, found):
        self._found_backups = found
        if self._scan_spinner:
            self._scan_spinner.stop()
            self._scan_spinner.set_visible(False)
        if self._scan_button:
            self._scan_button.set_sensitive(True)

        if self._backup_combo:
            self._backup_combo.remove_all()
            for b in found:
                info = b["info"]
                label = "%s (%s) — %s [K4All %s] from %s" % (
                    info.get("hostname", "?"),
                    info.get("node_type", "?"),
                    info.get("timestamp", "?"),
                    info.get("k4all_version", "?"),
                    b["source"])
                self._backup_combo.append_text(label)
            if found:
                self._backup_combo.set_active(0)

        self._update_backup_details()

    def _on_backup_selected(self, combo):
        self._update_backup_details()
        self._copy_backup_to_safe_location()

    def _on_restore_toggled(self, check):
        if check.get_active():
            self._copy_backup_to_safe_location()

    def _update_backup_details(self):
        if not self._backup_details:
            return
        if not self._found_backups:
            self._backup_details.set_text(
                "No backups found. Click 'Scan All Disks' to mount and "
                "search all partitions, LVM volumes, and optical media.")
            if self._restore_check:
                self._restore_check.set_sensitive(False)
                self._restore_check.set_active(False)
            return

        if self._restore_check:
            self._restore_check.set_sensitive(True)

        idx = self._backup_combo.get_active() if self._backup_combo else -1
        if 0 <= idx < len(self._found_backups):
            b = self._found_backups[idx]
            info = b["info"]
            size_mb = 0
            try:
                size_mb = os.path.getsize(b["path"]) // (1024 * 1024)
            except Exception:
                pass
            safe = " (safe copy)" if self._safe_backup_path else ""
            self._backup_details.set_text(
                "Found %d backup(s). Selected: %s (%s) — %s, "
                "K4All %s, %dMB, source: %s%s" % (
                    len(self._found_backups),
                    info.get("hostname", "?"),
                    info.get("node_type", "?"),
                    info.get("timestamp", "?"),
                    info.get("k4all_version", "?"),
                    size_mb, b["source"], safe))

    def _copy_backup_to_safe_location(self):
        idx = self._backup_combo.get_active() if self._backup_combo else -1
        if idx < 0 or idx >= len(self._found_backups):
            return
        path = self._found_backups[idx]["path"]
        if os.path.isfile(path):
            self._safe_backup_path = path
        self._update_backup_details()

    # ------------------------------------------------------------------ #
    #  Existing VG detection                                              #
    # ------------------------------------------------------------------ #

    def _detect_existing_vgs(self):
        self._existing_vgs = []
        if self._vg_list_box:
            for child in list(self._vg_list_box.get_children()):
                self._vg_list_box.remove(child)
        self._vg_checkboxes = {}

        if not self._dt_proxy:
            return

        try:
            for dev_name in self._dt_proxy.GetDevices():
                data = self._dt_proxy.GetDeviceData(dev_name)
                dev_type = _unpack(data.get("type", ""))
                if dev_type != "lvmvg":
                    continue
                name = _unpack(data.get("name", ""))
                size = _unpack(data.get("size", 0))
                parents = _unpack(data.get("parents", []))
                children = _unpack(data.get("children", []))

                # Determine which disk(s) this VG lives on
                parent_disks = set()
                for pv in parents:
                    try:
                        pvdata = self._dt_proxy.GetDeviceData(pv)
                        for pd in _unpack(pvdata.get("parents", [])):
                            parent_disks.add(pd)
                    except Exception:
                        pass

                self._existing_vgs.append({
                    "name": name, "device_id": dev_name,
                    "size_gb": size / (1024 ** 3),
                    "parents": parents, "children": children,
                    "parent_disks": parent_disks,
                })

                disk_info = ""
                if parent_disks:
                    disk_info = " on %s" % ", ".join(sorted(parent_disks))

                cb = Gtk.CheckButton(
                    label="Keep %s (%.1f GB, PVs: %s%s)" % (
                        name, size / (1024 ** 3),
                        ", ".join(parents), disk_info))
                cb.set_active(name == "vg_data")
                cb.connect("toggled", self._on_vg_toggled)
                cb.show()
                self._vg_list_box.add(cb)
                self._vg_checkboxes[name] = cb
        except Exception:
            log.error("Failed to detect VGs", exc_info=True)

        if self._vg_status:
            if self._existing_vgs:
                self._vg_status.set_text(
                    "Found %d volume group(s). Check the ones to PRESERVE."
                    % len(self._existing_vgs))
            else:
                self._vg_status.set_text(
                    "No existing LVM volume groups found.")

    def _on_refresh_vg(self, button):
        self._detect_existing_vgs()
        self._update_slider_state()

    def _on_vg_toggled(self, checkbox):
        self._update_slider_state()

    def _get_preserved_vg_names(self):
        return [n for n, cb in self._vg_checkboxes.items() if cb.get_active()]

    def _vg_lives_on_disk(self, vg_name, target_disk):
        for vg in self._existing_vgs:
            if vg["name"] != vg_name:
                continue
            if target_disk in vg.get("parent_disks", set()):
                return True
        return False

    # ------------------------------------------------------------------ #
    #  Disk selection + partition info + slider state                     #
    # ------------------------------------------------------------------ #

    def _populate_disks(self):
        if not self._disk_combo or not self._dt_proxy:
            return

        prev_text = self._disk_combo.get_active_text()
        self._disk_combo.remove_all()
        self._disks_cache = []

        try:
            for d in self._dt_proxy.GetDisks():
                data = self._dt_proxy.GetDeviceData(d)
                name = _unpack(data.get("name", d))
                size = _unpack(data.get("size", 0))
                desc = _unpack(data.get("description", ""))
                removable = _unpack(data.get("removable", False))
                size_gb = size / (1024 ** 3)
                label = "/dev/%s (%.1f GB)" % (name, size_gb)
                if desc:
                    label += " — %s" % desc
                if removable:
                    label += " [removable]"
                self._disk_combo.append_text(label)
                self._disks_cache.append({
                    "name": name, "size": size, "label": label})
        except Exception:
            log.warning("Failed to list disks", exc_info=True)

        # Restore previous selection or select first
        selected = False
        if prev_text:
            model = self._disk_combo.get_model()
            if model:
                for i, row in enumerate(model):
                    if row[0] == prev_text:
                        self._disk_combo.set_active(i)
                        selected = True
                        break
        if not selected and self._disks_cache:
            self._disk_combo.set_active(0)

    def _on_disk_changed(self, combo):
        self._show_disk_partitions()
        self._update_slider_state()

    def _get_selected_disk_name(self):
        if not self._disk_combo:
            return None
        idx = self._disk_combo.get_active()
        if idx < 0 or idx >= len(self._disks_cache):
            return None
        return self._disks_cache[idx]["name"]

    def _show_disk_partitions(self):
        """Show partition layout for the selected disk."""
        if not self._disk_info_label or not self._dt_proxy:
            return
        disk_name = self._get_selected_disk_name()
        if not disk_name:
            self._disk_info_label.set_text(
                "Select a disk to see its current partition layout.")
            return

        lines = []
        try:
            data = self._dt_proxy.GetDeviceData(disk_name)
            children = _unpack(data.get("children", []))
            disk_size = _unpack(data.get("size", 0))
            lines.append("Current layout of /dev/%s (%.1f GB):" % (
                disk_name, disk_size / (1024 ** 3)))

            for child in children:
                try:
                    cdata = self._dt_proxy.GetDeviceData(child)
                    cname = _unpack(cdata.get("name", child))
                    csize = _unpack(cdata.get("size", 0))
                    ctype = _unpack(cdata.get("type", ""))
                    cfmt = self._dt_proxy.GetFormatData(child)
                    cftype = _unpack(cfmt.get("type", ""))
                    lines.append(
                        "  %-12s %8.1f GB  %s" % (
                            cname, csize / (1024 ** 3),
                            cftype or ctype))
                except Exception:
                    lines.append("  %s  (unreadable)" % child)

            if not children:
                lines.append("  (no partitions — empty disk)")
        except Exception:
            lines.append("Could not read partition data for %s" % disk_name)

        self._disk_info_label.set_text("\n".join(lines))

    def _update_slider_state(self):
        """Enable/disable slider based on whether vg_data is preserved."""
        preserved = self._get_preserved_vg_names()
        vg_data_preserved = "vg_data" in preserved

        if vg_data_preserved:
            if self._os_scale:
                self._os_scale.set_sensitive(False)
            if self._slider_info:
                disk_name = self._get_selected_disk_name()
                vg_on_disk = (disk_name and
                              self._vg_lives_on_disk("vg_data", disk_name))
                if vg_on_disk:
                    self._slider_info.set_text(
                        "vg_data preserved on this disk — "
                        "OS uses remaining space")
                else:
                    self._slider_info.set_text(
                        "vg_data preserved on another disk — "
                        "OS uses entire target disk")
        else:
            if self._os_scale:
                self._os_scale.set_sensitive(True)
            self._on_slider_changed(self._os_scale)

    def _on_slider_changed(self, scale):
        if not scale:
            return
        os_pct = int(scale.get_value())
        data_pct = 100 - os_pct
        if self._slider_info and scale.get_sensitive():
            self._slider_info.set_text(
                "OS: %d%% — Data (vg_data): %d%%" % (os_pct, data_pct))

    # ------------------------------------------------------------------ #
    #  Disk layout via D-Bus Storage module                               #
    # ------------------------------------------------------------------ #

    def _on_apply_layout(self, button):
        if not self._storage_proxy:
            self._set_status("ERROR: Storage D-Bus proxy not available.")
            return

        disk_name = self._get_selected_disk_name()
        if not disk_name:
            self._set_status("Please select a target disk first.")
            return

        preserved_vgs = self._get_preserved_vg_names()
        vg_data_preserved = "vg_data" in preserved_vgs
        is_efi = os.path.isdir("/sys/firmware/efi")

        try:
            disk_data = self._dt_proxy.GetDeviceData(disk_name)
            disk_mb = _unpack(disk_data.get("size", 0)) // (1024 * 1024)
        except Exception:
            disk_mb = 100000

        boot_mb = 1024
        efi_mb = 600 if is_efi else 0
        biosboot_mb = 1 if not is_efi else 0
        overhead = boot_mb + efi_mb + biosboot_mb + 100

        # Determine space for OS vs data
        create_vg_data = True
        existing_vg_names = {vg["name"] for vg in self._existing_vgs}

        if vg_data_preserved:
            create_vg_data = False
            # OS gets all remaining space on target disk
            os_mb = disk_mb - overhead
        elif "vg_data" in existing_vg_names:
            if not self._vg_lives_on_disk("vg_data", disk_name):
                create_vg_data = False
                os_mb = disk_mb - overhead
            else:
                os_pct = int(self._os_scale.get_value()) if self._os_scale else 20
                usable = disk_mb - overhead
                os_mb = max(8000, usable * os_pct // 100)
        else:
            os_pct = int(self._os_scale.get_value()) if self._os_scale else 20
            usable = disk_mb - overhead
            os_mb = max(8000, usable * os_pct // 100)

        os_mb = max(8000, os_mb)
        swap_mb = min(4096, max(1024, os_mb // 4))

        try:
            self._storage_proxy.ResetPartitioning()
        except Exception:
            pass

        ks_lines = [
            "ignoredisk --only-use=%s" % disk_name,
            "clearpart --all --initlabel --disklabel=gpt --drives=%s"
            % disk_name,
            "bootloader --location=mbr --boot-drive=%s" % disk_name,
        ]
        if is_efi:
            ks_lines.append(
                "part /boot/efi --fstype=efi --size=%d --ondisk=%s"
                % (efi_mb, disk_name))
        else:
            ks_lines.append(
                "part biosboot --fstype=biosboot --size=%d --ondisk=%s"
                % (biosboot_mb, disk_name))
        ks_lines.append(
            "part /boot --fstype=xfs --size=%d --ondisk=%s"
            % (boot_mb, disk_name))

        if create_vg_data:
            ks_lines.append(
                "part pv.01 --size=%d --ondisk=%s" % (os_mb, disk_name))
            ks_lines.append(
                "part pv.02 --size=1 --grow --ondisk=%s" % disk_name)
        else:
            ks_lines.append(
                "part pv.01 --size=1 --grow --ondisk=%s" % disk_name)

        ks_lines.append("volgroup rootvg pv.01")
        ks_lines.append(
            "logvol swap --vgname=rootvg --size=%d --name=swaplv" % swap_mb)
        ks_lines.append(
            "logvol / --vgname=rootvg --fstype=xfs --size=1 --grow "
            "--name=rootlv")

        if create_vg_data:
            ks_lines.append("volgroup vg_data pv.02")

        ks_text = "\n".join(ks_lines)
        log.info("K4AllStorage: applying KS:\n%s", ks_text)

        try:
            result = self._storage_proxy.ReadKickstart(ks_text)
            errors = _unpack(result.get("error-messages", []))
            if errors:
                msgs = []
                for e in errors:
                    e = _unpack(e) if hasattr(e, "unpack") else e
                    if isinstance(e, dict):
                        msgs.append(str(e.get("message", e)))
                    else:
                        msgs.append(str(e))
                self._set_status("KS parse error: %s" % "; ".join(msgs))
                return

            partitionings = self._storage_proxy.CreatedPartitioning
            apply_ok = False
            configure_ok = False
            if partitionings:
                latest = partitionings[-1]
                try:
                    p_proxy = STORAGE.get_proxy(latest)
                    task_path = p_proxy.ConfigureWithTask()
                    task_proxy = STORAGE.get_proxy(task_path)
                    from pyanaconda.modules.common.task import sync_run_task
                    sync_run_task(task_proxy)
                    configure_ok = True

                    try:
                        self._storage_proxy.ApplyPartitioning(latest)
                        apply_ok = True
                    except Exception as ex:
                        log.info("ApplyPartitioning: %s", ex)
                except Exception as ex:
                    log.warning("ConfigureWithTask: %s", ex)

            self._disk_layout_applied = True
            vg_note = ""
            if preserved_vgs:
                vg_note = " Preserved: %s." % ", ".join(preserved_vgs)

            if apply_ok:
                status_text = (
                    "Layout APPLIED to /dev/%s.%s %s boot." %
                    (disk_name, vg_note, "EFI" if is_efi else "BIOS"))
            elif configure_ok:
                status_text = (
                    "Layout CONFIGURED for /dev/%s.%s %s boot. "
                    "Open Storage spoke to verify." %
                    (disk_name, vg_note, "EFI" if is_efi else "BIOS"))
            else:
                status_text = (
                    "Layout saved for /dev/%s but could not configure. "
                    "Use Storage spoke." % disk_name)

            self._set_status(status_text)

            if self._k4all_module:
                try:
                    self._k4all_module.SetDiskLayoutApplied(True)
                    self._k4all_module.SetDiskLayoutKickstart(ks_text)
                except Exception:
                    pass

        except Exception:
            log.error("Failed to apply disk layout", exc_info=True)
            self._set_status("ERROR: Failed to apply layout. Check logs.")

    def _set_status(self, text):
        if self._disk_status:
            self._disk_status.set_text(text)
