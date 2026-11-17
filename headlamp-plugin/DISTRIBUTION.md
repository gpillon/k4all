# Distributing the k4all Headlamp plugin

## How it ships

The built plugin is a small OCI image,
`ghcr.io/gpillon/k4all-headlamp-plugin:<version>`, pinned per k4all release in
the `headlamp` component of `bootc/overlay/usr/local/share/k4all-release.yaml`.
An initContainer copies it into an `emptyDir` that Headlamp sees as
`/headlamp/plugins/k4all-headlamp-plugin`. A k4all release that bumps the tag
upgrades the plugin through the normal ReleaseManifest sync. **No operator
change is needed.** First release: plugin 0.1.0 in k4all v2.4.0.

| File | What |
|---|---|
| `Containerfile` | the image: multi-stage, builds the plugin on the build platform, final stage busybox (uid 100:101) with `/plugins/k4all-headlamp-plugin/{main.js,package.json}` |
| `.github/workflows/headlamp-plugin.yaml` | CI: lint, tsc, tests, build, helm check on every change; the image on a `headlamp-plugin-v<version>` tag |
| `distribution/v2.4.0-headlamp-values.patch` | the change to `k4all-release.yaml` (headlamp values) and to `test_image_contract.py` for the v2.4.0 release commit |
| `distribution/test-helm-template.sh` | renders the Headlamp chart of a k4all-release.yaml with its headlamp values and checks the plugin wiring |
| `distribution/values-imagevolume.yaml` | the alternative wiring as an image volume (same image) |
| `distribution/rbac.yaml` | `k4all-viewer`, `k4all-editor`, `k4all-upgrader` ClusterRoles for non-admin users |

## How Headlamp 0.46.0 loads plugins (checked)

- `helm show chart headlamp --repo https://kubernetes-sigs.github.io/headlamp/ --version 0.46.0`:
  `appVersion: 0.46.0`; the Deployment runs `ghcr.io/headlamp-k8s/headlamp:v0.46.0`.
- k4all sets `config.pluginsDir: /headlamp/plugins`, rendered as
  `-plugins-dir=/headlamp/plugins`. Every sub-folder with `main.js` and
  `package.json` is a plugin.
- The plugin API to build with is the `@kinvolk/headlamp-plugin` version
  Headlamp v0.46.0 carries in its own tree: **0.14.0**
  (`plugins/headlamp-plugin/package.json` at tag v0.46.0). Headlamp loads a
  plugin only if the `@kinvolk/headlamp-plugin` version declared in the
  plugin's `package.json` (`devDependencies`) satisfies `>=0.8.0-alpha.3`, so
  the image ships `package.json` next to `main.js`.
- In Headlamp's image, `/headlamp/plugins` is whatever `.plugins` folder was in
  its build context (nothing in the official image); the bundled plugins live
  in `/headlamp/static-plugins`. Mounting a sub-folder of `/headlamp/plugins`
  hides nothing and leaves the folder usable by other plugins or the chart's
  `pluginsManager`.
- The chart passes `initContainers`, `volumes` and `volumeMounts` through
  unchanged; `values.schema.json` accepts them.
- In-cluster, Headlamp loads every plugin of `pluginsDir` for every user (no
  per-user enable list in web mode) and does not watch the folder; a new
  plugin version arrives with a new pod, which is exactly what a values change
  produces.

## The image

```bash
# from headlamp-plugin/
podman build -f Containerfile --build-arg PLUGIN_VERSION=0.1.0 \
  -t ghcr.io/gpillon/k4all-headlamp-plugin:0.1.0 .
```

- Stage 1 (`node:22-alpine`, on the build platform): `npm ci` from the
  lockfile, `npm run build`. The JavaScript is architecture independent.
