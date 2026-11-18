"""k4all-migrate-config.sh and update-routes.sh on a fake root.

Both scripts run for real, with the yq the image ships (mikefarah v4) and a
fake kubectl. The tests are skipped where no such yq is found: set
K4ALL_TEST_YQ to its path, or put it first in PATH (GitHub's runners have it).

The same scripts ship from the v2.2.4 bridge on. What they do with Traefik
depends on the image's release manifest (Traefik from v2.4.0), so the tests
write that manifest themselves instead of reading the repository's.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys

import pytest
import yaml

from conftest import REPO

BIN = os.path.join(REPO, "bootc", "overlay", "usr", "local", "bin")
MIGRATE = os.path.join(BIN, "k4all-migrate-config.sh")
UPDATE_ROUTES = os.path.join(BIN, "update-routes.sh")
REDIRECT = "traefik-redirect-https@kubernetescrd"
MIDDLEWARES = "traefik.ingress.kubernetes.io/router.middlewares"


def _mikefarah_yq():
    for candidate in (os.environ.get("K4ALL_TEST_YQ"), shutil.which("yq")):
        if not candidate:
            continue
        try:
            out = subprocess.run([candidate, "--version"], capture_output=True,
                                 text=True, timeout=10, check=False).stdout
        except OSError:
            continue
        if "mikefarah" in out and re.search(r"version v?4\.", out):
            return candidate
    return None


YQ = _mikefarah_yq()
pytestmark = pytest.mark.skipif(
    YQ is None, reason="needs mikefarah yq v4 (K4ALL_TEST_YQ or PATH)")


def _exe(path, body):
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _bin_dir(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    link = bin_dir / "yq"
    if not link.exists():
        link.symlink_to(YQ)
    return bin_dir


def _run(script, root, bin_dir, extra_env=None):
    env = dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"]),
               K4ALL_ROOT=str(root))
    env.update(extra_env or {})
    return subprocess.run(["bash", script], env=env, capture_output=True,
                          text=True, check=False)


def _release_manifest(traefik="Managed"):
    """An image's manifest, with traefik Managed, Removed or absent. Absent
    is a release before v2.4.0, which runs ingress-nginx; from v2.4.0
    ingress-nginx is Removed (v2.4.0) or gone (v2.6.0)."""
    components = {"ingress-nginx": {"type": "helm", "version": "4.14.3"}}
    if traefik is not None:
        components["ingress-nginx"]["management"] = "Removed"
        components["traefik"] = {"type": "helm", "version": "42.4.0",
                                 "management": traefik}
    return yaml.safe_dump({
        "apiVersion": "k4all.magesgate.com/v1alpha1", "kind": "ReleaseManifest",
        "metadata": {"name": "k4all"}, "spec": {"components": components}})


# --- k4all-migrate-config.sh ------------------------------------------------
# /etc/k4all-config.yaml as a v2.3.0 install leaves it, with a user's comments.
V230_CONFIG = """\
apiVersion: k4all.magesgate.com/v1alpha1
kind: ClusterConfig
metadata:
  name: k4all-cluster-config
spec:
  networking:
    cni:
      type: calico
  # Ingress settings, edited by hand
  ingress:
    # the LoadBalancer IP of the ingress controller
    nginx:
      dedicatedIP: "192.168.6.201" # from the lab range
      isDefault: false
    cilium:
      dedicatedIP: ""
  proxy:
    httpProxy: ""
    httpsProxy: ""
    noProxy: ""
  componentOverrides: {}
