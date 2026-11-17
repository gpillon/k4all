"""Static checks that keep the image, the scripts and releases.yaml in step.

These catch, before any build, the mistakes that would break an upgrade in
the field: an image whose Kubernetes or CRI-O does not match its graph entry,
bootc's auto-update timer left active, scripts that never reach existing
nodes, kubeadm configs that a newer kubeadm rejects.
"""

import os
import re

import pytest
import yaml

from conftest import REPO, ku

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


def containerfile_args():
    text = read(BOOTC, "Containerfile")
    return dict(re.findall(r"^ARG (\w+)=(\S+)$", text, re.M)), text


def latest_release():
    with open(os.path.join(BOOTC, "upgrade", "releases.yaml"), encoding="utf-8") as fh:
        return ku.load_graph(yaml.safe_load(fh))[-1]


# --- the image matches its entry in the graph -----------------------------
def test_containerfile_versions_match_the_latest_release_entry():
    args, _ = containerfile_args()
    rel = latest_release()
    assert args["KUBERNETES_VERSION"] == rel.kubernetes
    assert args["CRIO_MINOR"] == rel.crio
    assert int(args["FEDORA_MAJOR"]) == rel.fedora


def test_crio_package_follows_the_crio_line():
    args, _ = containerfile_args()
    minor = args["CRIO_MINOR"]
    if ku.k8s_minor(minor) == ku.k8s_minor(args["KUBERNETES_VERSION"]):
        assert args["CRIO_PACKAGE"] == "cri-o" + minor, \
            "an aligned CRI-O must come from the versioned Fedora package"
    else:
        assert args["CRIO_PACKAGE"] == "cri-o" and minor == "1.32", \
            "only the bridge keeps the old unversioned cri-o"


def test_kubernetes_repo_serves_the_pinned_minor():
    args, _ = containerfile_args()
    repo = read(BOOTC, "overlay", "etc", "yum.repos.d", "kubernetes.repo")
    minor = "v%d.%d" % ku.k8s_minor(args["KUBERNETES_VERSION"])
    assert "core:/stable:/%s/rpm/" % minor in repo


def test_base_image_follows_the_fedora_arg():
    _, text = containerfile_args()
    assert "FROM quay.io/fedora/fedora-bootc:${FEDORA_MAJOR}" in text


def test_kubernetes_packages_are_pinned():
    _, text = containerfile_args()
    for pkg in ("kubeadm", "kubelet", "kubectl"):
        assert "%s-${KUBERNETES_VERSION}" % pkg in text


def test_prepulled_images_match_the_pinned_kubernetes():
    _, text = containerfile_args()
    assert 'kubeadm config images list --kubernetes-version "v${KUBERNETES_VERSION}"' in text
    assert "/usr/local/share/k4all-images" in text
    assert "/var/opt/k4all/.imagecache" not in text, \
        "bootc never refreshes /var: images must ship under /usr"


def test_no_floating_downloads_in_the_image_build():
    _, text = containerfile_args()
    assert "releases/latest/download/yq" not in text
    assert "get-helm-3" not in text
    assert "k4all-operator:latest'" not in text


