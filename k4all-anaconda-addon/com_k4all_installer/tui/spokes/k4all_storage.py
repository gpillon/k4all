# K4All Anaconda Addon - Storage & Backup TUI Spoke
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""K4All Storage & Backup spoke for Anaconda's text user interface."""

import logging
import os
import shutil

from simpleline.render.prompt import Prompt
from simpleline.render.screen import InputState
from simpleline.render.containers import ListColumnContainer
from simpleline.render.widgets import CheckboxWidget, EntryWidget, TextWidget

from pyanaconda.ui.tui.spokes import NormalTUISpoke
from pyanaconda.ui.common import FirstbootSpokeMixIn
from pyanaconda.modules.common.constants.services import STORAGE
from pyanaconda.modules.common.constants.objects import DEVICE_TREE, DISK_SELECTION

from com_k4all_installer.categories.k4all import K4AllCategory
from com_k4all_installer import backup_scan
from com_k4all_installer.constants import K4ALL
from com_k4all_installer.storage_layout import (
    StorageLayoutError, build_kickstart_layout,
)

log = logging.getLogger(__name__)

__all__ = ["K4AllStorageSpoke"]

_ = lambda x: x
N_ = lambda x: x

SCAN_MOUNT_BASE = "/tmp/k4all-backup-scan"
SAFE_BACKUP_DIR = "/tmp/k4all-safe-backup"


def _unpack(val):
    if hasattr(val, "unpack"):
        return val.unpack()
    return val


