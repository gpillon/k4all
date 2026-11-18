#!/usr/bin/env bash
# Renders the Headlamp chart of a k4all release with that release's headlamp
# values and checks that the Deployment carries the k4all plugin:
# initContainer with a pinned plugin image, emptyDir volume, read-only mount
# under the plugins dir, and the -plugins-dir argument. Also renders it with
# the chart's own pluginsManager turned on (the two must live together), and
# the image-volume alternative (values-imagevolume.yaml) with the same image.
#
#   test-helm-template.sh [--require] [k4all-release.yaml]
#
# The file defaults to bootc/overlay/usr/local/share/k4all-release.yaml. A
# release whose headlamp component does not wire the plugin is skipped,
# unless --require is given. Needs helm and python3 with PyYAML; the chart
# comes from the repo and version the release names. Helm caches stay in
# headlamp-plugin/.helm (git-ignored).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
plugin_root="$(dirname "$here")"
repo_root="$(dirname "$plugin_root")"

require=false
if [ "${1:-}" = "--require" ]; then
  require=true
  shift
fi
release="${1:-$repo_root/bootc/overlay/usr/local/share/k4all-release.yaml}"

export HELM_CACHE_HOME="$plugin_root/.helm/cache" \
  HELM_CONFIG_HOME="$plugin_root/.helm/config" \
  HELM_DATA_HOME="$plugin_root/.helm/data"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# repo, version, values and plugin image of the headlamp component
status=0
python3 - "$release" "$tmp" <<'EOF' || status=$?
import re, sys, yaml
release, out = sys.argv[1], sys.argv[2]
component = yaml.safe_load(open(release))["spec"]["components"]["headlamp"]
values = component.get("values") or {}
init = [c for c in values.get("initContainers") or [] if c.get("name") == "k4all-plugin"]
if not init:
    sys.exit(3)
image = init[0]["image"]
if not re.fullmatch(r"ghcr\.io/gpillon/k4all-headlamp-plugin:\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(@sha256:[0-9a-f]{64})?", image):
    sys.exit(f"FAIL: plugin image {image!r} is not ghcr.io/gpillon/k4all-headlamp-plugin:<X.Y.Z>")
open(f"{out}/repo", "w").write(component["repo"])
open(f"{out}/version", "w").write(str(component["version"]))
open(f"{out}/image", "w").write(image)
open(f"{out}/plugins-dir", "w").write(values["config"]["pluginsDir"].rstrip("/"))
yaml.safe_dump(values, open(f"{out}/values.yaml", "w"))
EOF
if [ "$status" -eq 3 ]; then
  if $require; then
    echo "FAIL: $release: the headlamp component has no k4all-plugin initContainer" >&2
    exit 1
  fi
  echo "skip: $release does not wire the k4all plugin into headlamp yet"
  exit 0
elif [ "$status" -ne 0 ]; then
  exit "$status"
fi
chart_repo="$(cat "$tmp/repo")"
chart_version="$(cat "$tmp/version")"
image="$(cat "$tmp/image")"
plugins_dir="$(cat "$tmp/plugins-dir")"

render() {
  helm template headlamp headlamp --repo "$chart_repo" --version "$chart_version" \
    --namespace headlamp "$@"
}

check() {
  local label="$1"; shift
  render -f "$tmp/values.yaml" "$@" > "$tmp/out.yaml"
  python3 - "$tmp/out.yaml" "$image" "$plugins_dir" "$label" <<'EOF'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
image, plugins_dir, label = sys.argv[2], sys.argv[3], sys.argv[4]

def fail(msg):
    sys.exit(f"FAIL: {label}: {msg}")

deps = [d for d in docs if d.get("kind") == "Deployment"]
if len(deps) != 1:
    fail(f"expected one Deployment, got {len(deps)}")
pod = deps[0]["spec"]["template"]["spec"]
init = {c["name"]: c for c in pod.get("initContainers") or []}
plugin = init.get("k4all-plugin")
if not plugin or plugin.get("image") != image:
    fail(f"initContainer k4all-plugin with {image} not rendered")
sc = plugin.get("securityContext") or {}
if sc.get("runAsNonRoot") is not True or sc.get("readOnlyRootFilesystem") is not True:
    fail("initContainer securityContext lost")
target = next((m for m in plugin.get("volumeMounts") or [] if m["name"] == "k4all-plugin"), None)
if not target:
    fail("initContainer does not mount the k4all-plugin volume")
volumes = {v["name"]: v for v in pod.get("volumes") or []}
if "emptyDir" not in volumes.get("k4all-plugin", {}):
    fail("emptyDir volume k4all-plugin not rendered")
main = next(c for c in pod["containers"] if c["name"] == "headlamp")
mounts = {m["mountPath"]: m for m in main.get("volumeMounts") or []}
m = mounts.get(f"{plugins_dir}/k4all-headlamp-plugin")
if not m or m["name"] != "k4all-plugin" or m.get("readOnly") is not True:
    fail(f"plugin volume not mounted read-only at {plugins_dir}/k4all-headlamp-plugin")
if f"-plugins-dir={plugins_dir}" not in main["args"]:
    fail(f"-plugins-dir={plugins_dir} missing")
if label.endswith("pluginsManager") and plugins_dir not in mounts:
    fail("pluginsManager plugins-dir mount missing next to ours")
print(f"ok: {label} (image {image}; mounts: {', '.join(sorted(mounts))})")
EOF
}

check "chart $chart_version, release values"
check "chart $chart_version, release values + pluginsManager" \
  --set pluginsManager.enabled=true \
  --set-string pluginsManager.configContent='plugins: []'

# Alternative: the same image as an image volume instead of the initContainer.
python3 - "$tmp/values.yaml" "$here/values-imagevolume.yaml" "$image" "$tmp/values-iv.yaml" <<'EOF'
import sys, yaml
values = yaml.safe_load(open(sys.argv[1]))
values.pop("initContainers")
alt = yaml.safe_load(open(sys.argv[2]))
alt["volumes"][0]["image"]["reference"] = sys.argv[3]
values.update(alt)
yaml.safe_dump(values, open(sys.argv[4], "w"))
EOF
render -f "$tmp/values-iv.yaml" > "$tmp/out-iv.yaml"
python3 - "$tmp/out-iv.yaml" "$image" <<'EOF'
import sys, yaml
dep = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") == "Deployment")
pod = dep["spec"]["template"]["spec"]
vol = next(v for v in pod["volumes"] if v["name"] == "k4all-plugin")
assert vol["image"]["reference"] == sys.argv[2], vol
assert not pod.get("initContainers"), "no initContainer expected"
mount = next(m for c in pod["containers"] if c["name"] == "headlamp" for m in c["volumeMounts"] if m["name"] == "k4all-plugin")
assert mount["subPath"] == "plugins/k4all-headlamp-plugin" and mount["readOnly"] is True, mount
print("ok: image volume variant renders (volume + subPath mount, no initContainer)")
EOF
