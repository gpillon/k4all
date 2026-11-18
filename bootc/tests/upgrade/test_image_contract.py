"""Static checks that keep the image, the scripts and releases.yaml in step.

These catch, before any build, the mistakes that would break an upgrade in
the field: an image whose Kubernetes or CRI-O does not match its graph entry,
bootc's auto-update timer left active, scripts that never reach existing
nodes, kubeadm configs that a newer kubeadm rejects.
"""

import os
import re

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


def test_the_bridge_digest_comes_from_index_digest():
    # The release job stamps k4all-bridge.sh with the bridge's index digest.
    # The graph has it as indexDigest only (build-graph.py): from "digest"
    # jq would give "null", and the bridge would fall back to the tag.
    workflow = read(REPO, ".github", "workflows", "build.yaml")
    line, = [l for l in workflow.splitlines() if l.strip().startswith("BRIDGE_DIGEST=")]
    assert '.indexDigest' in line and '.digest' not in line
    assert 'sha256:*) ;;' in workflow, "an empty digest fails the release job"


def test_the_pinned_operator_comes_with_a_sync():
    # Clusters get a new operator only through a ReleaseManifest sync (a
    # patch may carry one: v2.6.1). The newest release that syncs names the
    # operator the image pins; a pin bumped without a sync fails here.
    graph = ku.load_graph(yaml.safe_load(read(BOOTC, "upgrade", "releases.yaml")))
    last_sync = [r for r in graph if r.sync_manifest][-1]
    pinned = release_components()["k4all-operator"]["version"]
    assert "operator %s" % pinned in " ".join(last_sync.notes.split()), \
        (last_sync.version, pinned)


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


def test_traefik_waits_only_for_metallb():
    # Traefik needs MetalLB for its LoadBalancer IP (the operator's helm
    # wait), not cert-manager: that dependency came from ingress-nginx.
    with open(os.path.join(BOOTC, "overlay", "usr", "local", "share",
                           "k4all-release.yaml"), encoding="utf-8") as fh:
        components = yaml.safe_load(fh)["spec"]["components"]
    assert components["traefik"]["dependsOn"] == ["metallb"]


def test_traefik_image_ships_with_the_image():
    # Traefik replaces ingress-nginx during a manifest sync; k4all-upgrade
    # loads the shipped images first, so the routes come back without a pull.
    _, text = containerfile_args()
    assert "helm show chart traefik" in text
    assert '"docker.io/traefik:${TRAEFIK_TAG}"' in text


# --- ingress: Traefik only, from v2.4.0 ---------------------------------------
REDIRECT = "traefik-redirect-https@kubernetescrd"
MIDDLEWARE_ANNOTATION = "traefik.ingress.kubernetes.io/router.middlewares"


def release_components():
    with open(os.path.join(BOOTC, "overlay", "usr", "local", "share",
                           "k4all-release.yaml"), encoding="utf-8") as fh:
        return yaml.safe_load(fh)["spec"]["components"]


def nginx_leftovers(node, path="values"):
    """Paths of ingress-nginx classes and annotations inside chart values."""
    found = []
    if isinstance(node, dict):
        for key, value in node.items():
            here = "%s.%s" % (path, key)
            if str(key).startswith("nginx.ingress.kubernetes.io/"):
                found.append(here)
            elif key in ("ingressClassName", "className", "ingressClass") \
                    and value == "nginx":
                found.append(here)
            else:
                found += nginx_leftovers(value, here)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            found += nginx_leftovers(value, "%s[%d]" % (path, i))
    return found


def test_k4all_routes_use_the_traefik_class():
    # From v2.4.0 k4all no longer points at ingress-nginx: its own routes use
    # the traefik class and the redirect Middleware. Only traefik's nginx
    # IngressClass stays, for users' Ingresses.
    components = release_components()
    for name, comp in components.items():
        values = dict(comp.get("values") or {})
        if name == "traefik":
            values["extraObjects"] = [o for o in values["extraObjects"]
                                      if o["kind"] != "IngressClass"]
        assert nginx_leftovers(values) == [], name
    for name, ingress in (
            ("headlamp", components["headlamp"]["values"]["ingress"]),
            ("argocd", components["argocd"]["values"]["server"]["ingress"])):
        assert ingress["ingressClassName"] == "traefik", name
        assert ingress["annotations"] == {MIDDLEWARE_ANNOTATION: REDIRECT}, name
    # The headlamp hook writes the dashboard route once the Middleware is there.
    assert "traefik" in components["headlamp"]["dependsOn"]
    assert "traefik" in components["argocd"]["dependsOn"]


