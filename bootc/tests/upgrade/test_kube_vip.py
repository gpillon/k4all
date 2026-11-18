"""kube-vip on the control planes of an HA cluster: the host's static pod.

After the reboot of each hop, k4all-upgrade writes or updates
/etc/kubernetes/manifests/kube-vip.yaml from the ClusterConfig: the API VIP
and the LoadBalancer Services of class kube-vip.io/kube-vip-class.
"""

import os

import pytest
import yaml

from conftest import REPO, ku, release, run_cli, write_graph

BIN = os.path.join(REPO, "bootc", "overlay", "usr", "local", "bin")
PH3 = os.path.join(BIN, "overrides", "bootstrap-control", "setup-k8s-ph3.sh")

GRAPH = [
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43),
]

RELEASE_MANIFEST = {"spec": {"components": {
    "kube-vip": {"type": "static-pod", "management": "Unmanaged",
                 "version": "v1.3.1"}}}}


def cluster_config(ha_type="kubevip", interface="auto", vip="192.168.6.200"):
    return {"metadata": {"name": "k4all-cluster-config"},
            "spec": {"cluster": {"ha": {"type": ha_type, "interface": interface,
                                        "apiControlEndpoint": vip,
                                        "apiControlEndpointSubnetSize": "24"}}}}


# What setup-k8s-ph3.sh of v2.2.x wrote on the bootstrap node.
PH3_V22 = """apiVersion: v1
kind: Pod
metadata:
  creationTimestamp: null
  name: kube-vip
  namespace: kube-system
spec:
  containers:
  - args:
    - manager
    env:
    - name: vip_arp
      value: "true"
    - name: port
      value: "6443"
    - name: vip_nodename
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: vip_interface
      value: "ens18"
    - name: vip_subnet
      value: "32"
    - name: dns_mode
      value: first
    - name: cp_enable
      value: "true"
    - name: cp_namespace
      value: kube-system
    - name: svc_enable
      value: "true"
    - name: svc_leasename
      value: plndr-svcs-lock
    - name: vip_leaderelection
      value: "true"
    - name: vip_leasename
      value: plndr-cp-lock
    - name: vip_leaseduration
      value: "15"
    - name: vip_renewdeadline
      value: "10"
    - name: vip_retryperiod
      value: "2"
    - name: address
      value: "192.168.6.200"
    - name: prometheus_server
      value: :2112
    - name: bgp_routerid
      value: "10.0.0.9"
    image: ghcr.io/kube-vip/kube-vip:v1.0.2
    imagePullPolicy: IfNotPresent
    name: kube-vip
    resources: {}
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
        drop:
        - ALL
    volumeMounts:
    - mountPath: /etc/kubernetes/admin.conf
      name: kubeconfig
  hostAliases:
  - hostnames:
    - kubernetes
    ip: 127.0.0.1
  hostNetwork: true
  volumes:
  - hostPath:
      path: /etc/kubernetes/super-admin.conf # else the leader election will not work.
    name: kubeconfig
status: {}
"""

# What k4all-operator v0.1.4 to v0.4.x write: the image alone.
OPERATOR_POD = """apiVersion: v1
kind: Pod
metadata:
  name: kube-vip
  namespace: kube-system
spec:
  containers:
  - name: kube-vip
    image: ghcr.io/kube-vip/kube-vip:v1.0.2
  hostNetwork: true
"""


@pytest.fixture
def control_plane(make_host):
    def factory(role="bootstrap", manifest=None, config=None, super_admin=True):
        host = make_host(version="v2.3.0", kubernetes="1.35.10", role=role)
        write_graph(host, GRAPH)
        host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump(RELEASE_MANIFEST))
        host.k4all_config = config if config is not None else cluster_config()
        if super_admin and role == "bootstrap":
            host.write(ku.SUPER_ADMIN_KUBECONFIG, "fake\n")
        if manifest is not None:
            host.write(ku.KUBE_VIP_MANIFEST, manifest)
        return host
    return factory


