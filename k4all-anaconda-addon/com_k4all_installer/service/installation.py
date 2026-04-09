# K4All Anaconda Addon - Installation Tasks
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""Installation and configuration tasks for the K4All addon."""

import logging
import os
import glob
import shutil
import subprocess
from os.path import normpath, join as joinpath, dirname
from os import makedirs

try:
    import yaml
except ImportError:
    yaml = None

from pyanaconda.modules.common.task import Task

from com_k4all_installer.constants import (
    K4ALL_CONFIG_PATH, K4ALL_NODE_TYPE_PATH,
    CR_API_VERSION, CR_KIND, CR_NAME,
)

log = logging.getLogger(__name__)


def _dump_yaml(data, stream):
    """Write *data* as YAML.  Falls back to a simple recursive serialiser
    when PyYAML is not available (e.g. minimal test environments)."""
    if yaml is not None:
        yaml.safe_dump(data, stream, default_flow_style=False, sort_keys=False)
        return

    def _write(obj, indent=0):
        prefix = "  " * indent
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, (dict, list)):
                    stream.write(f"{prefix}{k}:\n")
                    _write(v, indent + 1)
                else:
                    stream.write(f"{prefix}{k}: {_scalar(v)}\n")
        elif isinstance(obj, list):
            for item in obj:
                if isinstance(item, (dict, list)):
                    stream.write(f"{prefix}-\n")
                    _write(item, indent + 1)
                else:
                    stream.write(f"{prefix}- {_scalar(item)}\n")
        else:
            stream.write(f"{prefix}{_scalar(obj)}\n")

    def _scalar(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        if v is None:
            return "null"
        if isinstance(v, str):
            if v == "":
                return '""'
            return v
        return str(v)

    _write(data)


class K4AllConfigurationTask(Task):
    """The K4All configuration task.

    This task runs before the installation starts.
    """

    @property
    def name(self):
        return "Configure K4All"

    def run(self):
        """Pre-installation configuration."""
        log.info("K4All configuration task: nothing to do pre-install")


class K4AllInstallationTask(Task):
    """The K4All installation task.

    Writes /etc/k4all-config.yaml (a ClusterConfig CR) and /etc/node-type
    at the end of the Anaconda installation.
    """

    def __init__(self, sysroot, role, cluster_config, install_config=None,
                 backup_archive_path="", restore_enabled=False):
        super().__init__()
        self._sysroot = sysroot
        self._role = role
        self._cluster_config = cluster_config
        self._install_config = install_config or {}
        self._backup_archive_path = backup_archive_path
        self._restore_enabled = restore_enabled

    @property
    def name(self):
        return "Install K4All Configuration"

    def run(self):
        """Write K4All configuration files to the installed system."""
        log.info("K4All installation task: writing configuration files")

        # Build the full ClusterConfig CR
        cr = {
            "apiVersion": CR_API_VERSION,
            "kind": CR_KIND,
            "metadata": {"name": CR_NAME},
            "spec": self._cluster_config,
        }

        config_path = normpath(joinpath(self._sysroot, K4ALL_CONFIG_PATH))
        log.debug("Writing K4All config to: %s", config_path)

        makedirs(dirname(config_path), exist_ok=True)
        with open(config_path, "w") as f:
            _dump_yaml(cr, f)

        # Write /etc/node-type
        node_type_path = normpath(joinpath(self._sysroot, K4ALL_NODE_TYPE_PATH))
        log.debug("Writing node type to: %s", node_type_path)

        makedirs(dirname(node_type_path), exist_ok=True)
        with open(node_type_path, "w") as f:
            f.write(self._role)
            f.write("\n")

        # Ensure writable directories exist inside sysroot.
        for d in [
            "var/opt/k4all",
            "var/home/core/.kube",
            "var/roothome/.kube",
        ]:
            makedirs(joinpath(self._sysroot, d), exist_ok=True)

        log.info("K4All configuration written successfully (role=%s)", self._role)

        if self._restore_enabled and self._backup_archive_path:
            self._copy_backup_for_restore()

        self._setup_vg_data()

    def _setup_vg_data(self):
        """Create vg_data volume group if enabled in install config."""
        storage_config = self._install_config.get("storage", {}).get("vg_data", {})
        if storage_config.get("enabled", "true") != "true":
            log.info("vg_data creation disabled in config")
            return

        result = subprocess.run(
            ["vgdisplay", "vg_data"],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            log.info("vg_data already exists, skipping creation")
            return

        disk = storage_config.get("disk", "auto")
        if disk == "auto":
            disk = self._find_root_disk()
            if not disk:
                log.warning("Could not determine root disk for vg_data")
                return

        log.info("Setting up vg_data on disk: %s", disk)

        partition = self._find_vgdata_partition(disk)
        if not partition:
            log.warning("No suitable partition found for vg_data on %s", disk)
            return

        log.info("Creating vg_data on partition: %s", partition)

        result = subprocess.run(
            ["pvcreate", "-f", partition],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            log.warning("Failed to create PV on %s: %s", partition, result.stderr)
            return

        result = subprocess.run(
            ["vgcreate", "vg_data", partition],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            log.warning("Failed to create vg_data: %s", result.stderr)
            return

        log.info("vg_data created successfully on %s", partition)

    def _find_root_disk(self):
        """Find the disk containing the root filesystem."""
        try:
            result = subprocess.run(
                ["lsblk", "-no", "PKNAME", "/dev/mapper/rootvg-rootlv"],
                capture_output=True,
                text=True
            )
            if result.returncode == 0 and result.stdout.strip():
                return f"/dev/{result.stdout.strip()}"

            result = subprocess.run(
                ["findmnt", "-no", "SOURCE", "/"],
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                root_dev = result.stdout.strip()
                result = subprocess.run(
                    ["lsblk", "-no", "PKNAME", root_dev],
                    capture_output=True,
                    text=True
                )
                if result.returncode == 0 and result.stdout.strip():
                    return f"/dev/{result.stdout.strip()}"
        except Exception as e:
            log.warning("Error finding root disk: %s", e)
        return None

    def _find_vgdata_partition(self, disk):
        """Find a suitable partition for vg_data on the given disk."""
        disk_name = disk.replace("/dev/", "")

        try:
            result = subprocess.run(
                ["lsblk", "-lno", "NAME,TYPE,MOUNTPOINT", disk],
                capture_output=True,
                text=True
            )
            if result.returncode != 0:
                return None

            partitions = []
            for line in result.stdout.strip().split("\n"):
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "part":
                    if len(parts) == 2:
                        part_name = parts[0]
                        pvs_result = subprocess.run(
                            ["pvs", f"/dev/{part_name}"],
                            capture_output=True
                        )
                        if pvs_result.returncode != 0:
                            partitions.append(f"/dev/{part_name}")

            if partitions:
                return partitions[0]

            for suffix in ["5", "p5"]:
                candidate = f"{disk}{suffix}"
                if subprocess.run(["test", "-b", candidate], capture_output=True).returncode == 0:
                    pvs_result = subprocess.run(["pvs", candidate], capture_output=True)
                    if pvs_result.returncode != 0:
                        return candidate

        except Exception as e:
            log.warning("Error finding vgdata partition: %s", e)
        return None

    def _copy_backup_for_restore(self):
        """Copy the selected backup archive into the installed system's restore directory."""
        restore_dir = joinpath(self._sysroot, "var/opt/k4all/restore")
        makedirs(restore_dir, exist_ok=True)

        src = self._backup_archive_path
        if not os.path.isfile(src):
            log.warning("Backup archive not found at %s", src)
            return

        dst = joinpath(restore_dir, os.path.basename(src))
        try:
            shutil.copy2(src, dst)
            log.info("Backup archive copied to %s for restore at first boot", dst)
        except Exception as e:
            log.warning("Failed to copy backup archive: %s", e)