def test_traefik_ships_the_redirect_middleware():
    values = release_components()["traefik"]["values"]
    assert values["providers"]["kubernetesCRD"]["enabled"] is True
    middlewares = [o for o in values["extraObjects"] if o["kind"] == "Middleware"]
    assert middlewares == [{
        "apiVersion": "traefik.io/v1alpha1", "kind": "Middleware",
        "metadata": {"name": "redirect-https", "namespace": "traefik"},
        "spec": {"redirectScheme": {"scheme": "https", "permanent": True}}}]
    meta = middlewares[0]["metadata"]
    assert REDIRECT == "%s-%s@kubernetescrd" % (meta["namespace"], meta["name"])
    script = read(BIN, "update-routes.sh")
    assert "REDIRECT_NAMESPACE=%s\n" % meta["namespace"] in script
    assert "REDIRECT_NAME=%s\n" % meta["name"] in script
    nginx = [o for o in values["extraObjects"] if o["kind"] == "IngressClass"]
    assert [o["metadata"]["name"] for o in nginx] == ["nginx"]
    assert nginx[0]["metadata"]["annotations"] == {
        "ingressclass.kubernetes.io/is-default-class": "false"}


def test_ingress_nginx_is_gone_from_the_release():
    # Every cluster passes v2.4.0 (a minor), whose sync uninstalled
    # ingress-nginx (management: Removed); from v2.6.0 the manifest no longer
    # lists it, and nothing may depend on it.
    components = release_components()
    assert "ingress-nginx" not in components
    for name, comp in components.items():
        assert "ingress-nginx" not in comp.get("dependsOn", []), name
    graph = ku.load_graph(yaml.safe_load(read(BOOTC, "upgrade", "releases.yaml")))
    removed_in = [r for r in graph if r.version == "v2.4.0"]
    assert removed_in and removed_in[0].kind == "minor", \
        "the release that uninstalls ingress-nginx must be a mandatory stop"
    assert removed_in[0].sync_manifest, \
        "and it must sync its ReleaseManifest, or the uninstall never happens"


def test_update_routes_timer_needs_only_shipped_units():
    # A Requires= on a unit that does not exist keeps the timer from starting.
    timer = read(BOOTC, "systemd", "fck8s-update-routes.timer")
    for name in re.findall(r"^Requires=(.+)$", timer, re.M):
        for unit in name.split():
            assert os.path.exists(os.path.join(BOOTC, "systemd", unit)), unit


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
    # --boot: only hops past their reboot (a waiting hop is the timer's)
    assert "ExecStart=/usr/local/bin/k4all-upgrade resume --boot" in resume
    assert ku.build_parser().parse_args(["resume", "--boot"]).boot


def test_upgrade_agent_timer_is_installed_and_enabled():
    # The ClusterUpgrade protocol: the agent reads upgrade-target every
    # minute and right after boot, behind the resume of a hop. Until an
    # operator writes upgrade-target (from v2.4.0) it only publishes the
    # node's release and node-type.
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


def test_kube_vip_is_the_hosts():
    # Operators up to v0.4.x rewrite a Managed static-pod kube-vip as a Pod
    # with the image alone, and the API VIP goes away. From v2.4.0 the
    # manifest also pins the version k4all-upgrade writes.
    with open(os.path.join(BOOTC, "overlay", "usr", "local", "share",
                           "k4all-release.yaml"), encoding="utf-8") as fh:
        kube_vip = yaml.safe_load(fh)["spec"]["components"]["kube-vip"]
    assert kube_vip["management"] == "Unmanaged"
    assert re.fullmatch(r"v\d+\.\d+\.\d+", kube_vip["version"])


def test_topolvm_volumes_wait_for_their_pod():
    # Multi-node lab: with Immediate binding a PVC got its volume on the
    # control plane while its pod was meant for the worker, and the pod
    # stayed Pending. k4all's storageClasses list replaces the chart's,
    # which sets WaitForFirstConsumer.
    manifest = yaml.safe_load(read(BOOTC, "overlay", "usr", "local", "share",
                                   "k4all-release.yaml"))
    classes = manifest["spec"]["components"]["topolvm"]["values"]["storageClasses"]
    assert classes
    for entry in classes:
        assert entry["storageClass"]["volumeBindingMode"] == \
            "WaitForFirstConsumer", entry["name"]


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