class K4AllStorageSpoke(FirstbootSpokeMixIn, NormalTUISpoke):
    """K4All Storage & Backup spoke for the text installer."""

    category = K4AllCategory

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.title = N_("K4All Storage & Backup")
        self._k4all_module = None
        self._storage_proxy = None
        self._dt_proxy = None
        self._ds_proxy = None
        self._container = None

        self._found_backups = []
        self._selected_backup_idx = -1
        self._restore_enabled = False
        self._safe_backup_path = ""

        self._existing_vgs = []
        self._keep_vgs = {}

        self._disk_layout_applied = False
        self._os_pct = 20

        try:
            self._k4all_module = K4ALL.get_proxy()
        except Exception:
            log.error("K4AllStorage TUI: no K4All proxy", exc_info=True)

        try:
            self._storage_proxy = STORAGE.get_proxy()
            self._dt_proxy = STORAGE.get_proxy(DEVICE_TREE)
            self._ds_proxy = STORAGE.get_proxy(DISK_SELECTION)
        except Exception:
            log.error("K4AllStorage TUI: no Storage proxy", exc_info=True)

    def initialize(self):
        super().initialize()

    def setup(self, args=None):
        super().setup(args)
        if self._k4all_module:
            try:
                self._restore_enabled = self._k4all_module.RestoreEnabled
            except Exception:
                pass
        self._scan_for_backups()
        self._detect_existing_vgs()
        return True

    def refresh(self, args=None):
        super().refresh(args)
        self._container = ListColumnContainer(columns=1)

        self._container.add(
            TextWidget("=== Backup & Restore ==="), callback=None)
        self._container.add(
            EntryWidget(
                title=_("Scan all disks for backups"),
                value="%d found" % len(self._found_backups)),
            callback=self._do_scan)

        if self._found_backups:
            if 0 <= self._selected_backup_idx < len(self._found_backups):
                info = self._found_backups[self._selected_backup_idx]["info"]
                desc = "%s (%s) from %s" % (
                    info.get("hostname", "?"),
                    info.get("node_type", "?"),
                    info.get("timestamp", "?"))
            else:
                desc = "(none selected)"
            self._container.add(
                EntryWidget(title=_("Selected backup"), value=desc),
                callback=self._cycle_backup)
            self._container.add(
                CheckboxWidget(
                    title=_("Restore from backup after installation"),
                    completed=self._restore_enabled),
                callback=self._toggle_restore)

        if self._existing_vgs:
            self._container.add(
                TextWidget("=== Existing Volume Groups ==="), callback=None)
            for vg in self._existing_vgs:
                name = vg["name"]
                keep = self._keep_vgs.get(name, name == "vg_data")
                self._container.add(
                    CheckboxWidget(
                        title="Keep %s (%.1f GB, PVs: %s)" % (
                            name, vg["size_gb"], ", ".join(vg["parents"])),
                        completed=keep),
                    callback=lambda data, n=name: self._toggle_vg(n))

        self._container.add(
            TextWidget("=== Disk Layout ==="), callback=None)
        self._container.add(
            EntryWidget(
                title=_("OS percentage"),
                value="%d%% OS / %d%% vg_data" % (
                    self._os_pct, 100 - self._os_pct)),
            callback=self._change_os_pct)

        disks = self._get_disk_list()
        if disks:
            self._container.add(
                EntryWidget(
                    title=_("Apply K4All layout"),
                    value="to %s" % disks[0]),
                callback=self._apply_layout)
        if self._disk_layout_applied:
            self._container.add(
                TextWidget("  [Layout APPLIED]"), callback=None)

        self.window.add_with_separator(self._container)

    def apply(self):
        if not self._k4all_module:
            return
        try:
            self._k4all_module.SetRestoreEnabled(self._restore_enabled)
            if self._restore_enabled:
                path = self._safe_backup_path
                if (not path
                        and 0 <= self._selected_backup_idx
                        < len(self._found_backups)):
                    path = self._found_backups[
                        self._selected_backup_idx]["path"]
                if path:
                    self._k4all_module.SetBackupArchivePath(path)
        except Exception:
            log.error("K4AllStorage TUI: apply error", exc_info=True)

    def execute(self):
        pass

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
            parts.append("Layout applied")
        if self._restore_enabled:
            parts.append("Restore enabled")
        if self._found_backups:
            parts.append("%d backup(s)" % len(self._found_backups))
        preserved = [n for n, k in self._keep_vgs.items() if k]
        if preserved:
            parts.append("Keep: %s" % ", ".join(preserved))
        return " | ".join(parts) if parts else "Not configured"

    def input(self, args, key):
        if self._container and self._container.process_user_input(key):
            return InputState.PROCESSED_AND_REDRAW
        if key.lower() == Prompt.CONTINUE:
            self.apply()
            return InputState.PROCESSED_AND_CLOSE
        return super().input(args, key)

    # --- Callbacks ---

    def _do_scan(self, data):
        self._scan_for_backups()

    def _cycle_backup(self, data):
        if self._found_backups:
            self._selected_backup_idx = (
                (self._selected_backup_idx + 1) % len(self._found_backups))
            self._copy_backup_to_safe()

    def _toggle_restore(self, data):
        self._restore_enabled = not self._restore_enabled
        if self._restore_enabled:
            self._copy_backup_to_safe()

    def _toggle_vg(self, name):
        self._keep_vgs[name] = not self._keep_vgs.get(name, False)

    def _change_os_pct(self, data):
        self._os_pct += 10
        if self._os_pct > 90:
            self._os_pct = 10

    def _apply_layout(self, data):
        disks = self._get_disk_list()
        if not disks or not self._storage_proxy:
            return

        disk_name = disks[0]
        is_efi = os.path.isdir("/sys/firmware/efi")

        try:
            d = self._dt_proxy.GetDeviceData(disk_name)
            disk_mb = _unpack(d.get("size", 0)) // (1024 * 1024)
        except Exception:
            disk_mb = 100000

        preserved_names = [n for n, k in self._keep_vgs.items() if k]
        preserved_vgs = {}
        pv_parent_disks = {}
        for vg in self._existing_vgs:
            if vg["name"] not in preserved_names:
                continue
            preserved_vgs[vg["name"]] = list(vg.get("parents", []))
            for pv in vg.get("parents", []):
                try:
                    pv_data = self._dt_proxy.GetDeviceData(pv)
                    parents = _unpack(pv_data.get("parents", []))
                    if parents:
                        pv_parent_disks[pv] = parents[0]
                except Exception:
                    pass

        try:
            disk_partitions = _unpack(
                self._dt_proxy.GetDeviceData(disk_name).get("children", []))
        except Exception:
            disk_partitions = []

        try:
            self._storage_proxy.ResetPartitioning()
        except Exception:
            pass

        try:
            ks_text = build_kickstart_layout(
                disk_name=disk_name,
                disk_mib=disk_mb,
                is_efi=is_efi,
                os_percent=self._os_pct,
                disk_partitions=disk_partitions,
                preserved_vgs=preserved_vgs,
                pv_parent_disks=pv_parent_disks,
            )
        except StorageLayoutError as error:
            log.error("Cannot apply K4All storage layout: %s", error)
            return
        try:
            self._storage_proxy.ReadKickstart(ks_text)
            partitionings = self._storage_proxy.CreatedPartitioning
            if partitionings:
                latest = partitionings[-1]
                try:
                    p_proxy = STORAGE.get_proxy(latest)
                    task_path = p_proxy.ConfigureWithTask()
                    task_proxy = STORAGE.get_proxy(task_path)
                    from pyanaconda.modules.common.task import sync_run_task
                    sync_run_task(task_proxy)
                    try:
                        self._storage_proxy.ApplyPartitioning(latest)
                    except Exception:
                        log.info("Partitioning created; ApplyPartitioning "
                                 "may succeed during actual install")
                except Exception:
                    log.info("ConfigureWithTask: partitioning saved")
            self._disk_layout_applied = True
            if self._k4all_module:
                try:
                    self._k4all_module.SetDiskLayoutApplied(True)
                    self._k4all_module.SetDiskLayoutKickstart(ks_text)
                except Exception:
                    pass
        except Exception:
            log.error("Failed to apply disk layout", exc_info=True)

    # --- Helpers ---

    def _get_disk_list(self):
        if self._dt_proxy:
            try:
                return list(self._dt_proxy.GetDisks())
            except Exception:
                pass
        return []

    def _detect_existing_vgs(self):
        self._existing_vgs = []
        if not self._dt_proxy:
            return
        try:
            for dev_name in self._dt_proxy.GetDevices():
                data = self._dt_proxy.GetDeviceData(dev_name)
                if _unpack(data.get("type", "")) != "lvmvg":
                    continue
                name = _unpack(data.get("name", ""))
                size = _unpack(data.get("size", 0))
                parents = _unpack(data.get("parents", []))
                children = _unpack(data.get("children", []))
                self._existing_vgs.append({
                    "name": name,
                    "device_id": dev_name,
                    "size_gb": size / (1024 ** 3),
                    "parents": parents,
                    "children": children
                })
                if name not in self._keep_vgs:
                    self._keep_vgs[name] = (name == "vg_data")
        except Exception:
            log.error("Failed to detect VGs", exc_info=True)

    def _vg_lives_on_disk(self, vg_name, target_disk):
        for vg in self._existing_vgs:
            if vg["name"] != vg_name:
                continue
            for pv_name in vg["parents"]:
                try:
                    pv_data = self._dt_proxy.GetDeviceData(pv_name)
                    pv_parents = _unpack(pv_data.get("parents", []))
                    if target_disk in pv_parents:
                        return True
                except Exception:
                    pass
        return False

    def _scan_for_backups(self):
        try:
            self._found_backups = backup_scan.scan(
                self._dt_proxy, SCAN_MOUNT_BASE, self._persist_backup)
        except Exception:
            log.error("K4AllStorage TUI: backup scan failed", exc_info=True)
            self._found_backups = []
        if self._found_backups and self._selected_backup_idx < 0:
            self._selected_backup_idx = 0

    @staticmethod
    def _persist_backup(archive_path):
        """Copy to SAFE_BACKUP_DIR so the path survives unmount."""
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

    def _copy_backup_to_safe(self):
        """Set _safe_backup_path. Backups are already persisted during scan."""
        if (self._selected_backup_idx < 0
                or self._selected_backup_idx >= len(self._found_backups)):
            return
        path = self._found_backups[self._selected_backup_idx]["path"]
        if os.path.isfile(path):
            self._safe_backup_path = path