def test_operator_version_is_a_release_tag():
    # "latest" makes operator v0.1.x replace itself with each new stable
    # operator release, outside any k4all upgrade.
    with open(os.path.join(BOOTC, "overlay", "usr", "local", "share",
                           "k4all-release.yaml"), encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    version = doc["spec"]["components"]["k4all-operator"]["version"]
    assert re.fullmatch(r"v\d+\.\d+\.\d+", version), version
    _, text = containerfile_args()
    assert "releases/latest/download/install.yaml" not in text
    workflow = read(REPO, ".github", "workflows", "build.yaml")
    assert "k4all-operator.version =" not in workflow


def test_image_records_its_release():
    _, text = containerfile_args()
    assert '"${K4ALL_VERSION}" > /usr/local/share/k4all-upgrade/version' in text
    assert "/usr/local/share/k4all-upgrade/releases.json" in text
    for label in ("io.k4all.version", "io.k4all.kubernetes", "io.k4all.crio",
                  "io.k4all.fedora"):
        assert label in text


# --- unattended upgrades ------------------------------------------------------
def test_bootc_auto_update_timer_is_masked():
    _, text = containerfile_args()
    assert "systemctl mask bootc-fetch-apply-updates.timer" in text


def test_k4all_upgrade_units_are_installed_and_enabled():
    _, text = containerfile_args()
    assert "systemctl enable k4all-upgrade.timer" in text
    assert "systemctl enable k4all-upgrade-resume.service" in text
    for unit in ("k4all-upgrade.timer", "k4all-upgrade.service",
                 "k4all-upgrade-resume.service"):
        assert os.path.exists(os.path.join(BOOTC, "systemd", unit)), unit
    resume = read(BOOTC, "systemd", "k4all-upgrade-resume.service")
    assert "Type=exec" in resume, "post-boot checks must not block boot"
    assert "ExecStart=/usr/local/bin/k4all-upgrade resume" in resume


def test_upgrade_tool_is_executable():
    assert os.access(os.path.join(BIN, "k4all-upgrade"), os.X_OK)


# --- scripts that later hops rely on ---------------------------------------
def test_role_dispatcher_runs_on_every_boot():
    unit = read(BOOTC, "systemd", "fck8s-role-dispatcher.service")
    assert "role-dispatcher.done" not in unit
    script = read(BIN, "k4all-role-dispatcher.sh")
    assert "STAMP_FILE" in script and "copy_overrides \"$OVERRIDES_BASE/$dir\" scripts" in script


def test_kubeadm_configs_are_v1beta4_without_flexvolume_flag():
    # v1beta3 goes away in kubeadm 1.37; the controller-manager flex mount
    # in kubeadm 1.36.
    for role in ("bootstrap", "control", "worker"):
        docs = list(yaml.safe_load_all(read(BIN, "overrides", role,
                                            "k8s-config-%s.yaml" % role)))
        for doc in docs:
            assert doc["apiVersion"] == "kubeadm.k8s.io/v1beta4", role
            cm = doc.get("controllerManager") or {}
            names = [a["name"] for a in cm.get("extraArgs") or []]
            assert "flex-volume-plugin-dir" not in names, role


def test_bootstrap_init_pins_the_control_plane_to_the_kubelet():
    script = read(BIN, "overrides", "bootstrap", "setup-k8s-init.sh")
    assert ".kubernetesVersion) = " in script


def test_ph3_never_resets_an_existing_cluster():
    script = read(BIN, "overrides", "bootstrap-control", "setup-k8s-ph3.sh")
    guard = script.index("/etc/kubernetes/admin.conf")
    reset = script.index("kubeadm reset --force")
    assert guard < reset


def test_release_helpers_read_spec_components():
    utils = read(BIN, "k4all-utils")
    assert '".components.' not in utils
    assert ".spec.components." in utils


def test_backup_and_restore_keep_the_yaml_config():
    assert "/etc/k4all-config.yaml" in read(BIN, "k4all-backup.sh")
    assert "k4all-config.yaml" in read(BIN, "k4all-restore.sh")


def test_short_image_names_resolve_on_docker_io_only():
    # CRI-O 1.35 enforces short-name mode: with Fedora's three search
    # registries "nginx:latest" is ambiguous and the pod never starts.
    conf = read(BOOTC, "overlay", "etc", "containers", "registries.conf.d",
                "50-k4all-short-names.conf")
    lines = [l for l in conf.splitlines() if l.strip() and not l.startswith("#")]
    assert lines == ['unqualified-search-registries = ["docker.io"]']
    text = read(BOOTC, "Containerfile")
    assert "/etc/containers/registries.conf.d/50-k4all-short-names.conf" in text


def test_lvm_setup_keeps_thick_volumes():
    script = read(BIN, "setup-lvm.sh")
    assert "lvs --noheadings -o lv_name vg_data" in script


def test_update_node_delegates_to_k4all_upgrade():
    script = read(BIN, "update-node.sh")
    assert "k4all-upgrade run" in script
    assert "bootc upgrade" not in script


def test_deploy_operator_fallback_paths_exist_in_the_image():
    script = read(BIN, "deploy-operator.sh")
    _, text = containerfile_args()
    assert "/usr/local/share/k4all-operator/install.yaml" not in script
    assert "/usr/local/share/k4all-operator-install.yaml" in script
    assert "/usr/local/share/k4all-operator-install.yaml" in text
    assert "prerelease == false" in script
