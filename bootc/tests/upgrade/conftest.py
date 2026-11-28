"""Shared fixtures for the k4all-upgrade tests.

`FakeHost` replaces every command k4all-upgrade runs with a small model of a
bootc node and its cluster, so the phase driver can be exercised end to end:
staging, kubeadm, reboots, rollbacks and the ReleaseManifest sync.
"""

import datetime
import hashlib
import importlib.machinery
import importlib.util
import json
import os

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TOOL = os.path.join(REPO, "bootc", "overlay", "usr", "local", "bin", "k4all-upgrade")


def _load_tool():
    loader = importlib.machinery.SourceFileLoader("k4all_upgrade", TOOL)
    spec = importlib.util.spec_from_loader("k4all_upgrade", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


ku = _load_tool()


@pytest.fixture
def tool():
    return ku


def release(version, kind, min_from, kubernetes, crio, fedora, **extra):
    data = {"version": version, "kind": kind, "minFrom": min_from,
            "kubernetes": kubernetes, "crio": crio, "fedora": fedora}
    data.update(extra)
    return data


# The release ladder agreed for the 2.x migration (docs/upgrades.md).
LADDER = [
    release("v2.2.4", "patch", "v2.0.0-beta1", "1.35.6", "1.32", 43),
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
            syncManifest=True),
    release("v2.5.0", "minor", "v2.4.0", "1.35.10", "1.35", 45),
    release("v2.6.0", "minor", "v2.5.0", "1.36.6", "1.36", 45),
    release("v2.6.1", "patch", "v2.6.0", "1.36.6", "1.36", 45,
            syncManifest=True),
    release("v2.7.0", "minor", "v2.6.0", "1.36.6", "1.36", 45),
    release("v2.8.0", "minor", "v2.7.0", "1.36.6", "1.36", 45,
            syncManifest=True),
    release("v2.9.0", "minor", "v2.8.0", "1.37.2", "1.37", 45),
]


@pytest.fixture
def ladder():
    return ku.load_graph(json.loads(json.dumps(LADDER)))


# What kubectl prints for /readyz right after an apiserver restart, while the
# aggregated APIs (metrics-server, calico-apiserver) come up (seen in the lab).
READYZ_NOT_READY = (
    'Error from server (InternalError): an error on the server ("[+]ping ok\\n'
    '[+]log ok\\n[+]etcd ok\\n[+]poststarthook/start-apiextensions-informers ok\\n'
    '[-]poststarthook/apiservice-discovery-controller failed: reason withheld\\n'
    'readyz check failed") has prevented the request from succeeding')


def index_digest(version):
    """Digest of the multi-arch index that a release tag points to: the one
    the upgrade graph lists."""
    return "sha256:" + hashlib.sha256(("index " + version).encode()).hexdigest()


def manifest_digest(version, arch="amd64"):
    """Digest of one architecture's manifest inside that index. bootc 1.17
    reports this one as imageDigest, for a tag and for an index digest alike
    (VM 953, bootc status of a deployment staged by index digest)."""
    return "sha256:" + hashlib.sha256(("%s %s" % (arch, version)).encode()).hexdigest()


def sandbox(pod_id, namespace, name, grace=30, containers=("main",),
            network="POD"):
    """A ready pod sandbox of CRI-O, as FakeHost.sandboxes holds it.
    network: NODE for a host-network pod, POD for one on the pod network,
    None when `crictl inspectp` does not say."""
    return {"id": pod_id, "namespace": namespace, "name": name, "grace": grace,
            "containers": list(containers), "network": network}


class Proc:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