def upgrader(host):
    return ku.Upgrader(host, ku.load_config(host))


def written(host):
    return yaml.safe_load(host.read(ku.KUBE_VIP_MANIFEST))


def env(pod):
    ctr = pod["spec"]["containers"][0]
    return {e["name"]: e.get("value") for e in ctr["env"]}


def kubeconfig_path(pod):
    return [v["hostPath"]["path"] for v in pod["spec"]["volumes"]
            if v["name"] == "kubeconfig"][0]


def test_the_hop_writes_kube_vip_on_a_control_plane_that_has_none(control_plane):
    # Nodes that joined as control planes never got kube-vip.
    host = control_plane(role="control")
    host.node_count = 2
    assert run_cli(host, "run", "--to", "v2.4.0", "--yes") == 0
    run_cli(host, "resume")
    pod = written(host)
    assert pod["spec"]["containers"][0]["image"] == \
        "ghcr.io/kube-vip/kube-vip:v1.3.1"
    assert pod["spec"]["containers"][0]["args"] == ["manager"]
    got = env(pod)
    assert (got["cp_enable"], got["svc_enable"], got["lb_class_only"]) == \
        ("true", "true", "true")
    assert got["address"] == "192.168.6.200"
    assert got["vip_interface"] == "ens18"
    assert kubeconfig_path(pod) == "/etc/kubernetes/admin.conf", \
        "kubeadm join writes no super-admin.conf"
    assert ku.load_state(host)["current"] == "v2.4.0"


def test_the_bootstrap_node_mounts_super_admin_conf(control_plane):
    host = control_plane()
    upgrader(host).reconcile_kube_vip()
    assert kubeconfig_path(written(host)) == "/etc/kubernetes/super-admin.conf"
    os.remove(host.path(ku.SUPER_ADMIN_KUBECONFIG))
    upgrader(host).reconcile_kube_vip()
    assert kubeconfig_path(written(host)) == "/etc/kubernetes/admin.conf"


def test_an_existing_k4all_manifest_is_updated_and_keeps_its_settings(control_plane):
    host = control_plane(manifest=PH3_V22)
    host.default_route_dev = "ovs-bridge"     # the address moved to the bridge
    upgrader(host).reconcile_kube_vip()
    pod = written(host)
    ctr = pod["spec"]["containers"][0]
    names = [e["name"] for e in ctr["env"]]
    assert names.index("lb_class_only") == names.index("svc_enable") + 1
    got = env(pod)
    assert got["lb_class_only"] == "true"
    assert got["vip_interface"] == "ovs-bridge", "auto follows the default route"
    assert got["bgp_routerid"] == "10.0.0.9", "settings k4all does not set stay"
    assert ctr["image"] == "ghcr.io/kube-vip/kube-vip:v1.3.1"
    assert kubeconfig_path(pod) == "/etc/kubernetes/super-admin.conf"
    backups = os.listdir(host.path(ku.STATE_DIR + "/backup"))
    assert [b for b in backups if b.startswith("kube-vip.yaml.")]
    assert any("kube-vip: updated" in m for m in host.logs)


def test_the_operators_pod_is_replaced(control_plane):
    host = control_plane(manifest=OPERATOR_POD)
    upgrader(host).reconcile_kube_vip()
    pod = written(host)
    assert pod == ku.kube_vip_pod("192.168.6.200", "ens18", "v1.3.1",
                                  "/etc/kubernetes/super-admin.conf")
    assert any("kube-vip: wrote" in m for m in host.logs)


@pytest.mark.parametrize("ha_type", ["none", "keepalived"])
def test_nothing_changes_without_ha_kube_vip(control_plane, ha_type):
    host = control_plane(config=cluster_config(ha_type=ha_type), manifest=OPERATOR_POD)
    upgrader(host).reconcile_kube_vip()
    assert host.read(ku.KUBE_VIP_MANIFEST) == OPERATOR_POD


