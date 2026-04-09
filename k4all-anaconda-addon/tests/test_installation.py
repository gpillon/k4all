# =============================================================================
# Tests for com_k4all_installer.service.installation
# =============================================================================

import os
import tempfile
import shutil
import copy
import pytest
from unittest.mock import patch, MagicMock

try:
    import yaml
except ImportError:
    yaml = None


class TestK4AllConfigurationTask:
    """Test the pre-installation configuration task."""

    def test_task_name(self):
        from com_k4all_installer.service.installation import K4AllConfigurationTask
        task = K4AllConfigurationTask()
        assert task.name == "Configure K4All"

    def test_task_runs_without_error(self):
        from com_k4all_installer.service.installation import K4AllConfigurationTask
        task = K4AllConfigurationTask()
        task.run()


class TestK4AllInstallationTask:
    """Test the installation task that writes config files."""

    def setup_method(self):
        self.sysroot = tempfile.mkdtemp(prefix="k4all-test-sysroot-")

    def teardown_method(self):
        shutil.rmtree(self.sysroot, ignore_errors=True)

    def _make_task(self, role="bootstrap", cluster_config=None, install_config=None):
        from com_k4all_installer.service.installation import K4AllInstallationTask
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG, DEFAULT_INSTALL_CONFIG
        if cluster_config is None:
            cluster_config = copy.deepcopy(DEFAULT_CLUSTER_CONFIG)
        if install_config is None:
            install_config = copy.deepcopy(DEFAULT_INSTALL_CONFIG)
        return K4AllInstallationTask(
            sysroot=self.sysroot,
            role=role,
            cluster_config=cluster_config,
            install_config=install_config
        )

    def _read_config_yaml(self):
        config_path = os.path.join(self.sysroot, "etc", "k4all-config.yaml")
        assert os.path.exists(config_path), f"{config_path} does not exist"
        with open(config_path) as f:
            if yaml is not None:
                return yaml.safe_load(f)
            # Minimal fallback for envs without PyYAML
            import json
            content = f.read()
            return None  # cannot parse without yaml

    def test_task_name(self):
        task = self._make_task()
        assert task.name == "Install K4All Configuration"

    def test_writes_config_yaml(self):
        task = self._make_task(role="bootstrap")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.yaml")
        assert os.path.exists(config_path)

    def test_yaml_is_valid_clusterconfig_cr(self):
        task = self._make_task(role="bootstrap")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        cr = self._read_config_yaml()
        if cr is None:
            pytest.skip("PyYAML not available")
        assert cr["apiVersion"] == "k4all.magesgate.com/v1alpha1"
        assert cr["kind"] == "ClusterConfig"
        assert cr["metadata"]["name"] == "k4all-cluster-config"
        assert "spec" in cr
        assert cr["spec"]["networking"]["cni"]["type"] == "calico"

    def test_writes_node_type_bootstrap(self):
        task = self._make_task(role="bootstrap")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        node_type_path = os.path.join(self.sysroot, "etc", "node-type")
        assert os.path.exists(node_type_path)
        with open(node_type_path) as f:
            assert f.read().strip() == "bootstrap"

    def test_writes_node_type_worker(self):
        task = self._make_task(role="worker")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        node_type_path = os.path.join(self.sysroot, "etc", "node-type")
        with open(node_type_path) as f:
            assert f.read().strip() == "worker"

    def test_writes_node_type_control(self):
        task = self._make_task(role="control")
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        node_type_path = os.path.join(self.sysroot, "etc", "node-type")
        with open(node_type_path) as f:
            assert f.read().strip() == "control"

    def test_creates_writable_directories(self):
        task = self._make_task()
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        assert os.path.isdir(os.path.join(self.sysroot, "var", "opt", "k4all"))
        assert os.path.isdir(os.path.join(self.sysroot, "var", "home", "core", ".kube"))
        assert os.path.isdir(os.path.join(self.sysroot, "var", "roothome", ".kube"))

    def test_custom_config_is_preserved(self):
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        cluster_config = copy.deepcopy(DEFAULT_CLUSTER_CONFIG)
        cluster_config["networking"]["cni"]["type"] = "cilium"
        cluster_config["cluster"]["ha"]["type"] = "keepalived"
        cluster_config["features"]["virt"]["enabled"] = True

        task = self._make_task(role="control", cluster_config=cluster_config)
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        cr = self._read_config_yaml()
        if cr is None:
            pytest.skip("PyYAML not available")
        spec = cr["spec"]
        assert spec["networking"]["cni"]["type"] == "cilium"
        assert spec["cluster"]["ha"]["type"] == "keepalived"
        assert spec["features"]["virt"]["enabled"] is True

    def test_vg_data_disabled_skips(self):
        from com_k4all_installer.constants import DEFAULT_INSTALL_CONFIG
        install_config = copy.deepcopy(DEFAULT_INSTALL_CONFIG)
        install_config["storage"]["vg_data"]["enabled"] = "false"

        task = self._make_task(install_config=install_config)
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            task.run()

        vg_calls = [
            c for c in mock_run.call_args_list
            if "vgdisplay" in str(c) or "vgcreate" in str(c) or "pvcreate" in str(c)
        ]
        assert len(vg_calls) == 0

    def test_vg_data_already_exists_skips(self):
        task = self._make_task()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
            task.run()

        create_calls = [
            c for c in mock_run.call_args_list
            if "pvcreate" in str(c) or "vgcreate" in str(c)
        ]
        assert len(create_calls) == 0


class TestInstallationTaskEdgeCases:
    """Test edge cases for the installation task."""

    def setup_method(self):
        self.sysroot = tempfile.mkdtemp(prefix="k4all-test-sysroot-")

    def teardown_method(self):
        shutil.rmtree(self.sysroot, ignore_errors=True)

    def test_sysroot_with_trailing_slash(self):
        from com_k4all_installer.service.installation import K4AllInstallationTask
        from com_k4all_installer.constants import DEFAULT_CLUSTER_CONFIG
        cluster_config = copy.deepcopy(DEFAULT_CLUSTER_CONFIG)

        task = K4AllInstallationTask(
            sysroot=self.sysroot + "/",
            role="bootstrap",
            cluster_config=cluster_config
        )
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.yaml")
        assert os.path.exists(config_path)

    def test_config_with_minimal_spec(self):
        from com_k4all_installer.service.installation import K4AllInstallationTask
        cluster_config = {"networking": {"cni": {"type": "calico"}}}

        task = K4AllInstallationTask(
            sysroot=self.sysroot,
            role="bootstrap",
            cluster_config=cluster_config
        )
        with patch("subprocess.run", return_value=MagicMock(returncode=1)):
            task.run()

        config_path = os.path.join(self.sysroot, "etc", "k4all-config.yaml")
        assert os.path.exists(config_path)
