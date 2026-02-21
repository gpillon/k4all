# =============================================================================
# Tests for com_k4all_installer.service.installation
# =============================================================================

import json
import os
import tempfile
import shutil
import copy
import pytest
from unittest.mock import patch, MagicMock


class TestK4AllConfigurationTask:
    """Test the pre-installation configuration task."""

    def test_task_name(self):
        from com_k4all_installer.service.installation import K4AllConfigurationTask
        task = K4AllConfigurationTask()
        assert task.name == "Configure K4All"

    def test_task_runs_without_error(self):
        from com_k4all_installer.service.installation import K4AllConfigurationTask
        task = K4AllConfigurationTask()
        task.run()  # Should not raise


class TestK4AllInstallationTask:
    """Test the installation task that writes config files."""

    def setup_method(self):
        """Create a temporary sysroot for each test."""
        self.sysroot = tempfile.mkdtemp(prefix="k4all-test-sysroot-")

    def teardown_method(self):
        """Clean up the temporary sysroot."""
        shutil.rmtree(self.sysroot, ignore_errors=True)

    def _make_task(self, role="bootstrap", config=None):
        from com_k4all_installer.service.installation import K4AllInstallationTask
        from com_k4all_installer.constants import DEFAULT_CONFIG
        if config is None:
            config = copy.deepcopy(DEFAULT_CONFIG)
        return K4AllInstallationTask(
            sysroot=self.sysroot,
            role=role,
            config=config
        )

    def test_task_name(self):
        task = self._make_task()
        assert task.name == "Install K4All Configuration"

    # -------------------------------------------------------------------------
    # Config file writing
    # -------------------------------------------------------------------------
    def test_writes_config_json(self):
        """Task should write /etc/k4all-config.json."""
        task = self._make_task(role="bootstrap")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.json")
        assert os.path.exists(config_path)

        with open(config_path) as f:
            config = json.load(f)
        assert config["version"] == "2.0.0"
        assert config["networking"]["cni"]["type"] == "calico"

    def test_writes_node_type_bootstrap(self):
        """Task should write /etc/node-type with the role."""
        task = self._make_task(role="bootstrap")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        node_type_path = os.path.join(self.sysroot, "etc", "node-type")
        assert os.path.exists(node_type_path)
        with open(node_type_path) as f:
            content = f.read().strip()
        assert content == "bootstrap"

    def test_writes_node_type_worker(self):
        task = self._make_task(role="worker")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        node_type_path = os.path.join(self.sysroot, "etc", "node-type")
        with open(node_type_path) as f:
            content = f.read().strip()
        assert content == "worker"

    def test_writes_node_type_control(self):
        task = self._make_task(role="control")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        node_type_path = os.path.join(self.sysroot, "etc", "node-type")
        with open(node_type_path) as f:
            content = f.read().strip()
        assert content == "control"

    def test_creates_k4all_directory(self):
        task = self._make_task()
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        k4all_dir = os.path.join(self.sysroot, "opt", "k4all")
        assert os.path.isdir(k4all_dir)

    def test_creates_kube_directories(self):
        task = self._make_task()
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        root_kube = os.path.join(self.sysroot, "root", ".kube")
        core_kube = os.path.join(self.sysroot, "home", "core", ".kube")
        assert os.path.isdir(root_kube)
        assert os.path.isdir(core_kube)

    def test_config_json_is_valid(self):
        """Written config should be valid JSON."""
        task = self._make_task()
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.json")
        with open(config_path) as f:
            config = json.load(f)  # Should not raise
        assert isinstance(config, dict)

    def test_custom_config_is_written(self):
        """Custom config values should be preserved."""
        from com_k4all_installer.constants import DEFAULT_CONFIG
        config = copy.deepcopy(DEFAULT_CONFIG)
        config["networking"]["cni"]["type"] = "cilium"
        config["cluster"]["ha"]["type"] = "keepalived"
        config["features"]["virt"]["enabled"] = "true"

        task = self._make_task(role="control", config=config)
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.json")
        with open(config_path) as f:
            written = json.load(f)
        assert written["networking"]["cni"]["type"] == "cilium"
        assert written["cluster"]["ha"]["type"] == "keepalived"
        assert written["features"]["virt"]["enabled"] == "true"

    # -------------------------------------------------------------------------
    # vg_data setup
    # -------------------------------------------------------------------------
    def test_vg_data_disabled_skips(self):
        """If vg_data is disabled, no subprocess should be called for LVM."""
        from com_k4all_installer.constants import DEFAULT_CONFIG
        config = copy.deepcopy(DEFAULT_CONFIG)
        config["storage"]["vg_data"]["enabled"] = "false"

        task = self._make_task(config=config)
        with patch("subprocess.run") as mock_run:
            # First call: vgdisplay check (returns 1 = not found)
            mock_run.return_value = MagicMock(returncode=1)
            task.run()

        # vgdisplay should NOT be called for vg_data since it's disabled
        vg_calls = [
            c for c in mock_run.call_args_list
            if "vgdisplay" in str(c) or "vgcreate" in str(c) or "pvcreate" in str(c)
        ]
        assert len(vg_calls) == 0

    def test_vg_data_already_exists_skips(self):
        """If vg_data already exists, creation should be skipped."""
        task = self._make_task()
        with patch("subprocess.run") as mock_run:
            # vgdisplay returns 0 = vg_data exists
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
            task.run()

        # pvcreate/vgcreate should NOT be called
        create_calls = [
            c for c in mock_run.call_args_list
            if "pvcreate" in str(c) or "vgcreate" in str(c)
        ]
        assert len(create_calls) == 0

    def test_vg_data_explicit_disk(self):
        """If a specific disk is set, it should be used for disk detection."""
        from com_k4all_installer.constants import DEFAULT_CONFIG
        config = copy.deepcopy(DEFAULT_CONFIG)
        config["storage"]["vg_data"]["disk"] = "/dev/sdb"

        task = self._make_task(config=config)

        def mock_subprocess(args, **kwargs):
            m = MagicMock()
            if args[0] == "vgdisplay":
                m.returncode = 1  # vg_data doesn't exist
            elif args[0] == "lsblk":
                m.returncode = 0
                m.stdout = "sdb1  part\nsdb2  part\n"
            elif args[0] == "pvs":
                m.returncode = 1  # not a PV
            elif args[0] == "pvcreate":
                m.returncode = 0
            elif args[0] == "vgcreate":
                m.returncode = 0
            elif args[0] == "test":
                m.returncode = 1
            else:
                m.returncode = 0
            return m

        with patch("subprocess.run", side_effect=mock_subprocess):
            task.run()


class TestInstallationTaskEdgeCases:
    """Test edge cases for the installation task."""

    def setup_method(self):
        self.sysroot = tempfile.mkdtemp(prefix="k4all-test-sysroot-")

    def teardown_method(self):
        shutil.rmtree(self.sysroot, ignore_errors=True)

    def test_sysroot_with_trailing_slash(self):
        from com_k4all_installer.service.installation import K4AllInstallationTask
        from com_k4all_installer.constants import DEFAULT_CONFIG
        config = copy.deepcopy(DEFAULT_CONFIG)

        task = K4AllInstallationTask(
            sysroot=self.sysroot + "/",
            role="bootstrap",
            config=config
        )
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.json")
        assert os.path.exists(config_path)

    def test_config_with_no_storage_section(self):
        """Config without storage section should not crash."""
        from com_k4all_installer.service.installation import K4AllInstallationTask
        config = {"version": "2.0.0", "networking": {"cni": {"type": "calico"}}}

        task = K4AllInstallationTask(
            sysroot=self.sysroot,
            role="bootstrap",
            config=config
        )
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.json")
        assert os.path.exists(config_path)
