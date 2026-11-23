"""Contract tests for the kickstarts actually shipped in K4All ISOs."""

from pathlib import Path
import shlex
import tomllib

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2]

TOML_CONFIGS = [
    PROJECT_ROOT / "bootc/iso/config/attended.toml",
    PROJECT_ROOT / "bootc/iso/config/unattended-bootstrap.toml",
    PROJECT_ROOT / "bootc/iso/config/unattended-control.toml",
    PROJECT_ROOT / "bootc/iso/config/unattended-worker.toml",
]

STANDALONE_KICKSTARTS = [
    PROJECT_ROOT / "bootc/iso/ks/ks-bootstrap.cfg",
    PROJECT_ROOT / "bootc/iso/ks/ks-worker.cfg",
]


def _kickstart_from_toml(path):
    with path.open("rb") as stream:
        config = tomllib.load(stream)
    return config["customizations"]["installer"]["kickstart"]["contents"]


def _parse_k4all_addon(kickstart):
    from com_k4all_installer.service.kickstart import K4AllData

    data = K4AllData()
    in_addon = False
    found = False

    for line in kickstart.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("%addon com_k4all_installer"):
            data.handle_header(shlex.split(stripped)[2:])
            in_addon = True
            found = True
            continue
        if in_addon and stripped == "%end":
            break
        if in_addon:
            data.handle_line(line)

    assert found, "K4All addon section not found"
    data.finalize()
    return data


@pytest.mark.parametrize("config_path", TOML_CONFIGS, ids=lambda path: path.name)
def test_iso_toml_kickstart_matches_clusterconfig_contract(config_path):
    data = _parse_k4all_addon(_kickstart_from_toml(config_path))
    _assert_clusterconfig_contract(data.cluster_config)


@pytest.mark.parametrize("kickstart_path", STANDALONE_KICKSTARTS, ids=lambda path: path.name)
def test_standalone_kickstart_matches_clusterconfig_contract(kickstart_path):
    data = _parse_k4all_addon(kickstart_path.read_text())
    _assert_clusterconfig_contract(data.cluster_config)


def _assert_clusterconfig_contract(config):
    assert "iface" not in config["networking"]
    assert config["networking"]["firewalld"]["enabled"] is False
    assert config["cluster"]["apiEndPointUseHostName"] is False
    assert config["features"]["virt"]["enabled"] is False
    assert config["features"]["argocd"]["enabled"] is False
    assert config["features"]["ovsCni"]["enabled"] is False
    assert config["features"]["ovsBridge"]["enabled"] is True


JOINING_KICKSTARTS = {
    "unattended-control.toml": lambda: _kickstart_from_toml(TOML_CONFIGS[2]),
    "unattended-worker.toml": lambda: _kickstart_from_toml(TOML_CONFIGS[3]),
    "ks-worker.cfg": lambda: STANDALONE_KICKSTARTS[1].read_text(),
}


@pytest.mark.parametrize("name", sorted(JOINING_KICKSTARTS))
def test_joining_kickstarts_do_not_guess_the_cni(name):
    # Issue #63: the worker and control ISOs wrote --cni=calico whatever
    # the cluster runs. The node takes the cluster's CNI when it joins.
    kickstart = JOINING_KICKSTARTS[name]()
    addon = kickstart[kickstart.index("%addon com_k4all_installer"):]
    addon = addon[:addon.index("%end")]
    assert "--cni" not in addon
    assert '"cni"' not in addon


@pytest.mark.parametrize("path", [TOML_CONFIGS[1], STANDALONE_KICKSTARTS[0]],
                         ids=lambda path: path.name)
def test_bootstrap_kickstarts_still_choose_the_cni(path):
    kickstart = (_kickstart_from_toml(path) if path.suffix == ".toml"
                 else path.read_text())
    data = _parse_k4all_addon(kickstart)
    assert data.role == "bootstrap"
    assert "--cni=calico" in kickstart
    assert data.cluster_config["networking"]["cni"]["type"] == "calico"