class FakeHost(ku.Host):
    """A bootc node with an in-memory cluster."""

    def __init__(self, root, version="v2.2.4", kubernetes="1.35.6",
                 role="bootstrap", nodes=1):
        super().__init__(str(root))
        self.clock = datetime.datetime(2026, 11, 21, 2, 45)  # a Saturday
        self.calls = []
        self.logs = []
        self.booted = {"version": version, "kubernetes": kubernetes}
        # {"version", "kubernetes", "image" (the ref), "digest" (imageDigest)}
        self.staged = None
        self.rollback_target = None
        self.apiserver = kubernetes
        self.cluster_version = kubernetes
        self.node_count = nodes
        self.node_is_ready = True
        self.healthy_after_boot = True
        self.annotations = {}
        self.node_rv = 1            # resourceVersion of this Node
        self.patches = []           # annotation changes, in order
        self.kubelet_name = None    # Node name when it is not the hostname
        self.apiserver_up = True
        self.forbid_patch = False   # NodeRestriction refusing the patch
        self.readyz_failures = 0    # /readyz answers that fail before "ok"
        self.readyz_calls = 0
        self.nodes_not_ready = 0    # `get nodes` answers with this node NotReady
        self.unschedulable = False  # this Node is cordoned
        self.labels = {}            # labels of this Node
        self.pdbs = []              # PodDisruptionBudgets; None: the list fails
        self.pods = []              # pods of the cluster, with spec.nodeName; None: the list fails
        self.extra_nodes = []       # more Node objects for `get nodes`
        self.kubelet_running = True
        self.k4all_config = None    # the ClusterConfig CR, None: none listed
        # admin.conf goes through the API VIP: with this set, the API answers
        # only once kube-vip.yaml has its settings
        self.vip_needs_kube_vip = False
        self.default_route_dev = "ens18"
        self.pods_stopped = 0       # times every pod was stopped with crictl
        # CRI-O's ready pod sandboxes; "grace" is the terminationGracePeriod
        # kubelet put on their running containers (None: no running one)
        self.sandboxes = [sandbox("p-etcd", "kube-system", "etcd-k4all-node-1",
                                  network="NODE"),
                          sandbox("p-dns", "kube-system", "coredns-5d78c9869d-x2k4q")]
        self.crictl_fails = set()   # "pods", "ps", "inspectp": that call fails
        # stdin of each stop, in order (one per phase): "<seconds> <pod id>" lines
        self.pod_stops = []
        self.pod_stop_took = {}     # pod id -> seconds its stop takes (default 1)
        self.pod_stop_rc = {}       # pod id -> rc of its stop (default 0)
        self.pod_stop_tries = {}    # pod id -> crictl stopp tries (default 1)
        self.sleeps = []            # seconds of every Host.sleep, in order
        # `bootc status` waits for bootc's lock while another bootc command
        # downloads: with this set, every call runs out of its time (rc 124)
        self.bootc_busy = False
        self.bootc_status_timeouts = []     # the timeout of every `bootc status`
        # `findmnt -n -o MAJ:MIN --target <mount>`: mount -> "253:3"; a
        # mount not in it fails, as with no findmnt
        self.mounts = {}
        self.lvs = None             # what `lvs --reportformat json` prints; None: it fails
        # what `ld-linux-x86-64.so.2 --help` prints; None: it cannot run
        self.ld_so_help = None
        self.cluster_config = {
            "apiVersion": "kubeadm.k8s.io/v1beta4",
            "kind": "ClusterConfiguration",
            "kubernetesVersion": "v" + kubernetes,
            "controllerManager": {"extraArgs": [
                {"name": "flex-volume-plugin-dir",
                 "value": "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"}]},
        }
        self.release_manifest = None
        self.applied_manifests = []  # server-side applies, in order
        self.rm_patches = []        # kubectl patch of the ReleaseManifest
        # Server-side apply field ownership of the ReleaseManifest, per
        # component key: {manager: {component: {key, ...}}}. None until the
        # first write: the CR was created by a client-side `kubectl apply`.
        self.rm_owners = None
        self.components_after_sync = "Installed"
        # component -> {"state", "message"}: what the operator reports for
        # it after a write, instead of components_after_sync
        self.component_status = {}
        # component -> reason: k4all-operator (v0.5.7 on) refuses its
        # uninstall and keeps it Installed at an older version
        self.refused = {}
        self.images = {}            # version -> {"kubernetes": ...}
        self.reboots = 0
        self.operator_replicas = 1
        self.operator_scale_history = []
        self.operator_adopts = True
        self.operator_running = "v0.1.5"   # tag of the operator's Deployment
        self.write("/etc/node-type", role + "\n")
        self.write(ku.VERSION_FILE, version + "\n")
        self.write("/etc/kubernetes/admin.conf" if role != "worker"
                   else "/etc/kubernetes/kubelet.conf", "fake\n")
        self.write("/var/lib/kubelet/config.yaml", "kind: KubeletConfiguration\n")
        if role != "worker":
            self.write("/etc/kubernetes/manifests/etcd.yaml", "fake\n")
        self.write(ku.CONFIG_DEFAULT_FILE, "mode: auto\n")

    # --- environment ---------------------------------------------------
    def now(self):
        return self.clock

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.clock += datetime.timedelta(seconds=seconds)

    def hostname(self):
        return "k4all-node-1"

    def arch(self):
        return "amd64"

    def free_gib(self, p):
        return 50.0

    def log(self, message):
        self.logs.append(message)

    def fetch(self, url, timeout=20):
        raise OSError("offline")

    # --- the node simulated -------------------------------------------
    def image_for(self, ref):
        if "@" in ref:
            digest = ref.split("@", 1)[1]
            version = next((v for v in self.images if index_digest(v) == digest),
                           None)
        else:
            version = ref.rsplit(":", 1)[-1]
        meta = self.images.get(version)
        if meta is None:
            raise AssertionError("unknown image %s" % ref)
        return version, meta

    def reboot_now(self):
        """What happens when bootc applies the staged deployment."""
        self.reboots += 1
        self.kubelet_running = True
        if self.staged:
            self.rollback_target = dict(self.booted)
            self.booted = dict(self.staged)
            self.staged = None
            self.write(ku.VERSION_FILE, self.booted["version"] + "\n")
            self.node_is_ready = self.healthy_after_boot

    def _status(self):
        def entry(info):
            if not info:
                return None
            image = info.get("image", "ghcr.io/gpillon/k4all-bootc:%s" % info["version"])
            digest = info.get("digest", manifest_digest(info["version"]))
            return {"image": {"image": {"image": image, "transport": "registry"},
                              "imageDigest": digest},
                    "ostree": {"checksum": "c-" + info["version"],
                               "deploySerial": 0, "stateroot": "default"}}
        return {"status": {"booted": entry(self.booted),
                           "staged": entry(self.staged),
                           "rollback": entry(self.rollback_target)}}

    # --- commands --------------------------------------------------------
    def run_bytes(self, argv, timeout=None):
        self.calls.append(list(argv))
        if argv[0] == "ostree" and argv[2] == "cat" and self.staged:
            return ("#!kubeadm v%s\n" % self.staged["kubernetes"]).encode()
        return b""

    def run(self, argv, check=True, input_text=None, timeout=None):
        argv = list(argv)
        self.calls.append(argv)
        if argv[:2] == ["bootc", "status"]:
            self.bootc_status_timeouts.append(timeout)
            if self.bootc_busy:
                proc = Proc(returncode=124, stderr="timed out after %s s" % timeout)
                if check:
                    raise ku.UpgradeError("bootc status failed: %s" % proc.stderr)
                return proc
        proc = self._dispatch(argv, input_text)
        if check and proc.returncode != 0:
            raise ku.UpgradeError("%s failed: %s" % (" ".join(argv), proc.stderr))
        return proc

    def _dispatch(self, argv, input_text):
        cmd = argv[0]
        if cmd == "bootc":
            return self._bootc(argv[1:])
        if cmd == "kubelet":
            return Proc("Kubernetes v%s\n" % self.booted["kubernetes"])
        if cmd == "systemctl":
            if argv[1] == "is-active":
                return Proc("active\n" if self.node_is_ready else "failed\n")
            if argv[1] == "reboot":
                self.reboot_now()
                return Proc()
            if argv[1:3] in (["stop", "kubelet"], ["start", "kubelet"]):
                self.kubelet_running = argv[1] == "start"
                return Proc()
        if argv[:5] == ["ip", "-o", "route", "show", "default"]:
            return Proc("default via 192.168.6.1 dev %s proto dhcp metric 100\n"
                        % self.default_route_dev)
        if cmd == "sh" and "crictl" in argv[-1]:
            self.pods_stopped += 1
            self.pod_stops.append(input_text)
            lines = [line.split() for line in (input_text or "").splitlines()]
            return Proc("".join("%s %d %d %d\n" % (pod, self.pod_stop_rc.get(pod, 0),
                                                    self.pod_stop_took.get(pod, 1),
                                                    self.pod_stop_tries.get(pod, 1))
                                for _, pod in lines))
        if cmd == "crictl":
            return self._crictl(argv[3:])
        if cmd == "kubectl":
            return self._kubectl(argv[3:], input_text, kubeconfig=argv[2])
        if cmd.endswith("/k4all-backup.sh"):
            return Proc("backup ok\n")
        if os.path.basename(cmd).startswith("kubeadm"):
            return self._kubeadm(cmd, argv[1:])
        if cmd == "podman":
            return Proc()
        if cmd == "findmnt":
            if argv[-1] not in self.mounts:
                return Proc(returncode=1)
            return Proc(" %s\n" % self.mounts[argv[-1]])
        if cmd == "lvs":
            if self.lvs is None:
                return Proc(returncode=5, stderr="  Volume group not found")
            return Proc(self.lvs)
        if cmd == ku.LD_SO_X86_64 and argv[1:] == ["--help"]:
            if self.ld_so_help is None:
                return Proc(returncode=127, stderr="No such file or directory")
            return Proc(self.ld_so_help)
        if cmd == "yq":
            raise AssertionError("tests have PyYAML; yq must not be needed")
        return Proc(returncode=127, stderr="unexpected command %s" % argv)

    def _crictl(self, args):
        """crictl --runtime-endpoint ... pods -o json --state ready, ps -o json"""
        what = args[0]
        if what in self.crictl_fails:
            return Proc(returncode=1, stderr="crictl: rpc error: code = Unavailable")
        if args == ["pods", "-o", "json", "--state", "ready"]:
            return Proc(json.dumps({"items": [
                {"id": p["id"], "state": "SANDBOX_READY",
                 "metadata": {"name": p["name"], "namespace": p["namespace"],
                              "uid": "u-" + p["id"], "attempt": 0}}
                for p in self.sandboxes]}))
        if args == ["ps", "-o", "json"]:
            containers = []
            for p in self.sandboxes:
                if p["grace"] is None:
                    continue
                for name in p["containers"]:
                    containers.append({
                        "id": "c-%s-%s" % (p["id"], name), "podSandboxId": p["id"],
                        "metadata": {"name": name, "attempt": 0},
                        "state": "CONTAINER_RUNNING",
                        "labels": {"io.kubernetes.pod.name": p["name"],
                                   "io.kubernetes.pod.namespace": p["namespace"]},
                        "annotations": {"io.kubernetes.container.restartCount": "0",
                                        ku.GRACE_ANNOTATION: str(p["grace"])}})
            return Proc(json.dumps({"containers": containers}))
        if args[:3] == ["inspectp", "-o", "json"]:
            # crictl prints a list for several pods, the object for one
            found = []
            for p in self.sandboxes:
                if p["id"] not in args[3:]:
                    continue
                linux = {} if p["network"] is None else {
                    "namespaces": {"options": {"network": p["network"]}}}
                found.append({"status": {"id": p["id"], "linux": linux},
                              "info": {}})
            return Proc(json.dumps(found[0] if len(found) == 1 else found))
        return Proc(returncode=1, stderr="crictl %s" % args)

    def _bootc(self, args):
        if args[:2] == ["status", "--json"]:
            return Proc(json.dumps(self._status()))
        if args[:2] == ["switch", "--download-only"]:
            version, meta = self.image_for(args[2])
            # bootc keeps the ref as given; imageDigest is the manifest it
            # pulled for this architecture, never the index of the ref
            self.staged = {"version": version, "kubernetes": meta["kubernetes"],
                           "image": args[2], "digest": manifest_digest(version)}
            return Proc()
        if args[:3] == ["upgrade", "--from-downloaded", "--apply"]:
            self.reboot_now()
            return Proc()
        if args[:1] == ["rollback"]:
            self.staged = dict(self.rollback_target)
            return Proc()
        return Proc(returncode=1, stderr="bootc %s" % args)

    def _kubeadm(self, cmd, args):
        if args[:3] == ["version", "-o", "short"]:
            if cmd == "kubeadm":
                return Proc("v%s\n" % self.booted["kubernetes"])
            with open(cmd, encoding="utf-8") as fh:
                return Proc(fh.read().split()[-1] + "\n")
        if args[:2] == ["upgrade", "apply"]:
            target = args[2].lstrip("v")
            self.apiserver = target
            self.cluster_version = target
            self.cluster_config["kubernetesVersion"] = "v" + target
            return Proc()
        if args[:2] == ["upgrade", "node"]:
            return Proc()
        if args[:2] == ["config", "migrate"]:
            new = args[args.index("--new-config") + 1]
            with open(new, "w", encoding="utf-8") as fh:
                fh.write("apiVersion: kubeadm.k8s.io/v1beta4\n")
            return Proc()
        if args[:2] == ["config", "images"]:
            return Proc()
        return Proc(returncode=1, stderr="kubeadm %s" % args)

    def node_name(self):
        return self.kubelet_name or self.hostname()

    def _node(self):
        return {"metadata": {"name": self.node_name(),
                             "resourceVersion": str(self.node_rv),
                             "labels": dict(self.labels),
                             "annotations": dict(self.annotations)},
                "spec": {"unschedulable": True} if self.unschedulable else {},
                "status": {"conditions": [{"type": "Ready", "status":
                                           "True" if self.node_is_ready else "False"}]}}

    def _vip_down(self):
        if not self.vip_needs_kube_vip:
            return False
        manifest = ku.KUBE_VIP_MANIFEST
        return not self.exists(manifest) or "manager" not in self.read(manifest)

    def _kubectl(self, args, input_text, kubeconfig=""):
        if not self.apiserver_up or self._vip_down():
            return Proc(returncode=1, stderr="The connection to the server "
                        "10.0.0.1:6443 was refused")
        if kubeconfig.endswith("/kubelet.conf") and args[:2] == ["get", "nodes"]:
            # Node authorizer: a kubelet reads only its own Node
            return Proc(returncode=1, stderr='nodes is forbidden: User "system:'
                        'node:%s" cannot list resource "nodes" in API group "" '
                        'at the cluster scope: node \'%s\' cannot read all '
                        'nodes, only its own Node object'
                        % (self.node_name(), self.node_name()))
        if args[:2] in (["get", "node"], ["patch", "node"], ["annotate", "node"],
                        ["label", "node"]) and args[2] != self.node_name():
            return Proc(returncode=1, stderr='nodes "%s" not found' % args[2])
        if args[:2] == ["patch", "node"]:
            if self.forbid_patch:
                return Proc(returncode=1, stderr='nodes "%s" is forbidden: '
                            'node restriction' % args[2])
            meta = json.loads(args[args.index("-p") + 1])["metadata"]
            if meta.get("resourceVersion") not in (None, str(self.node_rv)):
                return Proc(returncode=1, stderr="Operation cannot be "
                            "fulfilled: the object has been modified")
            changes = meta.get("annotations") or {}
            for key, value in changes.items():
                if value is None:
                    self.annotations.pop(key, None)
                else:
                    self.annotations[key] = value
            self.patches.append(dict(changes))
            self.node_rv += 1
            return Proc()
        if args[:1] == ["-n"] and args[1] == "k4all-operator-system":
            rest = args[2:]
            if rest[:2] == ["get", "deployment"]:
                if self.operator_replicas is None:
                    return Proc(returncode=1, stderr="not found")
                return Proc(json.dumps({"spec": {
                    "replicas": self.operator_replicas,
                    "template": {"spec": {"containers": [{
                        "name": "manager",
                        "image": "ghcr.io/gpillon/k4all-operator:%s"
                                 % self.operator_running}]}}}}))
            if rest[:1] == ["scale"]:
                self.operator_replicas = int(rest[-1].split("=")[1])
                self.operator_scale_history.append(self.operator_replicas)
                return Proc()
            if rest[:2] == ["rollout", "status"]:
                return Proc("successfully rolled out\n")
        if args[:2] == ["get", "nodes"]:
            items = [self._node()]
            if self.nodes_not_ready > 0:
                self.nodes_not_ready -= 1
                items[0]["status"]["conditions"][0]["status"] = "False"
            for i in range(1, self.node_count):
                other = self._node()
                other["metadata"]["name"] = "k4all-node-%d" % (i + 1)
                items.append(other)
            items += json.loads(json.dumps(self.extra_nodes))
            return Proc(json.dumps({"items": items}))
        if args[:2] == ["get", "node"]:
            return Proc(json.dumps(self._node()))
        if args[:2] == ["get", "--raw"]:
            self.readyz_calls += 1
            if self.readyz_failures > 0:
                self.readyz_failures -= 1
                return Proc(returncode=1, stderr=READYZ_NOT_READY)
            return Proc("ok" if self.node_is_ready else "")
        if args[:1] == ["version"]:
            return Proc(json.dumps({"serverVersion": {"gitVersion": "v" + self.apiserver}}))
        if args[:1] == ["annotate"]:
            key = args[3]
            if key.endswith("-"):
                self.annotations.pop(key[:-1], None)
            else:
                k, v = key.split("=", 1)
                self.annotations[k] = v
            self.node_rv += 1
            return Proc()
        if "configmap" in args and "kubeadm-config" in args and "get" in args:
            return Proc(json.dumps({
                "apiVersion": "v1", "kind": "ConfigMap",
                "metadata": {"name": "kubeadm-config", "namespace": "kube-system",
                             "resourceVersion": "1"},
                "data": {"ClusterConfiguration": json.dumps(self.cluster_config)}}))
        if args[:1] == ["replace"]:
            cm = json.loads(input_text)
            import yaml
            self.cluster_config = yaml.safe_load(cm["data"]["ClusterConfiguration"])
            return Proc()
        if args[:2] == ["get", "clusterconfigs"]:
            items = [self.k4all_config] if self.k4all_config else []
            return Proc(json.dumps({"items": items}))
        if args[:2] == ["get", "releasemanifest"]:
            if self.release_manifest is None:
                if "--ignore-not-found" in args:
                    return Proc("")
                return Proc(returncode=1, stderr='Error from server (NotFound): '
                            'releasemanifests.k4all.magesgate.com "k4all" not found')
            return Proc(json.dumps(self.release_manifest))
        if args[:1] == ["apply"]:
            doc = json.loads(input_text)
            self.applied_manifests.append(doc)
            manager = [a for a in args if a.startswith("--field-manager=")]
            self._server_side_apply(manager[0].split("=", 1)[1], doc)
            return Proc()
        if args[:2] == ["patch", "releasemanifest"]:
            if self.release_manifest is None:
                return Proc(returncode=1, stderr="not found")
            kind = args[args.index("--type") + 1]
            body = json.loads(args[args.index("-p") + 1])
            self.rm_patches.append((kind, body))
            self._update_manifest(kind, body)
            return Proc()
        if args[:2] == ["label", "node"]:
            for arg in args[3:]:
                if arg.startswith("-"):
                    continue
                if arg.endswith("-"):
                    self.labels.pop(arg[:-1], None)
                else:
                    key, value = arg.split("=", 1)
                    self.labels[key] = value
            self.node_rv += 1
            return Proc()
        if args[:3] == ["get", "poddisruptionbudgets", "-A"]:
            if self.pdbs is None:
                return Proc(returncode=1, stderr="Error from server "
                            "(ServiceUnavailable): the server is currently "
                            "unable to handle the request")
            return Proc(json.dumps({"items": self.pdbs}))
        if args[:3] == ["get", "pods", "-A"]:
            if self.pods is None:
                return Proc(returncode=1, stderr="Error from server "
                            "(ServiceUnavailable): the server is currently "
                            "unable to handle the request")
            items = self.pods
            for i, arg in enumerate(args):
                if arg == "--field-selector":
                    key, value = args[i + 1].split("=", 1)
                    assert key == "spec.nodeName"
                    items = [p for p in items if p["spec"].get("nodeName") == value]
                if arg == "-l":
                    for term in args[i + 1].split(","):
                        key, value = term.split("=", 1)
                        items = [p for p in items if (p["metadata"].get(
                            "labels") or {}).get(key) == value]
            return Proc(json.dumps({"items": items}))
        if args[:1] in (["drain"], ["uncordon"]):
            self.unschedulable = args[0] == "drain"
            return Proc()
        return Proc(returncode=1, stderr="kubectl %s" % args)


