"""Shared fixtures for the k4all-upgrade tests.

`FakeHost` replaces every command k4all-upgrade runs with a small model of a
bootc node and its cluster, so the phase driver can be exercised end to end:
staging, kubeadm, reboots, rollbacks and the ReleaseManifest sync.
"""

import datetime
import importlib.machinery
import importlib.util
import json
import os
import subprocess

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
    release("v2.6.0", "minor", "v2.5.0", "1.35.10", "1.35", 45,
            syncManifest=True),
    release("v2.7.0", "minor", "v2.6.0", "1.36.6", "1.36", 45),
    release("v2.8.0", "minor", "v2.7.0", "1.36.6", "1.36", 45,
            syncManifest=True),
    release("v2.9.0", "minor", "v2.8.0", "1.37.2", "1.37", 45),
]


@pytest.fixture
def ladder():
    return ku.load_graph(json.loads(json.dumps(LADDER)))


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
        self.staged = None          # {"version", "kubernetes", "image"}
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
        self.cluster_config = {
            "apiVersion": "kubeadm.k8s.io/v1beta4",
            "kind": "ClusterConfiguration",
            "kubernetesVersion": "v" + kubernetes,
            "controllerManager": {"extraArgs": [
                {"name": "flex-volume-plugin-dir",
                 "value": "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"}]},
        }
        self.release_manifest = None
        self.applied_manifests = []
        self.components_after_sync = "Installed"
        self.images = {}            # version -> {"kubernetes": ...}
        self.reboots = 0
        self.operator_replicas = 1
        self.operator_scale_history = []
        self.operator_adopts = True
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
        version = ref.rsplit(":", 1)[-1] if "@" not in ref else ref.split("@")[1]
        version = version.replace("sha256:", "")
        meta = self.images.get(version)
        if meta is None:
            raise AssertionError("unknown image %s" % ref)
        return version, meta

    def reboot_now(self):
        """What happens when bootc applies the staged deployment."""
        self.reboots += 1
        if self.staged:
            self.rollback_target = dict(self.booted)
            self.booted = {"version": self.staged["version"],
                           "kubernetes": self.staged["kubernetes"]}
            self.staged = None
            self.write(ku.VERSION_FILE, self.booted["version"] + "\n")
            self.node_is_ready = self.healthy_after_boot

    def _status(self):
        def entry(info):
            if not info:
                return None
            image = info.get("image", "ghcr.io/gpillon/k4all-bootc:%s" % info["version"])
            digest = info.get("digest", "sha256:" + info["version"])
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
        if cmd == "kubectl":
            return self._kubectl(argv[3:], input_text)
        if cmd.endswith("/k4all-backup.sh"):
            return Proc("backup ok\n")
        if os.path.basename(cmd).startswith("kubeadm"):
            return self._kubeadm(cmd, argv[1:])
        if cmd == "podman":
            return Proc()
        if cmd == "yq":
            raise AssertionError("tests have PyYAML; yq must not be needed")
        return Proc(returncode=127, stderr="unexpected command %s" % argv)

    def _bootc(self, args):
        if args[:2] == ["status", "--json"]:
            return Proc(json.dumps(self._status()))
        if args[:2] == ["switch", "--download-only"]:
            version, meta = self.image_for(args[2])
            self.staged = {"version": version, "kubernetes": meta["kubernetes"],
                           "image": args[2].split("@")[0] if "@" in args[2]
                           else args[2]}
            if "@" in args[2]:
                self.staged["digest"] = args[2].split("@")[1]
                self.staged["image"] = "ghcr.io/gpillon/k4all-bootc"
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
                             "annotations": dict(self.annotations)},
                "status": {"conditions": [{"type": "Ready", "status":
                                           "True" if self.node_is_ready else "False"}]}}

    def _kubectl(self, args, input_text):
        if not self.apiserver_up:
            return Proc(returncode=1, stderr="The connection to the server "
                        "10.0.0.1:6443 was refused")
        if args[:2] in (["get", "node"], ["patch", "node"], ["annotate", "node"]) \
                and args[2] != self.node_name():
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
                return Proc(json.dumps({"spec": {"replicas": self.operator_replicas}}))
            if rest[:1] == ["scale"]:
                self.operator_replicas = int(rest[-1].split("=")[1])
                self.operator_scale_history.append(self.operator_replicas)
                return Proc()
            if rest[:2] == ["rollout", "status"]:
                return Proc("successfully rolled out\n")
        if args[:2] == ["get", "nodes"]:
            items = [self._node()]
            for i in range(1, self.node_count):
                other = self._node()
                other["metadata"]["name"] = "k4all-node-%d" % (i + 1)
                items.append(other)
            return Proc(json.dumps({"items": items}))
        if args[:2] == ["get", "node"]:
            return Proc(json.dumps(self._node()))
        if args[:2] == ["get", "--raw"]:
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
        if args[:2] == ["get", "releasemanifest"]:
            if self.release_manifest is None:
                return Proc(returncode=1, stderr="not found")
            return Proc(json.dumps(self.release_manifest))
        if args[:1] == ["apply"]:
            doc = json.loads(input_text)
            self.applied_manifests.append(doc)
            comps = doc["spec"]["components"]
            self.release_manifest = dict(doc)
            self.release_manifest["status"] = {"components": {
                name: {"state": self.components_after_sync,
                       "installedVersion": spec.get("version", "")}
                for name, spec in comps.items()}}
            op = self.release_manifest["status"]["components"].get("k4all-operator")
            if op is not None and self.operator_adopts:
                op["appliedHash"] = "h1"
            return Proc()
        if args[:1] in (["drain"], ["uncordon"]):
            return Proc()
        return Proc(returncode=1, stderr="kubectl %s" % args)


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