def test_nothing_is_written_without_a_cluster_config(control_plane):
    host = control_plane(config={})
    host.k4all_config = None
    upgrader(host).reconcile_kube_vip()
    assert not host.exists(ku.KUBE_VIP_MANIFEST)


def test_nothing_changes_on_a_worker(control_plane):
    host = control_plane(role="worker")
    upgrader(host).reconcile_kube_vip()
    assert not host.exists(ku.KUBE_VIP_MANIFEST)


def test_an_up_to_date_manifest_is_not_written_again(control_plane):
    host = control_plane()
    upgrader(host).reconcile_kube_vip()
    before = os.stat(host.path(ku.KUBE_VIP_MANIFEST)).st_mtime_ns
    host.logs.clear()
    host.sleeps.clear()
    upgrader(host).reconcile_kube_vip()
    assert os.stat(host.path(ku.KUBE_VIP_MANIFEST)).st_mtime_ns == before
    assert not host.logs and not host.sleeps


def test_a_newer_kube_vip_is_not_downgraded(control_plane):
    host = control_plane(manifest=PH3_V22.replace("kube-vip:v1.0.2", "kube-vip:v1.4.0"))
    upgrader(host).reconcile_kube_vip()
    assert written(host)["spec"]["containers"][0]["image"].endswith(":v1.4.0")


@pytest.mark.parametrize("configured,on_node,expected", [
    ("eno1", True, "eno1"),
    ("eno1", False, "ens18"),         # not on this node: the default route
    ("auto", False, "ens18"),
])
def test_the_vip_interface(control_plane, configured, on_node, expected):
    host = control_plane(config=cluster_config(interface=configured))
    if on_node:
        host.write("/sys/class/net/eno1/operstate", "up\n")
    upgrader(host).reconcile_kube_vip()
    assert env(written(host))["vip_interface"] == expected


def test_an_explicit_interface_in_a_k4all_manifest_stays(control_plane):
    host = control_plane(config=cluster_config(interface="ens18"), manifest=PH3_V22)
    host.default_route_dev = "ovs-bridge"
    upgrader(host).reconcile_kube_vip()
    assert env(written(host))["vip_interface"] == "ens18"


def test_without_the_api_the_local_config_is_used(control_plane):
    # Review: a broken VIP made admin.conf useless, so kube-vip was never
    # repaired. /etc/k4all-config.yaml needs no API.
    host = control_plane(manifest=OPERATOR_POD)
    host.write("/etc/k4all-config.yaml", yaml.safe_dump(cluster_config(
        interface="auto", vip="192.168.6.210")))
    host.apiserver_up = False
    upgrader(host).reconcile_kube_vip()
    assert env(written(host))["address"] == "192.168.6.210"


def test_the_cluster_config_wins_when_it_answers(control_plane):
    # A control plane that joined has ha.type none in its own file.
    host = control_plane(role="control")
    host.write("/etc/k4all-config.yaml", yaml.safe_dump(cluster_config(ha_type="none")))
    upgrader(host).reconcile_kube_vip()
    assert env(written(host))["address"] == "192.168.6.200"


def test_without_api_and_config_nothing_is_written(control_plane):
    host = control_plane(manifest=OPERATOR_POD)
    host.apiserver_up = False
    upgrader(host).reconcile_kube_vip()
    assert host.read(ku.KUBE_VIP_MANIFEST) == OPERATOR_POD


