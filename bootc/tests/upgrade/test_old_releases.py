"""Today's k4all-upgrade on the releases that come before the features it has.

The same tool ships from the v2.2.4 bridge on. Where a release needs another
behaviour, the tool reads it from the graph, the release manifest or the
versions on the node, never from a copy of its own code. These tests run it
against what v2.2.4 and v2.3.0 have: kube-vip "latest" in the release
manifest, k4all-operator v0.1.5 without the pause gate, ingress-nginx, no
Traefik image, no ClusterUpgrade.
"""

import copy
import os

import yaml

from conftest import LADDER, REPO, ku, run_cli, write_graph
from test_kube_vip import PH3_V22, cluster_config

DATA = os.path.join(os.path.dirname(__file__), "data")
PH3 = os.path.join(REPO, "bootc", "overlay", "usr", "local", "bin", "overrides",
                   "bootstrap-control", "setup-k8s-ph3.sh")

RELEASE, NODE_TYPE = ku.ANNOTATION_RELEASE, ku.ANNOTATION_NODE_TYPE
TARGET, PHASE = ku.ANNOTATION_TARGET, ku.ANNOTATION_PHASE


def v22_manifest():
    """k4all-release.yaml of v2.2.4 and v2.3.0."""
    with open(os.path.join(DATA, "k4all-release-v2.2.yaml"), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def v24_manifest():
    """What v2.4.0 changes in it, for the tool: the operator, kube-vip
    handed to the host, Traefik in place of ingress-nginx."""
    doc = v22_manifest()
    comps = doc["spec"]["components"]
    comps["k4all-operator"]["version"] = "v0.5.0"
    comps["kube-vip"].update({"version": "v1.3.1", "management": "Unmanaged"})
    comps["kube-vip"].pop("versionUrl", None)
    comps["ingress-nginx"]["management"] = "Removed"
    comps["traefik"] = {"type": "helm", "version": "42.4.0",
                        "repo": "https://traefik.github.io/charts",
                        "chart": "traefik", "namespace": "traefik",
                        "dependsOn": ["metallb"]}
    return doc


def finish(host, limit=10):
    for _ in range(limit):
        st = ku.load_state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


def ha_bootstrap(make_host, version, kubernetes, manifest):
    """An HA (kube-vip) single-node bootstrap whose image and
    /etc/k4all-release.yaml are ``manifest``, with the kube-vip.yaml that
    setup-k8s-ph3.sh of v2.2.x wrote."""
    host = make_host(version=version, kubernetes=kubernetes)
    write_graph(host, LADDER[:3])
    text = yaml.safe_dump(manifest)
    host.write(ku.IMAGE_RELEASE_MANIFEST, text)
    host.write(ku.K4ALL_RELEASE_FILE, text)
    host.k4all_config = cluster_config()
    host.write(ku.K4ALL_CONFIG_FILE, yaml.safe_dump(cluster_config()))
    host.write(ku.SUPER_ADMIN_KUBECONFIG, "fake\n")
    host.write(ku.KUBE_VIP_MANIFEST, PH3_V22)
    cluster = copy.deepcopy(manifest)
    # what the bridge leaves on the bootstrap node
    cluster["spec"]["components"]["kube-vip"]["management"] = "Unmanaged"
    cluster["metadata"]["resourceVersion"] = "7"
    host.release_manifest = cluster
    return host


# --- v2.2.4 -> v2.3.0 ------------------------------------------------------------
def test_the_hop_to_v230_runs_with_the_manifest_of_v22(make_host):
    host = ha_bootstrap(make_host, "v2.2.4", "1.35.6", v22_manifest())
    assert run_cli(host, "run", "--to", "v2.3.0", "--yes") == 0
    st = finish(host)
    assert st["phase"] == "DONE" and st["current"] == "v2.3.0"
    # kube-vip is "latest": the generator says so and leaves the file
    assert host.read(ku.KUBE_VIP_MANIFEST) == PH3_V22
    assert any("no valid kube-vip version" in m for m in host.logs)
    # operator v0.1.5 has no pause gate: scaled to zero while kubeadm
    # moves the control plane (1.35.6 -> 1.35.10), then back
    assert host.operator_scale_history == [0, 1]
    # no manifest sync on this hop, so nothing applied and no image loaded
    assert not host.applied_manifests and not host.rm_patches
    assert not [c for c in host.calls if c[:2] == ["podman", "load"]]
    assert [c for c in host.calls if c[1:3] == ["upgrade", "apply"]]


def test_the_v22_manifest_gives_the_generator_no_version(make_host):
    host = ha_bootstrap(make_host, "v2.2.4", "1.35.6", v22_manifest())
    upgrader = ku.Upgrader(host, ku.load_config(host))
    assert upgrader._kube_vip_version()[0] == ""
    assert run_cli(host, "kube-vip-manifest", "--write") == 2
    assert host.read(ku.KUBE_VIP_MANIFEST) == PH3_V22


def test_a_new_v22_bootstrap_gets_the_version_setup_k8s_ph3_found(make_host):
    host = ha_bootstrap(make_host, "v2.2.4", "1.35.6", v22_manifest())
    os.remove(host.path(ku.KUBE_VIP_MANIFEST))
    os.remove(host.path(ku.SUPER_ADMIN_KUBECONFIG))
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    host.k4all_config = None           # before kubeadm init: no API
    assert run_cli(host, "kube-vip-manifest", "--write", "--before-init",
                   "--version", "latest") == 2
    assert not host.exists(ku.KUBE_VIP_MANIFEST)
    assert run_cli(host, "kube-vip-manifest", "--write", "--before-init",
                   "--version", "v1.3.2") == 0
    pod = yaml.safe_load(host.read(ku.KUBE_VIP_MANIFEST))
    assert pod == ku.kube_vip_pod("192.168.6.200", "ens18", "v1.3.2",
                                  ku.SUPER_ADMIN_KUBECONFIG)


def test_setup_k8s_ph3_looks_kube_vip_up_only_for_a_floating_manifest():
    with open(PH3, encoding="utf-8") as fh:
        text = fh.read()
    assert "v[0-9]*) ;;" in text
    assert "https://api.github.com/repos/kube-vip/kube-vip/releases" in text
    assert 'kube-vip-manifest --write --before-init "${kv_args[@]}"' in text


def test_the_agent_on_v224_only_publishes_release_and_node_type(make_host):
    # No operator before v2.4.0 writes upgrade-target: the agent's passes
    # publish what the node runs, for the order checks of the hops.
    host = ha_bootstrap(make_host, "v2.2.4", "1.35.6", v22_manifest())
    assert run_cli(host, "agent") == 0
    assert host.annotations == {RELEASE: "v2.2.4", NODE_TYPE: "bootstrap"}
    assert ku.load_state(host) is None
    assert not [c for c in host.calls if c[:2] == ["bootc", "switch"]]
    assert host.operator_scale_history == []


# --- v2.3.0 -> v2.4.0: the first manifest sync -------------------------------------
def test_the_first_sync_from_v230_with_operator_v015(make_host):
    host = ha_bootstrap(make_host, "v2.3.0", "1.35.10", v22_manifest())
    new = v24_manifest()
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(new))
    assert not host.exists(ku.IMAGE_CACHE_DIR), "v2.3.0 ships no Traefik image"
    assert run_cli(host, "run", "--to", "v2.4.0", "--yes") == 0
    # the new image's /etc/k4all-release.yaml: k4all-migrate-config.sh merges
    # the image's manifest in at boot
    host.write(ku.K4ALL_RELEASE_FILE, yaml.safe_dump(new))
    st = finish(host)
    assert st["phase"] == "DONE" and st["current"] == "v2.4.0", st.get("hold")
    comps = host.release_manifest["spec"]["components"]
    assert comps["k4all-operator"]["version"] == "v0.5.0"
    assert comps["ingress-nginx"]["management"] == "Removed"
    assert comps["traefik"]["version"] == "42.4.0"
    assert comps["kube-vip"]["management"] == "Unmanaged"
    # no kube-vip pause and no scale-down: Kubernetes does not change
    assert host.operator_scale_history == []
    # the generator now has a version and updates the host's kube-vip.yaml
    pod = yaml.safe_load(host.read(ku.KUBE_VIP_MANIFEST))
    assert pod["spec"]["containers"][0]["image"] == "ghcr.io/kube-vip/kube-vip:v1.3.1"
    assert not [c for c in host.calls if c[:2] == ["podman", "load"]], \
        "nothing shipped, nothing loaded, and the sync goes on"