- Stage 2 (`busybox:1.37-musl`, per target platform, about 1.5 MB plus the
  plugin's 240 kB): the plugin files and a default command that copies them.
  `busybox` is only there for `cp`; for the image-volume variant the files
  alone would do (a `scratch` image), but one image serving both keeps the
  switch a values-only change. The final stage runs nothing, so the
  multi-arch build needs no emulation.
- Labels: OCI title/source/version/license plus
  `io.k4all.headlamp-plugin.version` and `.path`.
- No `:latest`: each k4all release pins its version, and a contract test
  (`test_headlamp_carries_the_pinned_k4all_plugin`) refuses anything but a
  release tag.

## Release flow

1. Bump `plugin/package.json` `version` (semver of its own, 0.1.0 first) in
   the change that needs it.
2. Tag `headlamp-plugin-v<version>` (e.g. `headlamp-plugin-v0.1.0`) on that
   commit and push the tag. `.github/workflows/headlamp-plugin.yaml` runs the
   checks, then builds and pushes
   `ghcr.io/gpillon/k4all-headlamp-plugin:<version>` for amd64 and arm64 and
   prints the reference and digest in the run summary. The tag must match
   `package.json`, or the job fails. A manual run (`workflow_dispatch` with a
   `version` input) does the same from any branch, e.g. for a lab build:
   `gh workflow run headlamp-plugin.yaml --ref <branch> -f version=0.1.0`.
3. The k4all release commit pins that tag in `k4all-release.yaml`. **The
   image must exist before the release reaches a cluster**: otherwise the
   Headlamp pod stays in `Init:ImagePullBackOff` after the sync.

Release ladder: a plugin bump is a component change of headlamp with no
migration, so it fits a patch release (`v2.Y.z`). A plugin that needs new
CRD fields ships in the release that ships the operator with those fields;
the plugin also checks the operator version itself (DESIGN.md 4.1), and it
writes with `fieldValidation=Strict`, so a mismatch shows as "upgrade k4all
first" instead of silently dropped settings.

Headlamp chart bumps: check the `@kinvolk/headlamp-plugin` version in the new
Headlamp tag (`plugins/headlamp-plugin/package.json`), bump the
devDependency, run lint/tsc/tests/build, then `test-helm-template.sh`
against the release file with the new chart version.

| k4all | operator | Kubernetes | Headlamp chart / app | headlamp-plugin API | plugin |
|---|---|---|---|---|---|
| v2.4.0 | v0.4.0 | 1.35 | 0.46.0 / v0.46.0 | 0.14.0 | 0.1.0 |

## Wiring in k4all-release.yaml (k4all v2.4.0)

`distribution/v2.4.0-headlamp-values.patch` is made on the v2.4.0 release
commit (9fc29b6) and also applies on the later release commits, so rebasing
them after the rewritten v2.4.0 stays clean:

```bash
git apply headlamp-plugin/distribution/v2.4.0-headlamp-values.patch
headlamp-plugin/distribution/test-helm-template.sh --require
python3 -m pytest -q bootc/tests/upgrade
```

What it adds to the `headlamp` component values (the rest of the entry is
unchanged):

```yaml
        initContainers:
          - name: k4all-plugin
            image: ghcr.io/gpillon/k4all-headlamp-plugin:0.1.0
            imagePullPolicy: IfNotPresent
            command: [sh, -c, "cp -R /plugins/k4all-headlamp-plugin/. /k4all-plugin/"]
            resources:
              requests: {cpu: 10m, memory: 16Mi}
              limits: {memory: 32Mi}
            securityContext:
              runAsNonRoot: true
              runAsUser: 100
              runAsGroup: 101
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true
              capabilities: {drop: [ALL]}
              seccompProfile: {type: RuntimeDefault}
            volumeMounts:
              - name: k4all-plugin
                mountPath: /k4all-plugin
        volumes:
          - name: k4all-plugin
            emptyDir:
              sizeLimit: 16Mi
        volumeMounts:
          - name: k4all-plugin
            mountPath: /headlamp/plugins/k4all-headlamp-plugin
            readOnly: true
```

and to `bootc/tests/upgrade/test_image_contract.py`:
`test_headlamp_carries_the_pinned_k4all_plugin` (the initContainer exists
once, its image is `ghcr.io/gpillon/k4all-headlamp-plugin:<X.Y.Z>`, the
emptyDir volume and the read-only mount under `pluginsDir` are there).

`test-helm-template.sh` output on the patched v2.4.0 file (helm v3.16.2,
chart 0.46.0):

```
ok: chart 0.46.0, release values (image ghcr.io/gpillon/k4all-headlamp-plugin:0.1.0; mounts: /headlamp/plugins/k4all-headlamp-plugin)
ok: chart 0.46.0, release values + pluginsManager (image ghcr.io/gpillon/k4all-headlamp-plugin:0.1.0; mounts: /headlamp/plugins, /headlamp/plugins/k4all-headlamp-plugin)
ok: image volume variant renders (volume + subPath mount, no initContainer)
```

It checks the initContainer (pinned image, securityContext, its mount), the
emptyDir, the read-only mount, `-plugins-dir=/headlamp/plugins`, coexistence
with the chart's `pluginsManager` (nested mounts), and that the image-volume
variant renders with the same image. Without `--require` it skips a release
file that does not wire the plugin (so CI stays green on branches before
v2.4.0). The contract tests of the patched v2.4.0 tree pass (109), and the
new one fails on `:latest`.

### Lifecycle

1. A k4all release changes the image tag (nothing else).
2. `k4all-upgrade` syncs the new ReleaseManifest.
3. The headlamp component spec changed, so its `appliedHash` changes and the
   operator runs `helm upgrade`.
4. The pod template changed, so the Deployment rolls; the new pod's
   initContainer copies the new plugin into a fresh emptyDir.
5. Users reload the page.

Nothing persists between versions (emptyDir), so there is no cleanup and no
stale file. Rolling back the OS (`bootc rollback`) does not touch the cluster;
like every component, the plugin moves forward with the release ladder only.
To hold an older plugin on purpose, set the three lists in
`componentOverrides.headlamp.values` (lists replace, they do not merge; the
plugin's overrides editor warns about exactly this).

### Pre-pulled image (proposal H-4)

The bootc image pre-loads the operator image (and Traefik from v2.6.0). Adding
the plugin image keeps the Headlamp rollout offline-safe. In
`bootc/Containerfile`, where `/tmp/k8s-images.txt` is filled:

```sh
    PLUGIN_IMAGE="$(yq '.spec.components.headlamp.values.initContainers[] | select(.name == "k4all-plugin") | .image' /usr/local/share/k4all-release.yaml)"; \
    if [ -n "$PLUGIN_IMAGE" ]; then echo "$PLUGIN_IMAGE" >> /tmp/k8s-images.txt; fi; \
```

The bootc build then fails if the plugin image was not pushed first, which
also enforces step 3 of the release flow. If a release pins
`tag@sha256:…`, the `docker-archive:` destination needs the reference without
the digest (`${img%@*}`).

## Alternatives

| Option | How | For | Against | Verdict |
|---|---|---|---|---|
| **A. OCI image + initContainer** | this document | pinned per release; upgrades through the existing sync; offline with pre-pull; no operator code; works on any kubelet/CRI-O; leaves `pluginsDir` free | one more image to build; a tiny initContainer per Headlamp start | **used** |
| B. Same image as an image volume | `volumes[].image.reference` + `subPath` mount (`values-imagevolume.yaml`) | no copy, no initContainer, read-only and noexec by construction | ImageVolume is beta (on by default) in 1.35 and GA in 1.36, subPath on image volumes and CRI-O support need a lab test; k4all v2.4.0 runs 1.35 | next step after a lab test; a values-only switch |
| C. Headlamp `pluginsManager` sidecar | chart runs `npx @headlamp-k8s/pluginctl install --watch` from a `plugin.yml` | upstream mechanism, no own image | needs the plugin published (ArtifactHub/npm or a tarball URL) and Internet on every pod start; a `node:lts-alpine` sidecar running forever; not air-gap friendly | no |
| D. Operator hook | `headlamp_hook.go` writes `main.js` into a ConfigMap and patches the Deployment | no registry | couples plugin releases to operator releases; patches a Helm-owned Deployment; ConfigMap limit 1 MiB | no |
| E. Custom Headlamp image | `FROM ghcr.io/headlamp-k8s/headlamp:v0.46.0` + plugin | simplest pod | a Headlamp fork image to rebuild for every Headlamp bump | no |
| F. In the bootc node image + hostPath | plugin under `/usr/share`, hostPath mount | no registry | ties the plugin to the OS image of whatever node Headlamp lands on; mixed versions during multi-node hops; hostPath | no |

## Lab test checklist

1. Build the image: `gh workflow run headlamp-plugin.yaml --ref <branch> -f
   version=0.1.0` (or tag `headlamp-plugin-v0.1.0`), or locally
   `podman build … && podman save … | ssh <node> sudo podman load` (CRI-O
   reads the same containers-storage).
2. Wire it: either the patched v2.4.0 release through the normal sync, or,
   on a running cluster without touching the ReleaseManifest, the three
   lists in `componentOverrides.headlamp.values` of the ClusterConfig (they
   survive syncs). The operator re-applies headlamp.
3. `kubectl -n headlamp logs deploy/headlamp -c k4all-plugin`, then the
   **k4all** sidebar entry in Headlamp.
4. Settings and components: toggle a feature (dry run, diff, apply); edit
   the ClusterConfig with kubectl while a form is dirty (rebase / conflict
   table); ingress settings on a v2.4.0 cluster write `spec.ingress.nginx`;
   overrides on a Helm component; Unmanaged and back on a leaf component;
   re-apply; a viewer token with `k4all-viewer` (read-only UI); the plugin
   on a non-k4all cluster (empty state).
5. Upgrades (needs the operator's ClusterUpgrade controller and the v2.4.0
   host agent): the target list matches the graph; the review's path matches
   `sudo k4all-upgrade plan --to <target>` on the bootstrap node; start
   an upgrade to the next release on a 3-node cluster and follow it (drain
   timer, host phases, the page reconnecting when Headlamp's node reboots);
   pause and resume between nodes; a PodDisruptionBudget that blocks the
   drain (minAvailable equal to replicas) → failed drain → guidance →
   relax it → Retry; a HOLD (e.g. fill `/sysroot`) → guidance → `clear-hold
   && resume`; `clear-hold --abandon` → ABANDONED → Retry; Stop mid-hop;
   a `k4all-upgrader` token; a single-node cluster (cordon only).
6. Watch the dashboard Ingress after a settings save (O-2).
7. Optional: repeat step 2 with `values-imagevolume.yaml` to qualify option B.

For UI work without an image, `npm start` in `plugin/` builds in watch mode
and copies the plugin into the Headlamp desktop app's plugin folder; point the
app at the lab kubeconfig.