def test_the_temporary_file_is_outside_the_manifest_directory(control_plane,
                                                               monkeypatch):
    # Review: kubelet takes every file of /etc/kubernetes/manifests for a
    # static pod; the temporary file goes to /etc/kubernetes, same
    # filesystem, and the write is fsynced.
    host = control_plane()
    renames, syncs = [], []
    real_replace, real_fsync = os.replace, os.fsync
    monkeypatch.setattr(ku.os, "replace",
                        lambda a, b: (renames.append((a, b)), real_replace(a, b))[1])
    monkeypatch.setattr(ku.os, "fsync",
                        lambda fd: (syncs.append(fd), real_fsync(fd))[1])
    upgrader(host).reconcile_kube_vip()
    (src, dst), = [r for r in renames if r[1].endswith("kube-vip.yaml")]
    assert os.path.dirname(src) == host.path("/etc/kubernetes")
    assert os.path.basename(src).startswith(".")
    assert dst == host.path(ku.KUBE_VIP_MANIFEST)
    assert len(syncs) >= 2, "the file and its directory"


def test_an_unreadable_manifest_is_kept_and_reported(control_plane):
    # Review: a kube-vip.yaml that could not be parsed was overwritten
    # without a backup.
    host = control_plane(manifest="spec: [unclosed\n")
    restarted, warning = upgrader(host).reconcile_kube_vip()
    assert not restarted
    assert "cannot be read, so it is left as it is" in warning
    assert host.read(ku.KUBE_VIP_MANIFEST) == "spec: [unclosed\n"
    assert run_cli(host, "kube-vip-manifest", "--write") == 2


def test_an_unreadable_manifest_shows_in_the_hop(control_plane):
    host = control_plane(manifest="spec: [unclosed\n")
    assert run_cli(host, "run", "--to", "v2.4.0", "--yes") == 0
    host.logs.clear()
    run_cli(host, "resume")
    st = ku.load_state(host)
    assert st["current"] == "v2.4.0", "never a HOLD"
    assert "cannot be read" in st["history"][-1]["warning"]
    assert any(m.startswith("WARNING: ") and "cannot be read" in m
               for m in host.logs)
    assert any("cannot be read" in (p.get(ku.ANNOTATION_MESSAGE) or "")
               for p in host.patches), "upgrade-message during the hop"
    assert host.read(ku.KUBE_VIP_MANIFEST) == "spec: [unclosed\n"


def test_kube_vip_is_repaired_before_the_health_checks(control_plane):
    # Review: post_boot repaired kube-vip after _node_healthy, which goes
    # through admin.conf, that is through the VIP: with the VIP broken it
    # never got there.
    host = control_plane(manifest=OPERATOR_POD)
    host.write("/etc/k4all-config.yaml", yaml.safe_dump(cluster_config()))
    assert run_cli(host, "run", "--to", "v2.4.0", "--yes") == 0
    host.vip_needs_kube_vip = True      # the API answers only with kube-vip
    run_cli(host, "resume")
    st = ku.load_state(host)
    assert st["current"] == "v2.4.0" and st["phase"] == "DONE"
    assert host.reboots == 1, "no rollback"
    assert written(host)["spec"]["containers"][0]["args"] == ["manager"]


def test_after_a_rewrite_only_readyz_is_awaited(control_plane):
    # Review: waiting for every node to be Ready after kube-vip restarts is
    # more than the next steps need.
    host = control_plane(manifest=PH3_V22)
    host.nodes_not_ready = 10 ** 6
    up = upgrader(host)
    up._kube_vip_in_hop({}, wait=True)
    assert host.sleeps == []


# --- one generator: the subcommand ---------------------------------------------
def test_kube_vip_manifest_prints_without_writing(control_plane, capsys):
    host = control_plane()
    capsys.readouterr()
    assert run_cli(host, "kube-vip-manifest") == 0
    pod = yaml.safe_load(capsys.readouterr().out)
    assert env(pod)["lb_class_only"] == "true"
    assert not host.exists(ku.KUBE_VIP_MANIFEST)
    assert run_cli(host, "kube-vip-manifest", "--write") == 0
    assert written(host) == pod
    assert run_cli(host, "kube-vip-manifest", "--write") == 0
    assert any("is up to date" in m for m in host.logs)