"""


@pytest.fixture
def migrate(tmp_path):
    root = tmp_path / "root"
    (root / "etc").mkdir(parents=True)
    (root / "usr/local/bin").mkdir(parents=True)
    (root / "usr/local/share").mkdir(parents=True)
    shutil.copy(os.path.join(BIN, "k4all-utils"), root / "usr/local/bin")
    bin_dir = _bin_dir(tmp_path)
    config = root / "etc/k4all-config.yaml"
    backup = root / "etc/k4all-config.yaml.ingress-nginx.migrated"

    def run(text=None, traefik="Managed"):
        if text is not None:
            config.write_text(text)
        (root / "usr/local/share/k4all-release.yaml").write_text(
            _release_manifest(traefik))
        proc = _run(MIGRATE, root, bin_dir)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        return proc

    return run, config, backup


def test_nginx_settings_move_to_the_traefik_key(migrate):
    run, config, backup = migrate
    proc = run(V230_CONFIG)

    assert "Moved spec.ingress.nginx to spec.ingress.traefik" in proc.stdout
    text = config.read_text()
    doc = yaml.safe_load(text)
    assert doc["spec"]["ingress"] == {
        "traefik": {"dedicatedIP": "192.168.6.201", "isDefault": False},
        "cilium": {"dedicatedIP": ""}}
    # same place, comments kept
    assert list(doc["spec"]) == ["networking", "ingress", "proxy",
                                 "componentOverrides"]
    assert list(doc["spec"]["ingress"]) == ["traefik", "cilium"]
    for comment in ("# Ingress settings, edited by hand",
                    "# the LoadBalancer IP of the ingress controller",
                    "# from the lab range"):
        assert comment in text
    assert "nginx" not in text
    assert backup.read_text() == V230_CONFIG


def test_migration_runs_once(migrate):
    run, config, backup = migrate
    run(V230_CONFIG)
    first = config.read_text()

    proc = run()
    assert config.read_text() == first
    assert backup.read_text() == V230_CONFIG
    assert "spec.ingress.nginx" not in proc.stdout


@pytest.mark.parametrize("nginx, traefik", [
    ("    nginx:\n      dedicatedIP: \"\"\n",
     {"dedicatedIP": "", "isDefault": True}),
    ("    nginx:\n      isDefault: true\n",
     {"dedicatedIP": "", "isDefault": True}),
    ("    nginx: {}\n", {"dedicatedIP": "", "isDefault": True}),
    ("    nginx:\n", {"dedicatedIP": "", "isDefault": True}),
    ("    nginx:\n      dedicatedIP: 10.0.0.9\n      isDefault: false\n",
     {"dedicatedIP": "10.0.0.9", "isDefault": False}),
])
def test_left_out_fields_take_the_crd_defaults(migrate, nginx, traefik):
    run, config, _ = migrate
    run("apiVersion: k4all.magesgate.com/v1alpha1\nkind: ClusterConfig\n"
        "spec:\n  ingress:\n" + nginx)
    assert yaml.safe_load(config.read_text())["spec"]["ingress"] == {
        "traefik": traefik}


def test_an_existing_traefik_key_wins(migrate):
    run, config, backup = migrate
    text = V230_CONFIG.replace(
        "    cilium:\n",
        "    traefik:\n      dedicatedIP: \"192.168.6.202\"\n"
        "      isDefault: true\n    cilium:\n")
    proc = run(text)

    assert "spec.ingress.traefik already set" in proc.stdout
    ingress = yaml.safe_load(config.read_text())["spec"]["ingress"]
    assert ingress == {"traefik": {"dedicatedIP": "192.168.6.202", "isDefault": True},
                       "cilium": {"dedicatedIP": ""}}
    assert backup.read_text() == text


@pytest.mark.parametrize("traefik", ["Removed", None])
def test_nothing_moves_while_the_image_runs_no_traefik(migrate, traefik):
    run, config, backup = migrate
    run(V230_CONFIG, traefik=traefik)
    assert config.read_text() == V230_CONFIG
    assert not backup.exists()


def test_a_config_without_nginx_is_left_alone(migrate):
    run, config, backup = migrate
    text = V230_CONFIG.replace("    nginx:\n", "    traefik:\n")
    run(text)
    assert config.read_text() == text
    assert not backup.exists()


def test_the_default_config_of_this_release_is_left_alone(migrate):
    # The installer's default config and the image's manifest agree: the
    # nginx key while ingress-nginx runs, the traefik key from v2.4.0.
    run, config, backup = migrate
    with open(os.path.join(REPO, "bootc", "overlay", "etc",
                           "k4all-config.yaml.default"), encoding="utf-8") as fh:
        default = fh.read()
    with open(os.path.join(REPO, "bootc", "overlay", "usr", "local", "share",
                           "k4all-release.yaml"), encoding="utf-8") as fh:
        components = yaml.safe_load(fh)["spec"]["components"]
    traefik = components.get("traefik")
    run(default, traefik=None if traefik is None else
        traefik.get("management", "Managed"))
    assert config.read_text() == default
    assert not backup.exists()


@pytest.mark.parametrize("traefik,key", [(None, "nginx"), ("Managed", "traefik")])
def test_a_missing_ingress_section_is_the_one_of_the_image(migrate, traefik, key):
    # The bridge's script on an ingress-nginx image (v2.2.4, v2.3.0) adds
    # spec.ingress.nginx; on a Traefik image, spec.ingress.traefik.
    run, config, _ = migrate
    proc = run(V230_CONFIG.replace(V230_CONFIG[V230_CONFIG.index("  # Ingress"):
                                              V230_CONFIG.index("  proxy:")], ""),
               traefik=traefik)
    ingress = yaml.safe_load(config.read_text())["spec"]["ingress"]
    assert ingress == {key: {"isDefault": True, "dedicatedIP": ""},
                       "cilium": {"dedicatedIP": ""}}
    assert "spec.ingress.%s" % key in proc.stdout


# --- update-routes.sh ----------------------------------------------------------
# kubectl for one Ingress (headlamp/headlamp) and the redirect Middleware,
# kept in a JSON file; JSON patches are applied like the apiserver does.
FAKE_KUBECTL = r'''#!/usr/bin/env python3
import json, os, sys
state_path = os.environ["FAKE_KUBE_STATE"]
with open(state_path) as fh:
    state = json.load(fh)
args = [a for a in sys.argv[1:] if not a.startswith("--kubeconfig")]
with open(os.environ["FAKE_KUBE_LOG"], "a") as fh:
    fh.write(json.dumps(args) + "\n")

def save():
    with open(state_path, "w") as fh:
        json.dump(state, fh)

def walk(doc, path):
    parts = [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]
    for part in parts[:-1]:
        doc = doc[int(part)] if isinstance(doc, list) else doc[part]
    return doc, parts[-1]

if args[:2] == ["get", "middlewares.traefik.io"]:
    sys.exit(0 if state["middleware"] else 1)
if args[:2] == ["get", "ingress"]:
    if state["ingress"] is None:
        sys.exit(0 if "--ignore-not-found" in args else 1)
    print(json.dumps(state["ingress"]))
    sys.exit(0)
if args[:2] == ["patch", "ingress"]:
    assert "--type=json" in args, args
    obj = state["ingress"]
    for op in json.loads(args[args.index("-p") + 1]):
        parent, key = walk(obj, op["path"])
        if op["op"] == "test":
            if parent[key] != op["value"]:
                print("the server rejected our request: test failed", file=sys.stderr)
                sys.exit(1)
        elif op["op"] == "add" and isinstance(parent, list):
            parent.append(op["value"]) if key == "-" else parent.insert(int(key), op["value"])
        elif op["op"] in ("add", "replace"):
            parent[key] = op["value"]
        elif op["op"] == "remove":
            del parent[key]
    obj["metadata"]["resourceVersion"] = str(int(obj["metadata"]["resourceVersion"]) + 1)
    save()
    sys.exit(0)
print("unexpected kubectl %s" % args, file=sys.stderr)
sys.exit(1)
'''


def hook_ingress(ip="192.168.6.200"):
    """The dashboard Ingress as the headlamp hook of operators before v0.4.2
    writes it (v0.1.5 on clusters before k4all v2.4.0)."""
    return {
        "apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
        "metadata": {"name": "headlamp", "namespace": "headlamp",
                     "resourceVersion": "100",
                     "labels": {"app.kubernetes.io/managed-by": "k4all-operator"},
                     "annotations": {
                         "nginx.ingress.kubernetes.io/backend-protocol": "HTTP"}},
        "spec": {"ingressClassName": "nginx", "rules": [rule("dashboard.%s.nip.io" % ip)]},
    }


def rule(host):
    return {"host": host, "http": {"paths": [{
        "path": "/", "pathType": "Prefix",
        "backend": {"service": {"name": "headlamp", "port": {"number": 4466}}}}]}}


def traefik_config(ip="192.168.6.201", is_default=False, key="traefik"):
    return ("apiVersion: k4all.magesgate.com/v1alpha1\nkind: ClusterConfig\n"
            "spec:\n  cluster:\n    ha:\n      type: none\n  ingress:\n"
            "    %s:\n      dedicatedIP: \"%s\"\n      isDefault: %s\n"
            "    cilium:\n      dedicatedIP: \"192.168.6.203\"\n"
            % (key, ip, "true" if is_default else "false"))


@pytest.fixture
def routes(tmp_path):
    if shutil.which("jq") is None:
        pytest.skip("needs jq (the image has it)")
    root = tmp_path / "root"
    (root / "etc").mkdir(parents=True)
    (root / "opt/k4all/bin").mkdir(parents=True)
    (root / "usr/local/share").mkdir(parents=True)
    bin_dir = _bin_dir(tmp_path)
    _exe(bin_dir / "kubectl", FAKE_KUBECTL.replace(
        "#!/usr/bin/env python3", "#!" + sys.executable))
    # control-plane-utils as on a node, with the network bits fixed
    (root / "opt/k4all/bin/control-plane-utils").write_text(
        "source %s/k4all-utils\n"
        "K4ALL_CONFIG_FILE=%s/etc/k4all-config.yaml\n"
        "get_cluster_ip() { echo 192.168.6.200; }\n"
        "get_fqdn() { echo k4all-1.lab.example; }\n" % (BIN, root))
    state_path = tmp_path / "kube.json"
    log_path = tmp_path / "kubectl.log"

    def run(config, ingress, middleware=True, traefik="Managed"):
        (root / "etc/k4all-config.yaml").write_text(config)
        (root / "usr/local/share/k4all-release.yaml").write_text(
            _release_manifest(traefik))
        state_path.write_text(json.dumps({"ingress": ingress,
                                          "middleware": middleware}))
        return again()

    def again():
        log_path.write_text("")
        proc = _run(UPDATE_ROUTES, root, bin_dir,
                    {"FAKE_KUBE_STATE": str(state_path),
                     "FAKE_KUBE_LOG": str(log_path)})
        state = json.loads(state_path.read_text())
        calls = [json.loads(l) for l in log_path.read_text().splitlines()]
        return proc, state["ingress"], calls

    run.again = again
    run.login_data = root / "etc/login_data"
    return run


def patches(calls):
    return [c for c in calls if c[:1] == ["patch"]]


def test_dashboard_route_moves_to_traefik(routes):
    proc, ingress, calls = routes(traefik_config(), hook_ingress())

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert len(patches(calls)) == 1
    assert ingress["spec"]["ingressClassName"] == "traefik"
    assert ingress["metadata"]["annotations"] == {MIDDLEWARES: REDIRECT}
    # the hook's rule stays; the FQDN and the dedicated-IP nip.io are added
    assert [r["host"] for r in ingress["spec"]["rules"]] == [
        "dashboard.192.168.6.200.nip.io",
        "dashboard.k4all-1.lab.example",
        "dashboard.192.168.6.201.nip.io"]
    assert all(r["http"] == rule("x")["http"] for r in ingress["spec"]["rules"])
    assert routes.login_data.read_text() == (
        " - FQDN Route: https://dashboard.k4all-1.lab.example/\n"
        " - nip.io Route: https://dashboard.192.168.6.201.nip.io/\n")


def test_an_up_to_date_route_is_not_patched(routes):
    routes(traefik_config(), hook_ingress())
    proc, ingress, calls = routes.again()

    assert proc.returncode == 0, proc.stderr
    assert patches(calls) == []
    assert "up to date" in proc.stdout
    assert len(ingress["spec"]["rules"]) == 3


def test_rules_are_found_by_host_not_by_index(routes):
    ingress = hook_ingress()
    ingress["spec"]["rules"] = [rule("dashboard.k4all-1.lab.example"),
                                rule("users.example.com")]
    _, ingress, _ = routes(traefik_config(), ingress)

    assert [r["host"] for r in ingress["spec"]["rules"]] == [
        "dashboard.k4all-1.lab.example", "users.example.com",
        "dashboard.192.168.6.201.nip.io"]


def test_dedicated_ip_counts_even_when_traefik_is_not_the_default(routes):
    # With a dedicated IP Traefik's Service is a LoadBalancer on it; the
    # Cilium IP and the node's address do not serve the traefik class.
    _, ingress, _ = routes(traefik_config(is_default=False), hook_ingress())
    hosts = [r["host"] for r in ingress["spec"]["rules"]]
    assert "dashboard.192.168.6.201.nip.io" in hosts
    assert "dashboard.192.168.6.203.nip.io" not in hosts


def test_without_dedicated_ip_the_route_uses_the_cluster_ip(routes):
    _, ingress, _ = routes(traefik_config(ip=""), hook_ingress())
    assert [r["host"] for r in ingress["spec"]["rules"]] == [
        "dashboard.192.168.6.200.nip.io", "dashboard.k4all-1.lab.example"]
    assert "dashboard.192.168.6.200.nip.io" in routes.login_data.read_text()


def test_an_unmigrated_config_is_read_through_the_nginx_key(routes):
    _, ingress, _ = routes(traefik_config(key="nginx"), hook_ingress())
    assert "dashboard.192.168.6.201.nip.io" in \
        [r["host"] for r in ingress["spec"]["rules"]]


def test_no_redirect_while_the_middleware_is_missing(routes):
    # A route naming a missing Middleware is not served at all.
    ingress = hook_ingress()
    ingress["metadata"]["annotations"][MIDDLEWARES] = REDIRECT
    _, ingress, _ = routes(traefik_config(), ingress, middleware=False)
    assert ingress["spec"]["ingressClassName"] == "traefik"
    assert ingress["metadata"]["annotations"] == {}


def test_class_and_annotations_stay_without_traefik(routes):
    _, ingress, _ = routes(traefik_config(), hook_ingress(), traefik="Removed")
    assert ingress["spec"]["ingressClassName"] == "nginx"
    assert ingress["metadata"]["annotations"] == {
        "nginx.ingress.kubernetes.io/backend-protocol": "HTTP"}
    assert len(ingress["spec"]["rules"]) == 3


def test_a_missing_ingress_is_not_an_error(routes):
    proc, ingress, calls = routes(traefik_config(), None)
    assert proc.returncode == 0, proc.stderr
    assert ingress is None and patches(calls) == []
    assert "does not exist yet" in proc.stdout
    assert routes.login_data.exists()