# --- the ReleaseManifest, with server-side apply ownership --------------------
CLIENT_SIDE_APPLY = "kubectl-client-side-apply"


def _rm_owners(host):
    comps = host.release_manifest.setdefault("spec", {}).setdefault("components", {})
    if host.rm_owners is None:
        host.rm_owners = {CLIENT_SIDE_APPLY: {n: set(c) for n, c in comps.items()}}
    return comps, host.rm_owners


def _take_ownership(owners, manager, name, key):
    for other, owned in owners.items():
        if other != manager:
            owned.get(name, set()).discard(key)
    owners.setdefault(manager, {}).setdefault(name, set()).add(key)


def _server_side_apply(self, manager, doc):
    """kubectl apply --server-side --force-conflicts, at component-key level:
    fields the manager applied before and leaves out are removed unless
    another manager owns them; kubectl first hands the client-side apply's
    fields to the manager (csaupgrade)."""
    if self.release_manifest is None:
        self.release_manifest = {k: v for k, v in doc.items() if k != "spec"}
        self.release_manifest["spec"] = {"components": {}}
        self.rm_owners = {}
    comps, owners = _rm_owners(self)
    csa = owners.pop(CLIENT_SIDE_APPLY, None)
    if csa:
        mine = owners.setdefault(manager, {})
        for name, keys in csa.items():
            mine.setdefault(name, set()).update(keys)
    new = (doc.get("spec") or {}).get("components") or {}
    others = [o for m, o in owners.items() if m != manager]
    for name, keys in (owners.get(manager) or {}).items():
        for key in keys:
            if key in (new.get(name) or {}) or any(key in o.get(name, ()) for o in others):
                continue
            comps.get(name, {}).pop(key, None)
        if name in comps and name not in new and not any(o.get(name) for o in others):
            del comps[name]
    owners[manager] = {}
    for name, spec in new.items():
        cur = comps.setdefault(name, {})
        for key, value in spec.items():
            if cur.get(key) != value:
                _take_ownership(owners, manager, name, key)
            cur[key] = json.loads(json.dumps(value))
        owners[manager][name] = set(spec)
    self._refresh_status()