def test_before_kubeadm_init_the_bootstrap_node_mounts_super_admin_conf(
        control_plane):
    # setup-k8s-ph3.sh runs before kubeadm init: no admin.conf, no
    # super-admin.conf yet, no API.
    host = control_plane(super_admin=False)
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    host.k4all_config = None
    host.write("/etc/k4all-config.yaml", yaml.safe_dump(cluster_config()))
    # Review 2: without saying so, a kubeconfig that does not exist is never
    # chosen
    assert run_cli(host, "kube-vip-manifest", "--write") == 2
    assert not host.exists(ku.KUBE_VIP_MANIFEST)
    assert any("super-admin.conf nor admin.conf" in m for m in host.logs)
    assert run_cli(host, "kube-vip-manifest", "--write", "--before-init") == 0
    assert kubeconfig_path(written(host)) == "/etc/kubernetes/super-admin.conf"


def test_a_control_plane_without_admin_conf_gets_no_kube_vip(control_plane):
    host = control_plane(role="control")
    os.remove(host.path(ku.ADMIN_KUBECONFIG))
    host.write(ku.KUBELET_KUBECONFIG, "fake\n")
    host.write("/etc/k4all-config.yaml", yaml.safe_dump(cluster_config()))
    restarted, warning = upgrader(host).reconcile_kube_vip()
    assert not restarted and "this control plane has no admin.conf" in warning
    assert not host.exists(ku.KUBE_VIP_MANIFEST)


def test_the_bootstrap_node_falls_back_to_admin_conf(control_plane):
    host = control_plane(super_admin=False)
    upgrader(host).reconcile_kube_vip()
    assert kubeconfig_path(written(host)) == "/etc/kubernetes/admin.conf"


# Review 2: the version as setup-k8s-ph3.sh read it.
def test_the_version_comes_from_etc_first(control_plane):
    host = control_plane()
    host.write("/etc/k4all-release.yaml", yaml.safe_dump({"spec": {"components": {
        "kube-vip": {"version": "v1.3.2"}}}}))
    upgrader(host).reconcile_kube_vip()
    assert written(host)["spec"]["containers"][0]["image"].endswith(":v1.3.2")


def test_a_floating_version_in_etc_falls_back_to_the_image(control_plane):
    host = control_plane()
    host.write("/etc/k4all-release.yaml", yaml.safe_dump({"spec": {"components": {
        "kube-vip": {"version": "latest"}}}}))
    upgrader(host).reconcile_kube_vip()
    assert written(host)["spec"]["containers"][0]["image"].endswith(":v1.3.1")


def test_without_a_version_the_manifest_stays(control_plane):
    host = control_plane(manifest=PH3_V22)
    host.write(ku.IMAGE_RELEASE_MANIFEST, yaml.safe_dump({"spec": {"components": {}}}))
    restarted, warning = upgrader(host).reconcile_kube_vip()
    assert not restarted and "no valid kube-vip version" in warning
    assert host.read(ku.KUBE_VIP_MANIFEST) == PH3_V22
    # before kubeadm init it is an error: init would point at a VIP nobody
    # announces
    os.remove(host.path(ku.KUBE_VIP_MANIFEST))
    assert run_cli(host, "kube-vip-manifest", "--write", "--before-init") == 2


