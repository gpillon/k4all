"""Cross-component contracts between the bootc image and the addon."""

from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_release_manifest_uses_helm_map_for_ingress_extra_args():
    yaml = pytest.importorskip("yaml")
    release_path = PROJECT_ROOT / "bootc/overlay/usr/local/share/k4all-release.yaml"
    release = yaml.safe_load(release_path.read_text())

    extra_args = (
        release["spec"]["components"]["ingress-nginx"]
        ["values"]["controller"]["extraArgs"]
    )
    assert extra_args == {"enable-ssl-passthrough": ""}


def test_lvm_setup_repairs_missing_topolvm_thin_pool():
    script_path = PROJECT_ROOT / "bootc/overlay/usr/local/bin/setup-lvm.sh"
    unit_path = PROJECT_ROOT / "bootc/systemd/fck8s-lvm-setup.service"
    script = script_path.read_text()
    unit = unit_path.read_text()

    assert 'lvdisplay vg_data/thin-pool' in script
    assert 'lvcreate -l 100%FREE -T -n thin-pool vg_data' in script
    assert 'stale LVM setup marker' in script
    assert "ConditionPathExists" not in unit


def test_operator_done_marker_matches_systemd_unit():
    script_path = PROJECT_ROOT / "bootc/overlay/usr/local/bin/deploy-operator.sh"
    unit_path = PROJECT_ROOT / "bootc/systemd/fck8s-operator-deploy.service"
    script = script_path.read_text()
    unit = unit_path.read_text()

    marker = "/opt/k4all/operator-deployed.done"
    assert f'DONE_FILE="{marker}"' in script
    assert f"ConditionPathExists=!{marker}" in unit


def test_iso_install_cannot_verify_an_unrelated_vm():
    script_path = PROJECT_ROOT / "bootc/tests/test-iso-install.sh"
    script = script_path.read_text()

    assert 'ss -H -ltn "sport = :${SSH_PORT}"' in script
    assert "refusing to run against an unrelated VM" in script
    assert 'kill -0 "$QEMU_PID"' in script
    assert "QEMU exited during boot startup" in script
