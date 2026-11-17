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


def test_release_manifest_pins_every_component():
    # A floating version moves clusters outside any k4all release, and
    # upgradePath steps only make sense between fixed versions.
    with open(os.path.join(BOOTC, "overlay", "usr", "local", "share",
                           "k4all-release.yaml"), encoding="utf-8") as fh:
        components = yaml.safe_load(fh)["spec"]["components"]
    floating = [name for name, comp in components.items()
                if str(comp.get("version", "")).strip() in ("", "latest")]
    assert floating == []
    for name, comp in components.items():
        steps = [step["version"] for step in comp.get("upgradePath", [])]
        assert comp["version"] not in steps, name
        assert len(set(steps)) == len(steps), name


def test_traefik_image_ships_with_the_image():
    # Traefik replaces ingress-nginx during a manifest sync; k4all-upgrade
    # loads the shipped images first, so the routes come back without a pull.
    _, text = containerfile_args()
    assert "helm show chart traefik" in text
    assert '"docker.io/traefik:${TRAEFIK_TAG}"' in text


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


def test_upgrade_agent_timer_is_installed_and_enabled():
    # The ClusterUpgrade protocol: the agent reads upgrade-target every
    # minute and right after boot, behind the resume of a hop.
    _, text = containerfile_args()
    assert "systemctl enable k4all-upgrade-agent.timer" in text
    for unit in ("k4all-upgrade-agent.timer", "k4all-upgrade-agent.service"):
        assert os.path.exists(os.path.join(BOOTC, "systemd", unit)), unit
    service = read(BOOTC, "systemd", "k4all-upgrade-agent.service")
    assert "ExecStart=/usr/local/bin/k4all-upgrade agent" in service
    assert "Type=oneshot" in service, "a hop must not run twice"
    assert re.search(r"^After=.*\bk4all-upgrade-resume\.service\b", service, re.M)
    assert "[Install]" not in service, "started by the timer only"
    timer = read(BOOTC, "systemd", "k4all-upgrade-agent.timer")
    assert re.search(r"^OnCalendar=minutely$", timer, re.M)
    assert re.search(r"^OnBootSec=\S+$", timer, re.M)
    assert "WantedBy=timers.target" in timer
    assert ku.build_parser().parse_args(["agent"]).command == "agent"


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


def test_topolvm_controller_rolls_out_on_a_single_node():
    # One replica plus the chart's required anti-affinity: a surge rollout
    # never completes on a single node (seen in the lab after the v2.4.0 sync).
    manifest = yaml.safe_load(read(BOOTC, "overlay", "usr", "local", "share",
                                   "k4all-release.yaml"))
    controller = manifest["spec"]["components"]["topolvm"]["values"]["controller"]
    assert controller["replicaCount"] == 1
    rolling = controller["updateStrategy"]["rollingUpdate"]
    assert rolling["maxSurge"] == 0 and rolling["maxUnavailable"] == 1


def test_etcd_tools_come_from_the_etcd_image():
    # The image has no etcd package from Fedora 45 on.
    install = read(BOOTC, "Containerfile").split("dnf clean all")[0]
    assert not re.search(r"^\s+etcd\b", install, re.M)
    assert "--entrypoint /usr/local/bin/etcdctl" in read(BIN, "k4all-backup.sh")
    restore = read(BIN, "k4all-restore.sh")
    assert "--entrypoint /usr/local/bin/etcdutl" in restore


def test_fedora_repos_are_visible_to_the_iso_build():
    # bootc-image-builder reads /etc/yum.repos.d only; Fedora 45 ships its
    # repo files in /usr/share/dnf5/repos.d.
    text = read(BOOTC, "Containerfile")
    assert "/usr/share/dnf5/repos.d/*.repo" in text
    # Relative: the builder mounts the image under another root, so an
    # absolute link resolves outside it (the ISO build then fails again).
    assert 'ln -s "../../usr/share/dnf5/repos.d/$b" "/etc/yum.repos.d/$b"' in text


def test_crio_finds_the_container_policy_on_fedora_45():
    # containers-common 0.69 (Fedora 45) ships policy.json and registries.conf
    # under /usr/share/containers; CRI-O only reads /etc/containers/policy.json
    # and every pull failed after the F43 -> F45 hop.
    text = read(BOOTC, "Containerfile")
    assert "for f in policy.json registries.conf" in text
    assert 'ln -s "../../usr/share/containers/$f" "/etc/containers/$f"' in text


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


def test_headlamp_carries_the_pinned_k4all_plugin():
    # The k4all Headlamp plugin is an image that an initContainer copies into
    # Headlamp's plugins dir. Pinned per release like every component: a
    # floating tag would change the UI outside any k4all upgrade, and
    # IfNotPresent would keep whichever build a node pulled first.
    with open(os.path.join(BOOTC, "overlay", "usr", "local", "share",
                           "k4all-release.yaml"), encoding="utf-8") as fh:
        values = yaml.safe_load(fh)["spec"]["components"]["headlamp"]["values"]
    plugin = [c for c in values.get("initContainers") or []
              if c.get("name") == "k4all-plugin"]
    assert len(plugin) == 1, "headlamp has no k4all-plugin initContainer"
    image = plugin[0]["image"]
    repo, _, tag = image.split("@")[0].rpartition(":")
    assert repo == "ghcr.io/gpillon/k4all-headlamp-plugin", image
    assert re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", tag), \
        "the plugin image needs a release tag, not %r" % tag
    assert any(v.get("name") == "k4all-plugin" and "emptyDir" in v
               for v in values.get("volumes") or [])
    mount = "%s/k4all-headlamp-plugin" % values["config"]["pluginsDir"].rstrip("/")
    assert any(m.get("name") == "k4all-plugin" and m.get("mountPath") == mount
               and m.get("readOnly") is True
               for m in values.get("volumeMounts") or []), mount