def test_kube_vip_yaml_has_a_lock_of_its_own(control_plane):
    import fcntl
    host = control_plane()
    path = host.path(ku.STATE_DIR + "/kube-vip.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(ku.LockBusy):
            upgrader(host).reconcile_kube_vip()
        assert not host.exists(ku.KUBE_VIP_MANIFEST)
    # the hops' lock is another one
    with ku.Lock(host):
        upgrader(host).reconcile_kube_vip()
    assert host.exists(ku.KUBE_VIP_MANIFEST)


def test_every_write_has_its_own_temporary_file(control_plane, monkeypatch):
    host = control_plane()
    sources = []
    real = os.replace
    monkeypatch.setattr(ku.os, "replace",
                        lambda a, b: (sources.append(a), real(a, b))[1])
    for interface in ("ens18", "ovs-bridge"):
        host.default_route_dev = interface
        upgrader(host).reconcile_kube_vip()
    kube_vip = [src for src in sources if "kube-vip.yaml" in src]
    assert len(kube_vip) == 2 and kube_vip[0] != kube_vip[1]


def test_kube_vip_manifest_says_why_it_writes_nothing(control_plane):
    host = control_plane(config=cluster_config(ha_type="none"))
    assert run_cli(host, "kube-vip-manifest", "--write") == 0
    assert any("nothing to write: HA is not kube-vip" in m for m in host.logs)
    assert not host.exists(ku.KUBE_VIP_MANIFEST)


def test_the_shipped_image_is_loaded_first(control_plane):
    host = control_plane()
    host.write(ku.IMAGE_CACHE_DIR + "/ghcr.io_kube-vip_kube-vip_v1.3.1.tar", "")
    upgrader(host).reconcile_kube_vip()
    assert [c for c in host.calls if c[:2] == ["podman", "load"]
            and c[-1].endswith("ghcr.io_kube-vip_kube-vip_v1.3.1.tar")]


# --- new installs and joins use the same generator -------------------------------
def test_ph3_writes_kube_vip_on_the_bootstrap_node_only():
    # Review: kubeadm join --control-plane wants /etc/kubernetes/manifests
    # empty, and admin.conf, which kube-vip mounts there, comes with the join.
    with open(PH3, encoding="utf-8") as fh:
        text = fh.read()
    block = text[text.index("function setup_for_kubevip"):
                 text.index("function setup_for_keepalived")]
    assert '[ "$(cat /etc/node-type)" = "bootstrap" ]' in block
    assert "k4all-upgrade kube-vip-manifest --write --before-init" in block
    assert "kind: Pod" not in block, "no second copy of the manifest"


def test_a_control_plane_writes_kube_vip_after_its_join():
    with open(os.path.join(BIN, "overrides", "control", "join_cluster.sh"),
              encoding="utf-8") as fh:
        text = fh.read()
    join = text.index('sudo bash -c "$JOIN_COMMAND"')
    write = text.index("k4all-upgrade kube-vip-manifest --write")
    assert join < write
    # Review 2: only after a join that worked
    assert 'if sudo bash -c "$JOIN_COMMAND" && [ -f /etc/kubernetes/kubelet.conf ]' \
        in text
    assert text.rindex('if [ "$JOINED" = true ]', 0, write) > join


def test_the_docs_example_is_what_the_generator_prints():
    with open(os.path.join(REPO, "docs", "upgrades.md"), encoding="utf-8") as fh:
        text = fh.read()
    section = text[text.index("### kube-vip on HA clusters"):]
    example = section.split("```yaml\n", 1)[1].split("```", 1)[0]
    assert yaml.safe_load(example) == ku.kube_vip_pod(
        "ADDRESS", "INTERFACE", "VERSION", "/etc/kubernetes/super-admin.conf")


def test_the_image_ships_the_pinned_kube_vip():
    with open(os.path.join(REPO, "bootc", "Containerfile"), encoding="utf-8") as fh:
        text = fh.read()
    assert "yq '.spec.components.kube-vip.version' /usr/local/share/k4all-release.yaml" in text
    assert 'echo "ghcr.io/kube-vip/kube-vip:${KUBE_VIP_VERSION}" >> /tmp/k8s-images.txt' in text
    # only a release tag: up to v2.3.0 the manifest says "latest", which the
    # tool never writes, and the build must not pull a floating image
    assert 'case "$KUBE_VIP_VERSION" in v[0-9]*)' in text
    # the tool loads it under the file name the image build gives it
    assert ku.KUBE_VIP_IMAGE == "ghcr.io/kube-vip/kube-vip"
    assert "tr '/:@' '_'" in text