def _update_manifest(self, kind, body):
    """kubectl patch (an update, manager kubectl-patch): JSON patch "add" of
    one component, or a merge patch of spec.components."""
    comps, owners = _rm_owners(self)
    if kind == "json":
        for op in body:
            assert op["op"] == "add" and op["path"].startswith("/spec/components/")
            name = op["path"].rsplit("/", 1)[1]
            for key in set(comps.get(name, {})) - set(op["value"]):
                for owned in owners.values():
                    owned.get(name, set()).discard(key)
            comps[name] = json.loads(json.dumps(op["value"]))
            for key in comps[name]:
                _take_ownership(owners, "kubectl-patch", name, key)
    else:
        for name, change in body["spec"]["components"].items():
            for key, value in change.items():
                comps.setdefault(name, {})[key] = value
                _take_ownership(owners, "kubectl-patch", name, key)
    self._refresh_status()


def _refresh_status(self):
    comps = self.release_manifest["spec"]["components"]
    by_management = {"Removed": "Removed", "Unmanaged": "Unmanaged"}
    self.release_manifest["status"] = {"components": {
        name: {"state": by_management.get(spec.get("management"),
                                          self.components_after_sync),
               "installedVersion": spec.get("version", "")}
        for name, spec in comps.items()}}
    for name, status in self.component_status.items():
        if name in comps:
            self.release_manifest["status"]["components"][name].update(status)
    for name, reason in self.refused.items():
        if name in comps:
            self.release_manifest["status"]["components"][name] = {
                "state": "Installed", "installedVersion": "v0.0.1",
                "message": "uninstall refused: " + reason}
    op = self.release_manifest["status"]["components"].get("k4all-operator")
    if op is not None and op["state"] != "Unmanaged":
        # the operator is installed by step 1 whatever the other components
        # do; an Unmanaged one is never reported Installed
        op["state"] = "Installed"
        self.operator_running = op["installedVersion"] or self.operator_running
        if self.operator_adopts:
            op["appliedHash"] = "h1"


FakeHost._server_side_apply = _server_side_apply
FakeHost._update_manifest = _update_manifest
FakeHost._refresh_status = _refresh_status


@pytest.fixture
def make_host(tmp_path):
    def factory(**kwargs):
        return FakeHost(tmp_path / "root", **kwargs)
    return factory


def run_cli(host, *argv):
    return ku.main(list(argv), host=host)


def write_graph(host, entries):
    host.write(ku.LOCAL_GRAPH_FILE, json.dumps({"releases": entries}))
    for entry in entries:
        host.images[entry["version"]] = {"kubernetes": entry["kubernetes"]}
