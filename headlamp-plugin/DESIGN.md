# k4all Headlamp plugin: design

Status: built and unit-tested (416 tests), not yet run against a live
cluster. Ships from k4all v2.4.0 (k4all-operator v0.5.0, Traefik, Headlamp
chart 0.46.0, Kubernetes 1.35 and later); plugin 0.2.0 adds the k4all v2.7.0
pages (k4all-operator v0.6.0, section 3.8-3.10). User guide:
`docs/headlamp-plugin.md`. Packaging and release: `DISTRIBUTION.md`.

## 1. Summary

A Headlamp plugin that adds a **k4all** section to the sidebar, so the common
k4all tasks are done through guided screens instead of editing
`ClusterConfig`, `ReleaseManifest` and `ClusterUpgrade` by hand:

- **Overview**: release, upgrade summary, health, component state, features,
  ingress, nodes with their release and upgrade phase, in one screen.
- **Upgrades**: move every node to a newer k4all release through the
  operator's `ClusterUpgrade`: choose a target, review the path, the node
  order, the drain and the downtime, then follow the hops node by node,
  pause, resume, stop, retry, with guidance when a node gets stuck.
- **Settings**: features, ingress, Cilium options as forms with validation.
  Install-time fields are shown read-only with the reason; those a newer
  operator can change live (CNI, OVS bridge) turn into controls by
  themselves once the cluster runs that operator.
- **Components**: the ReleaseManifest components with state, versions and
  upgrade paths; per component: Helm value overrides (stored in the
  ClusterConfig, so they survive upgrades), management policy, re-apply.
- A **k4all** section on Headlamp's Node page (role, release, upgrade phase,
  interfaces).
- From k4all v2.7.0 (operator v0.6.0), three settings pages with stable
  routes the Hangar and Cairn consoles link to: **Virtualization** (KubeVirt
  gates k4all owns, VM state StorageClass, Hangar's node agent, the metadata
  service), **Node settings** (max pods, CPU manager, reserved CPUs, topology
  manager, hugepages, IOMMU, with the plan of the rollout and its progress),
  **Storage** (Rook/Ceph, created once, then Cairn's).

Every save is a JSON Patch checked by a server-side dry run, shown as a
human-readable change list plus a YAML diff, guarded against concurrent edits.

## 2. Users and what they come for

| Who | Context | Needs |
|---|---|---|
| Home-lab / edge admin (main user) | 1-3 nodes installed from the k4all ISO; logs in to Headlamp with the `headlamp-admin` token; knows Kubernetes a little | "Is there a new release, what does it change, how long are my apps down?", run the upgrade without SSH, "is my cluster fine after the upgrade?", turn Virtualization or Argo CD on, give the ingress a LoadBalancer IP, tweak a component's Helm values without losing them at the next upgrade |
| Platform operator | several k4all clusters, kubectl-fluent | the same tasks faster and with guard rails: dry run, diff, conflict detection, a clear list of what a change re-applies, the node commands when a hop holds |
| Viewer | read-only access | status of release, upgrade, components, nodes |

The common settings were chosen from what the installer exposes
(`k4all-anaconda-addon/.../constants.py`, `kickstart.py`: CNI, HA, virt,
Argo CD, ingress IPs/default, firewalld, networks), the default node config
(`k4all-config.yaml.default`), what k4all-operator applies live (its hooks),
and `docs/upgrades.md` (release ladder, node upgrade hops, the sync rules of
the ReleaseManifest).

Jobs, most frequent first:

1. Check health after an upgrade: release version, components installed or
   failed, a component walking its `upgradePath`, a node mid-hop.
2. Upgrade the cluster to a newer k4all release, and follow it.
3. Turn a feature on or off: Virtualization (with emulation mode), Argo CD,
   OVS secondary networks.
4. Ingress: dedicated IP and default IngressClass of the release's ingress
   controller (Traefik from v2.4.0, the first release with the plugin;
   ingress-nginx where a cluster kept it); Cilium ingress IP.
5. Cilium options: L2 announcements, Hubble, Gateway API, devices.
6. Customize a component's Helm values so the customization survives k4all
   upgrades (`componentOverrides`).
7. Take a component out of the operator's hands (Unmanaged), or put it back;
   re-apply a component that drifted (force-resync).

Non-goals (and why):

- **Running a hop on a node directly.** The node's `k4all-upgrade` runs the
  hop; the plugin only sets the ClusterUpgrade target, and the operator asks
  the nodes one at a time (node annotations). When a node holds, the fix is
  on the node, and the plugin gives the commands.
- **Editing ReleaseManifest versions or values.** The release sync of
  `k4all-upgrade` replaces every component spec except `custom` and
  `management: Unmanaged`, so such edits would silently vanish at the next
  upgrade. Customization goes to `componentOverrides` instead.
- **Install-time settings** (pod/service networks, API endpoint, HA,
  firewalld, proxy): shown read-only, see 4. CNI and OVS bridge are
  read-only until k4all-operator v0.8.0 (4.1).
- **What a console owns**: Ceph day-2 (OSDs, pools, mon/mgr counts) is
  Cairn's, gates k4all does not list and the other KubeVirt settings are
  Hangar's. The pages show them and link there.
- **NodeConfig**: it has no spec, only status, shown on the Node page.

## 3. Screens

Sidebar (cluster scope): `k4all` (icon `mdi:hexagon-multiple-outline`) with
Overview, Upgrades, Settings, Virtualization, Node settings, Storage,
Components. Routes, all cluster-prefixed by Headlamp:

| Route name | Path | Screen |
|---|---|---|
| `k4all-overview` | `/k4all` | Overview |
| `k4all-upgrades` | `/k4all/upgrades` | Upgrades |
| `k4all-settings` | `/k4all/settings?tab=features\|ingress\|networking\|install` | Settings |
| `k4all-settings-virtualization` | `/k4all/settings/virtualization` (anchors `#feature-gates`, `#vm-state`, `#metadata`) | Virtualization (3.8) |
| `k4all-settings-nodes` | `/k4all/settings/nodes` | Node settings (3.9) |
| `k4all-settings-storage` | `/k4all/settings/storage` | Storage (3.10) |
| `k4all-components` | `/k4all/components` | Components |
| `k4all-component` | `/k4all/components/:name` | Component detail |
| (details section) | Headlamp `/node/:name` | k4all section on the Node page |

### 3.1 Overview

```
 [hex] k4all                                [k4all v2.4.0] [Kubernetes v1.35.10] (● Healthy)
       Kubernetes for All: release, components and node upgrades
 ┌ banners: upgrade hop on node X (v2.4.0 → v2.5.0) · settings being applied ·
 │          operator idle for 40 min · N components failed (list)
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ [⟳] Upgrades (● Upgrade available)  The cluster runs k4all v2.4.0.          │
 │     4 newer releases, latest v2.7.0 (Kubernetes 1.36.4, Fedora 45). [Plan →]│
 ├────────────────┬──────────────────┬───────────────────┬────────────────────┤
 │ Components     │ Features  [Change]│ Ingress  [Change] │ Release            │
 │ 14/14 active   │ Virtualization ●On│ Traefik address   │ k4all-operator     │
 │ installed      │ Argo CD      ○Off │ 192.168.1.240     │ v0.5.0             │
 │ ▇▇▇▇▇▇▇▇▇▁▁    │ OVS networks ○Off │ ● Default class   │ Operator status    │
 │ cert-manager → │ OVS bridge   ●On  │ CNI: calico       │ 14/14 installed    │
 │ v1.18.6 (+3)   │ (set at install)  │                   │ Last reconcile 2m  │
 ├────────────────┴──────────────────┴───────────────────┴────────────────────┤
 │ Nodes: name · role · Ready · Kubernetes · OS · runtime · address ·          │
 │        k4all release · k4all upgrade (idle / host phase / v2.4.0 → v2.5.0)  │
 └─────────────────────────────────────────────────────────────────────────────┘
```

The upgrade card follows the upgrade while one runs (current → target, hop
x of y, nodes done, progress bar). With an operator older than v0.4.0 it
says which release brings upgrades from Headlamp.

From operator v0.6.0 the Features panel adds Rook/Ceph (readiness from the
`RookReady` condition) and links the consoles (Hangar under Virtualization,
Cairn under Rook). Banners, each with a button to its page: components
k4all-operator keeps installed though they should go (status message
`uninstall refused: …`, Components), components uninstalled in order
behind another member of their group (`uninstall queued: …`, #96; their
state reads "Uninstall queued"), components that wait (`waiting: …`, the
neutral wait of v0.6.0), and the node-settings rollout while Rolling,
Paused or Blocked (`status.nodes`, Node settings). The messages after the
prefixes are shown as the operator writes them; every member of a held
group carries the same message, which is listed once with the components
it holds (here and on the feature switches).

Health headline: Healthy, Reconciling (components busy, settings not yet
applied, Ready not True), Upgrading (node annotation or Ready reason
`UpgradeInProgress`), Needs attention (failed components,
`ClusterConfigNotFound`, `DependencyCycle`). The operator is called idle when
`ClusterConfig.status.lastReconcileTime` is older than 15 minutes (it requeues
every 5) and no hop is running.

### 3.2 Upgrades

```
 [⟳] Upgrades                          [k4all v2.4.1] [Kubernetes v1.35.10] (◌ Upgrading)
     Move every node to a newer k4all release, one hop and one node at a time
 ┌ banner per state: waiting for the operator · stopped (message, Retry) ·
 │ paused (Resume) · complete · spec not processed yet · False conditions
 ├ v2.4.1 → v2.6.0 ────────────────────────────── [Retry] [Pause] [Stop] ┐
 │ (◌ Upgrading) [hop 2 of 3: v2.5.0] [1 of 3 nodes done in this hop]    │
 │  (✓)v2.4.1 ──── (◌)v2.5.0 ──── ( )v2.6.0      ← hop trail             │
 │  ▇▇▇▇▇▇▇▇▁▁▁▁▁▁▁  44% of the node hops                                │
 │  ⓘ Draining cp-2                              ← status.message        │
 │  [guidance per stuck node, with copyable commands and Retry]          │
 │  # node  role  release  upgrade   on the node  node status  detail    │
 │  1 cp-1  boot  v2.5.0   ● Done    —            ● Ready                │
 │  2 cp-2  ctrl  v2.4.1   ◌ Draining —           ● Ready, cordoned  ▇▇▁ 6 min of 30 min │
 │  3 w-1   work  v2.4.1   ○ Waiting —            ● Ready                │
 ├ Available releases (newest first) ─────────┬ How upgrades run [Change] ┤
 │ v2.7.0 [minor][latest]     [Change target]  │ node order 1.cp-1 › 2.cp-2│
 │  Kubernetes 1.35.10 → 1.36.4 · Fedora 45    │ drain: 30 min, then fail  │
 │  3 hops: v2.5.0 → v2.6.0 → v2.7.0           │ graph: k4all releases     │
 │  release notes…                             │                           │
 └─────────────────────────────────────────────┴───────────────────────────┘
```

- **Targets**: `status.availableReleases` (newer than `currentRelease`,
  blocked releases left out), newest first, with kind (minor/patch, with
  what that means), Kubernetes and Fedora (as a change from
  `status.currentReleaseInfo`) and CRI-O when it changes, the hops the
  operator plans to it (`availableReleases[].path`; no path → the button is
  disabled with "a release on the way is blocked or missing"), and the notes
  (collapsed when long). With `GraphAvailable=False` the empty list says the
  graph cannot be read instead of "nothing newer". The newest is marked latest; during an upgrade the target is
  marked and the others offer "Change target to".
- **Review dialog** (on "Upgrade to vX"): from → to with the Kubernetes and
  Fedora change, then
  1. the path, hop by hop: from → release, kind, what it changes
     (Kubernetes, Fedora, CRI-O), its notes, reboots per hop: the
     operator's own path (4.3);
  2. the node order (bootstrap, control planes, workers, one at a time);
  3. the drain: what happens (cordon and evict with PodDisruptionBudgets,
     timeout, then fail or continue), with the timeout and
     continue-on-timeout editable; editing them turns the main button into
     "Check again with these options" (a new dry run); a single node is
     only cordoned, and the options are hidden;
  4. reboots and downtime: hops × nodes reboots, a rough time
     (5-15 minutes per node and hop plus drains, labelled as an estimate),
     what goes down (single node: everything, API and dashboard included;
     one control plane: the API while it reboots; two: etcd quorum on each
     reboot), that this page loses its connection while Headlamp's node
     reboots, and that Kubernetes minor hops run kubeadm upgrade;
  5. the ClusterUpgrade changes in words, the dry-run YAML diff and the JSON
     Patch, as in Settings; a warning when a target is already set.

  "Start upgrade" needs the acknowledgement "every node reboots once per
  hop …".
- **Progress** (Progressing, Paused, Failed): the hop trail from
  `status.path` (Done ✓, InProgress spinning, Pending), overall progress
  (hops done × nodes + nodes done in the current hop), `status.message`,
  "pausing" while a paused upgrade waits for the node mid-hop, the
  guidance (4.3), and the nodes table: order, release, operator phase
  (Waiting, Draining, Upgrading, Done, Failed), host phase (PREFLIGHT …
  COMMIT, HOLD, ABANDONED, ROLLBACK_REBOOT with a tooltip of what it does),
  the Node's readiness and cordon from the core Node, how long the node's
  latest hop took (or has been running, `startedAt`/`completedAt`), and the
  drain timer (elapsed of timeout, and what happens at the timeout) or the
  node message. The hop trail shows each hop's duration the same way.
- **Actions**: Pause / Resume (`spec.paused`), Stop (clears
  `spec.targetRelease`, after a confirmation that explains the mixed
  releases it leaves and suggests Pause), Retry (the retry annotation; shown
  only for a node Failed with reason DrainTimeout or Abandoned, the only ones
  the operator retries).
- **Banners**: waiting for the operator; stopped (the message, and for a
  failed plan what its reason means: NoPath, Downgrade, NodeNotReported);
  paused; complete (since when, from the Succeeded condition); spec not
  processed yet; `GraphAvailable=False` with the error and the URL, in every
  phase.
- **How upgrades run** panel: node order, drain settings, graph; "Change"
  opens a small form for the drain timeout, continue-on-timeout and the graph
  URL (empty = k4all releases), saved through the same review.
- **Nodes** panel when no upgrade runs: the same table, with each node's
  release.

### 3.3 Settings

Tabs with a badge counting pending changes per tab; an unsaved-changes bar
slides up from the bottom (N changes, their names, Discard, Review changes).
Every row carries an apply badge: **Live** (the operator applies it),
**Install-time** (lock) or **Node file** (read by the nodes from
`/etc/k4all-config.yaml`). Changed rows get a coloured edge and a "changed" chip.

- **Features**: one card per feature with a switch, live status from
  `ClusterConfig.status.features` (Ready / Installing / Off, or "Will be
  installed/removed" while pending), the components it brings (read from the
  ReleaseManifest `featureGate`s, so it follows the release), and for
  Virtualization the emulation select, what turning it off does with the
  installed operator, and "Removal refused" with the operator's reason for
  each component whose status message starts with `uninstall refused: `,
  and "Waiting" for `waiting: `. The OVS bridge card is dashed and
  locked with "Coming with k4all-operator v0.8.0"; with that operator it
  gets a switch (4.1).
- **Ingress**: the release's ingress controller, from the ReleaseManifest
  (`traefik` active → Traefik; else `ingress-nginx` active → ingress-nginx):
  dedicated IP (validated) and default IngressClass, and a computed
  "Result:" line that mirrors the operator's hook (host ports 80/443,
  LoadBalancer on the node address, through kube-vip, or on the dedicated
  IP; both hooks follow the same rules). Clusters that kept ingress-nginx
  (a ReleaseManifest changed by hand: k4all has Traefik from v2.4.0, the
  first release with the plugin) edit `spec.ingress.nginx`, with a note that
  Traefik takes these settings over. On Traefik releases (v2.4.0+) the page
  shows and writes `spec.ingress.traefik` only, never the nginx key; while
  that key is still missing (before the operator's migration, v0.4.2 and
  later, which runs in the v2.4.0 sync) it
  shows the values Traefik inherited and the first change saves them to
  `spec.ingress.traefik`. Cilium ingress IP (only shown on Cilium clusters,
  or when set).
- **Ingresses still on the nginx class** (Ingress tab, Traefik releases): the
  cluster's Ingresses with `ingressClassName: nginx` or the
  `kubernetes.io/ingress.class: nginx` annotation, which Traefik serves
  through its ingress-nginx provider. Each row shows the hosts, how many
  annotations convert and how many cannot, and whether Helm or Argo CD
  manage it; "Switch to traefik" opens a review (5.8) and applies at once,
  outside the settings draft. The Overview's Ingress card counts them, with
  a link here.
- **Networking**: a CNI panel (read-only with "Coming with k4all-operator
  v0.8.0", a select with that operator), then on Cilium clusters switches for
  L2 announcements, Hubble, Gateway API and a chip input for devices, with
  suggestions from the interfaces the nodes report (NodeConfig status).
- **Install-time**: four read-only panels (cluster network, API endpoint,
  control plane HA, nodes) with a help tooltip giving the reason for each;
  CNI and OVS bridge carry the capability note.
- Above the tabs (plugin 0.2.0): cards linking the three v2.7.0 pages (with
  the capability chip on older operators), and the `PodNetworkOverlap`
  banner: True (warning, the operator's message: what overlaps and what to
  do) or Unknown (the check failed); False shows only the `Note: …` of its
  message, as information, when there is one (a 10.0.0.0/8 pool holding the
  service network).

### 3.4 Components

Filter (All / Needs attention / Active / Off), and "Show removed": components
with `management: Removed` (ingress-nginx from v2.4.0, kubevirt-manager from
v2.7.0) are hidden unless it is on. Categories cover the v2.7.0 components
(hangar, hangar-node-agent, k4all-metadata under Virtualization; cairn,
rook-ceph, ceph-csi-drivers, snapshot-controller under Storage). The
kubevirt-manager row says it was replaced by Hangar and what its removal
keeps while in use; its page checks each kept object on the cluster
(PriorityClasses vm-standard and vm-preemptible, CRD
images.kubevirt-manager.io, namespace kubevirt-manager: kept, removed or
unknown), since the operator only logs it (D25). A sortable, searchable table
(Headlamp's `Table`): component (with icons for "has overrides" and "re-apply
requested"), category, state pill (with the operator message as tooltip),
version (`installed → release` with the upgrade path as tooltip), management
chip, notes (why a component is off, or its failure message). "Re-apply all"
sets `force-resync: all` after a confirmation.

### 3.5 Component detail

Header with state, management chip, **Re-apply** (only Installed and Managed
components, as the operator only resyncs those) and **Management**. Banners for
a failure (full message), an inactive component (with "Open features" when a
feature gates it), Unmanaged and Removed (what they mean, including the sync
rule). Panels:

- Version: release version, installed version, last change, and the upgrade
  path as a stepper (installed → next → … → target), computed like the
  operator's `UpgradeStep`.
- Source: repo/chart/sources/image, namespace (link to Headlamp's namespace
  page), feature gate, depends on / required by (links; dependencies on
  inactive components are hidden, as the operator ignores them).
- **Your overrides** (Helm components only): Helm values as YAML and `--set`
  arguments, one per line, validated as you type, then the same review flow as
  Settings.
- Release definition (read-only, collapsed): values, helmArgs, upgradePath,
  patches, inline manifests, with a note that edits there are lost at the next
  release sync.

Management dialog: three radio cards (Managed, Unmanaged, Removed) with what
each does. Removed is disabled with the reasons when the component is
protected (k4all-operator, headlamp itself), is the active CNI, is gated by a
feature (use the feature switch), or is required by an active component; when
allowed it needs the component name typed in.

### 3.6 Node page section

On Headlamp's Node details: k4all role (bootstrap/control/worker from
NodeConfig), release (`k4all.magesgate.com/release`), upgrade phase on the
node (`upgrade-phase`, with its message in HOLD), or the hop in progress
(`upgrade-in-progress`), interfaces with MAC addresses. Hidden on non-k4all
clusters.

### 3.7 Look and feel

Built from Headlamp's CommonComponents (`Table`, `Link`, `SectionBox`) and MUI
with the Headlamp theme, so it follows light/dark mode. A small visual
vocabulary is reused everywhere: tone pills (dot or spinner + label), panels
with icon titles, setting rows (label and help left, control right, apply
badge), a segmented bar for component states, gradient icon tiles in page
headers, kind chips (minor filled, patch outlined), the hop trail, copyable
command lines. Icons are `mdi:` names; the plugin registers the 77 it uses
with Headlamp's Iconify instance (`src/icons.ts`), because Headlamp bundles
only a handful and fetches the rest from api.iconify.design, which an
air-gapped cluster cannot reach (a test keeps the list complete). All
controls carry accessible names; dialogs use RadioGroup/FormControlLabel;
destructive actions (feature off, CNI/OVS change, starting an upgrade,
stopping one) need an explicit acknowledgement or confirmation.

### 3.8 Virtualization (k4all v2.7.0)

`/k4all/settings/virtualization`, one edit session on the ClusterConfig
like Settings (same review, dry run, diff, rebase). With an operator before
v0.6.0 a notice says which operator brings the settings and the new
controls are read-only; the virt switch and emulation stay editable.

- **Virtualization** card: the Features card (switch, emulation, refused
  uninstalls and waits per component, #93's behaviour); its "turning off"
  text names only what goes (the snapshot controller stays while Rook is
  on). Next to it, **Hangar**: the node agent switch
  (`features.virt.hangar.nodeAgent`: off is written `false`, on goes back to
  the release default unless it was `true`), its component state, a link to
  Hangar.
- **KubeVirt feature gates** (`#feature-gates`): one row per gate of the
  running KubeVirt's minor (Hangar's `gateTables.ts`, copied verbatim as
  `src/model/gateTables.ts` with a header naming the Hangar commit), plus
  the gates listed in the CR, its annotations or the ClusterConfig. Columns:
  maturity (GA, Beta, Alpha, Deprecated, Discontinued, unknown), on by
  default, on now (and the state once the operator applied the draft, from
  the §7.2 merge), set by (**k4all**: in the ClusterConfig, with "not
  applied yet" until the annotation agrees; **set elsewhere**: in the CR but
  not in `k4all.magesgate.com/feature-gates` /
  `disabled-feature-gates`; none), and k4all's setting: Not set, On
  (`featureGates`), Off (`disabledFeatureGates`; disabled for GA). Turning
  one hot-plug gate on turns the other off (as Hangar does), with a notice.
  Filter: gates someone set plus Alpha/Beta (default), or all; search; a
  field to turn on a gate the tables do not know. Without a KubeVirt CR the
  release's kubevirt version picks the table. Errors (block saving): GA gate
  off, a gate in both lists, both hot-plug gates; warnings: GA or
  Discontinued entries that do nothing, gates the version does not know, a
  hot-plug rival set elsewhere (the live one wins in the operator).
- **VM state** (`#vm-state`): `vmStateStorageClass` picker (Not set by k4all
  + the StorageClasses), with where new state volumes go now and their
  access mode as KubeVirt 1.9 picks them (backend-storage: Filesystem
  volumes; the StorageProfile's Filesystem RWX, else RWO, else RWX when the
  class is set). Warnings: no such StorageClass; RWO (KubeVirt copies the
  state at each live migration, spec §7.1); no Filesystem entry in the
  StorageProfile (KubeVirt then asks for RWX Filesystem, which RBD cannot
  give: `ceph-rbd`'s seeded profile is RWX Block only).
- **Metadata service** (`#metadata`): enabled, scope (Labelled / All),
  token audiences and lifetime, vendor-data ConfigMap; an explanation of the
  opt-in label `k4all.magesgate.com/metadata: enabled`, the ServiceAccount
  label, the masquerade interface it needs, and that PodSecurity baseline
  and restricted namespaces are skipped (their VMs keep a cloud-init disk).
  Errors: lifetime under 600 s, an empty audience or the API server's own,
  a ConfigMap name that is not one. The sub-settings wait for the switch.
- Conditions `KubeVirtSettings` and `MetadataService` show when not True.

### 3.9 Node settings (k4all v2.7.0)

`/k4all/settings/nodes`: kubelet (max pods, CPU manager, reserved CPUs with
each node's CPU count, topology manager policy and scope; each "Not set by
k4all" by default) and hugepages (1Gi, 2Mi per node, with the memory per
node: capacity, hugepage bytes, share with a bar) and IOMMU. Clearing a
field removes it (and the objects it leaves empty), so k4all stops owning
it. Checks (`model/nodeSettings.ts`): max pods 10-1000, at most 250 with
Cilium (/24 per node); the static CPU manager needs reserved CPUs; reserved
CPUs must parse as a cpuset, exist on every node and leave one for pods;
hugepages over 50 % of a node warn, over 80 % are refused (the operator's
limit); a topology manager without the static CPU manager only aligns
devices (info). From 0.2.1 (k4all#111), with Virtualization on, the page
lists the KubeVirt CR as the Virtualization page does (same request, no new
RBAC): while the draft's CPU manager is static and the CR does not run
KubeVirt's `CPUManager` gate (`cpuManagerGateMissing` in `model/gates.ts`:
`gateOn` with the version's table), the CPU manager row says that VMs with
dedicated CPUs need it, with a link to `#feature-gates`. Without a CR it can
read, it says nothing.

**The plan**, shown under the form while editing and again in the review:
the action class from the changed fields (max pods only: kubelet restart,
no drain; CPU manager, reserved CPUs, topology: drain and kubelet restart;
hugepages, IOMMU: drain and reboot; the strongest wins; 0 hugepages and
IOMMU off count as absent, as the operator reads them), the nodes in the
operator's order (`nodesettings.ordered`: workers, nodes without a known
`node-type` annotation, control planes, the bootstrap node, by name; the
node running k4all-operator last of all, when its pod can be listed), per
node the drain (none,
drain, or on a single node cordon only) and what follows, nodes on a
release before v2.7.0 skipped until their hop, and what stops (single
node: the workloads). The review asks for the acknowledgement on drain
classes.

**Rollout** (when `status.nodes` or `spec.nodes` exists): phase (Idle,
Rolling, Pausing, Paused, Blocked), the current node and the message, the
`NodeSettingsRollout` condition with what to do for each reason that holds
the rollout (Invalid, UpgradeInProgress, NodeRefused, DrainBlocked,
DrainTimeout, NodesSkipped, KubeletConfigMissing, KubeletConfigUnreadable;
none for RolledOut, Rolling, Paused), nodes done of total (applied hash
equal to `settingsHash`), per node the phase (done, pending, draining,
applying, skipped) and the message: a pending node's `next: <class>` in
words, and while applying the node agent's message, `waiting: …` as
progress and anything else as a refusal.

Clearing a kubelet field is a change like any other (max pods: restart; CPU
or topology fields: drain and restart). The operator puts back what
`kube-system/kubelet-config` had before k4all first wrote the field, or
removes the field when it had none (kubelet's default: 110 pods, CPU
manager none, ...). It records those values in the ConfigMap's annotation
`k4all.magesgate.com/node-settings` (`prior`); the page reads it when the
user may, and the field's note and the review name the value it goes back
to ("250 (before k4all)", "kubelet default (110)"), else the rule. Pause / Resume write
`spec.nodes.rollout.paused` at once (a JSON Patch on the latest object,
guarded by its generation, rebuilt and sent once more on a conflict), like
Pause on the Upgrades page.

### 3.10 Storage (k4all v2.7.0)

`/k4all/settings/storage`: the Rook/Ceph card (switch, components, refused
uninstalls and waits), the `RookReady` condition, and:

- before the CephCluster exists, the creation inputs: disks
  (`storage.deviceFilter`, a regular expression, with the disks of each node
  from Hangar's node agent inventory: becomes an OSD, in use: skipped, not
  matched; "unknown" without the agent or the permission), below 3 nodes
  (`smallCluster` Refuse / Allow, with what k4all creates for the node
  count: mons, mgrs, pool size, and the no-redundancy warning);
- once it exists: "Created: manage it in Cairn", the CephClusters with
  phase and health, links to Cairn (overview, hosts and OSDs, pools), and
  the creation inputs as read-only facts that do nothing now;
- **Turning Rook off**: while a CephCluster exists the operator keeps Rook
  (the refusal as written), with the steps (Cairn: move or delete what lives
  on Ceph; delete the CephCluster with its cleanup policy if wanted; then
  the uninstall follows); k4all never wipes disks: wipe `/var/lib/rook` and
  the OSD disks by hand before turning Rook on again (D24).

## 4. Field mapping

Paths are under `ClusterConfig.spec` unless stated. "Consumer" is what acts
on the field with k4all-operator v0.4.0.

| UI control | CR path | Plugin | Consumer and effect |
|---|---|---|---|
| Virtualization switch | `features.virt.enabled` | edit | operator feature gate: installs/uninstalls kubevirt, cdi, virtctl, hangar, hangar-node-agent (Hangar, the VM console, from k4all v2.7.0; kubevirt-manager before) |
| Software emulation | `features.virt.emulation` (`auto`/`true`/`false`) | edit | operator virt hook patches KubeVirt `useEmulation` |
| Argo CD switch | `features.argocd.enabled` | edit | operator feature gate: argocd chart |
| OVS secondary networks | `features.ovsCni.enabled` | edit | operator feature gate: multus-cni, ovs-cni |
| OVS bridge | `features.ovsBridge.enabled` | read-only; edit with operator ≥ v0.8.0 | today: NodeConfig controller creates per-node NNCPs when on, never removes them; Cilium hook adds `ovs-bridge` to devices |
| CNI | `networking.cni.type` | read-only; edit with operator ≥ v0.8.0 | today: switching would re-create every pod network; kubeadm/firewall set up at install |
| Ingress dedicated IP (ingress-nginx) | `ingress.nginx.dedicatedIP` | edit (ingress-nginx releases) | ingress-nginx hook: LoadBalancer on that IP; MetalLB pool |
| Default IngressClass (ingress-nginx) | `ingress.nginx.isDefault` (always written) | edit (ingress-nginx releases) | ingress-nginx hook: `ingressClassResource.default`, host ports vs LoadBalancer |
| Traefik dedicated IP | `ingress.traefik.dedicatedIP` | edit (Traefik releases) | Traefik hook: LoadBalancer Service on that IP; MetalLB pool (`DedicatedIPs`, v0.4.0) |
| Traefik default class | `ingress.traefik.isDefault` (always written) | edit (Traefik releases) | Traefik hook: `ingressClass.isDefaultClass`, host ports vs LoadBalancer |
| (inherited) | `ingress.nginx.*` on Traefik releases | read only while `ingress.traefik` is absent | Traefik falls back to it until the operator migrates the key (v0.4.2); a change in the plugin writes `ingress.traefik` |
| Ingress class | Ingress `spec.ingressClassName`, annotations; Service annotation `traefik.ingress.kubernetes.io/service.serversscheme` | edit (Switch to traefik) | Traefik serves the Ingress as class traefik (5.8) |
| Cilium ingress IP | `ingress.cilium.dedicatedIP` | edit | MetalLB pool only; Cilium's ingress controller is not enabled by the operator (O-6) |
| L2 announcements | `networking.cni.cilium.l2announcements` | edit (Cilium) | Cilium hook values |
| Hubble | `networking.cni.cilium.hubble` | edit (Cilium) | Cilium hook values (relay + UI) |
| Gateway API | `networking.cni.cilium.gatewayAPI` | edit (Cilium) | Cilium hook values |
| Additional devices | `networking.cni.cilium.additionalDevices` | edit (Cilium) | Cilium hook `devices` (plus `ovs-bridge`) |
| firewalld | `networking.firewalld.enabled` | read-only | node scripts at install |
| Pod / service network | `cluster.podNetwork`, `cluster.serviceNetwork` | read-only | kubeadm init; Calico Installation at first install |
| API endpoint | `cluster.apiEndPointUseHostName`, `cluster.customApiEndPoint` | read-only | kubeadm certificates and kubeconfigs |
| HA | `cluster.ha.type`, `.apiControlEndpoint`, `.apiControlEndpointSubnetSize`, `.interface` | read-only | install-time VIP (keepalived/kube-vip); `type` also selects the kube-vip component and the ingress loadBalancerClass |
| Proxy | `proxy.httpProxy`, `.httpsProxy`, `.noProxy` | read-only | `setup-proxy.sh`, once per node at install, from `/etc/k4all-config.yaml`; not used in-cluster (H-3) |
| Overrides of component X | `componentOverrides.X.values`, `componentOverrides.X.helmArgs` | edit (Helm components) | operator deep-merges values over the release values, then applies helmArgs with Helm's `--set` parser |
| Management | ReleaseManifest `spec.components.X.management` | edit | operator: Managed / Unmanaged / Removed (uninstall) |
| Re-apply | ReleaseManifest annotation `k4all.magesgate.com/force-resync: X\|all` | write | operator resets Installed+Managed components to Pending and removes the annotation |
| KubeVirt gates k4all turns on / off | `features.virt.kubevirt.featureGates` / `.disabledFeatureGates` | edit (operator ≥ v0.6.0) | VirtHook merges them into the KubeVirt CR (§7.2 of the v2.7.0 spec), records them in the CR annotations |
| VM state StorageClass | `features.virt.kubevirt.vmStateStorageClass` | edit (≥ v0.6.0) | VirtHook writes the KubeVirt CR's `vmStateStorageClass` |
| Hangar node agent | `features.virt.hangar.nodeAgent` | edit (≥ v0.6.0) | `hangar-node-agent` component installed unless `false` |
| Metadata service | `features.virt.metadata.{enabled,scope,tokens.audiences,tokens.expirationSeconds,vendorDataConfigMap}` | edit (≥ v0.6.0) | `k4all-metadata` component (MutatingAdmissionPolicy) |
| Rook/Ceph | `features.rook.enabled`, `.storage.deviceFilter`, `.smallCluster` | edit (≥ v0.6.0); the inputs read-only once a CephCluster exists | rook gate: rook-ceph, ceph-csi-drivers, cairn; RookHook creates the cluster once |
| Node settings | `nodes.kubelet.{maxPods,cpuManagerPolicy,reservedSystemCPUs,topologyManagerPolicy,topologyManagerScope}`, `nodes.hugepages.{1Gi,2Mi}`, `nodes.iommu` | edit (≥ v0.6.0) | node-settings controller: `kube-system/kubelet-config`, kernel arguments, one node at a time |
| Rollout pause | `nodes.rollout.paused` | write at once (Pause / Resume) | stops before the next node |
| (status) | ClusterConfig `status.{observedGeneration,lastReconcileTime,features}` | read | applied/stale indicators, feature readiness |
| (status) | ClusterConfig `status.nodes.{settingsHash,rollout,perNode}`, conditions `PodNetworkOverlap`, `KubeVirtSettings`, `NodeSettingsRollout`, `RookReady`, `MetadataService` | read | rollout progress, banners |
| (other APIs) | KubeVirt CR (`developerConfiguration` gates, the k4all annotations, `observedKubeVirtVersion`), StorageClasses, CDI StorageProfiles, CephClusters, the operator's pod node, Hangar's node agent `inventory.json` (pods/proxy) | read, polled every 30-60 s | gates, VM state, Rook, plan order, disks |
| (status) | ReleaseManifest `status.{conditions,components}`, `spec.osImage.imageTag`, `status.resolvedOSImageTag` | read | health, states, versions, k4all release, operator version (4.1) |
| (status) | Node annotations `k4all.magesgate.com/upgrade-in-progress`, `release`, `node-type`, `upgrade-phase`, `upgrade-message` | read | hop per node, release, role, host phase and HOLD reason |
| (status) | NodeConfig `status.{nodeType,availableInterfaces}` | read | node role, device suggestions |

### 4.1 Capabilities of the installed operator

The plugin is pinned per k4all release, the operator moves with the
ReleaseManifest sync. What the plugin offers is read from the operator
version (`status.components["k4all-operator"].installedVersion`, else the
release's spec version) in one table, `src/model/capabilities.ts`:

| Capability | Since | Effect in the plugin |
|---|---|---|
| `clusterUpgrade` | v0.4.0 (k4all v2.4.0) | explains a missing ClusterUpgrade API (the API itself is detected by discovery) |
| `cniSwitch` | v0.8.0 | CNI select in Networking, change reviewed as dangerous |
| `ovsBridgeToggle` | v0.8.0 | OVS bridge switch in Features, change reviewed as dangerous |
| `virtSettings` | v0.6.0 (k4all v2.7.0) | gates, VM state, node agent, metadata on the Virtualization page |
| `nodeSettings` | v0.6.0 (k4all v2.7.0) | the Node settings page and its Pause / Resume |
| `rookStorage` | v0.6.0 (k4all v2.7.0) | the Storage page; Rook in the Overview |
| `virtUninstallGuard` | v0.5.7 (k4all v2.6.6) | turning Virtualization off is reviewed as "uninstalls once nothing runs on them" (the operator keeps KubeVirt and kubevirt-manager while VMs exist, CDI while DataVolumes or PVCs made by CDI exist); older operators are reviewed as deleting KubeVirt and CDI from under running VMs |

An unknown or unparsable version has no optional capability. Fields that
turn live carry `liveWith: <capability>` in `fields.ts`; the controls and
the review texts for them already exist. Enabling them for real therefore
needs no plugin change, only that operator v0.8.0 implements the switch on
these same fields (`networking.cni.type`, `features.ovsBridge.enabled`);
if it chooses other fields or a different flow, the paths in `fields.ts`
and the consequence texts in `changes.ts` (`LIVE_DANGER`) are the places to
adjust, before the plugin version pinned with v0.8.0 is released. (Plugin
0.1.1 gated them on v0.5.0; v0.5.0, which k4all v2.4.0 pins, does not have
them, so 0.1.2 gated them on v0.6.0; the k4all v2.7.0 spec moved the CNI
switch and the OVS bridge removal to v0.7.0, so 0.2.0 gates them there; the
k4all v2.7.2 decisions moved them to v0.8.0, so 0.3.0 gates them there.)
The v2.7.0 settings are in CRD fields older operators do not have: with
them the pages are read-only (and `fieldValidation=Strict` would refuse the
fields anyway).

### 4.2 ClusterUpgrade

`k4all.magesgate.com/v1alpha1`, cluster-scoped, one object named `k4all`
that the operator creates (v0.4.0+).

| UI | Path | Plugin | Consumer |
|---|---|---|---|
| Upgrade to / Change target | `spec.targetRelease` | write (review, dry run) | operator plans the path and drives the nodes; lowering or clearing stops after the node in progress |
| Pause / Resume | `spec.paused` (removed on resume and on start) | write | no new node starts its hop |
| Stop | `spec.targetRelease` removed (and `paused`) | write (confirmed) | stops after the node in progress |
| Drain timeout, continue on timeout | `spec.drain.{timeoutMinutes,continueOnTimeout}` | write (review) | operator's drain |
| Upgrade graph | `spec.graphUrl` (empty = default) | write (review) | operator's planner; must match the nodes' graph |
| Retry | annotation `k4all.magesgate.com/retry` (timestamp) | write (merge patch) | operator retries failed nodes and removes it |
| (status) | `phase`, `message`, `currentRelease`, `currentReleaseInfo`, `currentHop`, `path[]` (with `startedAt`/`completedAt`), `availableReleases[]` (with `minFrom`, `crio`, `path`), `nodes[]` (with `reason`, `hostPhase`, `startedAt`/`completedAt`), `graphUrl`, `observedGeneration`, `conditions` (`GraphAvailable`, `Progressing`, `Succeeded`, `Failed`) | read | all of 3.2 |

### 4.3 Upgrade logic in the plugin (`src/model/upgrades.ts`)

- **Path**: `releasePlan` takes the hops from
  `status.availableReleases[target].path`, which the operator computes with
  the planner the nodes use (never skip a minor, a release line's latest
  patch first, no blocked release); an empty path means there is no way and
  the target cannot be chosen. Each hop's details come from its own
  `availableReleases` entry.
- **What a hop changes**: Kubernetes, Fedora and CRI-O of each step against
  the previous one, starting from `status.currentReleaseInfo`.
- **Node order**: `status.nodes` sorted bootstrap, control, worker (stable);
  before the operator lists them, the Nodes (node-type annotation, NodeConfig,
  control-plane label).
- **View**: one stage per state: waiting (no phase yet), graph unreadable
  (Idle or Succeeded with `GraphAvailable=False`: not "up to date"),
  available / up to date (Idle), progressing, pausing (Progressing with `spec.paused`
  and a node still draining or upgrading), paused, failed, succeeded;
  `stale` while `observedGeneration < generation`; the graph state, the
  Failed reason and the Succeeded time come from the conditions.
- **Durations**: `startedAt`/`completedAt` of hops and nodes, "took N min"
  or "running for N min".
- **Guidance** per node, by `nodes[].reason` (never by message text; the
  message is only quoted):
  - HostHold: on the node `sudo k4all-upgrade status`,
    `sudo k4all-upgrade clear-hold && sudo k4all-upgrade resume`, or
    `sudo k4all-upgrade clear-hold --abandon`; the upgrade goes on by itself
    after a resume, so no Retry;
  - TargetRejected: the node's graph differs from the ClusterUpgrade's;
    `sudo k4all-upgrade plan`; the node tries again every minute;
  - RollbackRebooted: the new image did not boot, the node is back on the
    previous one and holds: the same commands as a HOLD;
  - Abandoned (also a hop request removed before it was done): the node
    stays on its release; Retry (drains again and asks for the hop) or Stop;
  - DrainTimeout: `kubectl get pods -A -o wide --field-selector
    spec.nodeName=<node>`, `kubectl get pdb -A`; Retry, or turn on
    continue-on-timeout and then Retry (the drain starts over for a full
    timeout); the text names pods that declare no controller among the
    causes (the drain never evicts them, operator v0.5.8) and links "Drains
    that never end" and "Pods that declare no controller" (docs/upgrades.md);
  - NodeNotReady: not a failure, the upgrade waits for that node to be Ready
    (`kubectl describe node`);
  - host phase ROLLBACK_REBOOT while it happens; any other Failed node: its
    message, `k4all-upgrade status`, no Retry;
  - the one exception to "never from message texts", for want of a reason
    (O-10): a node the operator does not cordon because its drain could
    never end (a PodDisruptionBudget that allows no disruption, k4all#87) or
    would delete pods that declare no controller (k4all#99, operator
    v0.5.8), or a drain that waits for such pods. `model/drainBlock.ts`
    reads only the phrases of the operator's shared drain
    (`drain.BlockedMessage`, `drain.Drain`): the budgets and pods it names,
    what to do (relax the budget or move the workload; delete the pods or
    recreate them under a controller), a `kubectl delete pod` per named pod,
    and the docs sections. The Node settings rollout panel shows the same
    advice for DrainBlocked.
  Retry is offered only for DrainTimeout and Abandoned. A failed plan (Failed
  condition reason NoPath, Downgrade or NodeNotReported) shows the message
  with what to do: another target, or Stop.
- **Writes** are built from the user's intent (start vX with drain options,
  settings, pause, resume, stop) on the current object: `desiredSpec` →
  `buildSpecPatch` (generation test + minimal ops). Fields the plugin does
  not touch are kept.

## 5. How edits are applied

### 5.1 Patch semantics

- **JSON Patch (RFC 6902)**, computed as the minimal diff between the object
  the user started from and the draft: per-key `add`/`remove`/`replace`
  for objects, whole-value `replace` for arrays and scalars. Fields the plugin
  does not manage are never in the patch, so unknown or newer fields survive.
- Why not merge patch: a JSON merge patch cannot set a literal `null`, and
  Helm uses `null` in values to delete a chart default. Why not apply
  (server-side apply): SSA would make the plugin the owner of every field it
  sends and conflict with `kubectl apply` users and `k4all-upgrade`'s field
  manager; a precise patch touches only what changed.
- Every write sends `fieldManager=k4all-headlamp` (visible in `managedFields`)
  and `fieldValidation=Strict` (a field the installed CRD does not know is an
  error, not silently pruned).
- Exceptions: re-apply sets the `force-resync` annotation and Retry the
  `retry` annotation, each with a JSON merge patch on that single key. A JSON
  Patch `add /metadata/annotations` would replace the whole map when the
  object had none at load time, wiping annotations someone added meanwhile.

### 5.2 Dry run and review

"Review changes" (and "Upgrade to vX", and the upgrade settings) sends the
same patch with `dryRun=All`. The API server runs defaulting, validation and
admission and returns the object it would store. The review dialog shows:

1. the changes in words, each with severity (info / warning / danger) and its
   consequence (e.g. "Uninstalls cdi, hangar, hangar-node-agent, kubevirt, virtctl
   once nothing runs on them…"), with the components a feature
   brings read from the ReleaseManifest;
2. for settings: "After saving, k4all-operator applies these components
   again": every active component with an operator hook when settings change
   (their `appliedHash` includes the whole ClusterConfig spec), or the
   overridden component; with a note when headlamp is among them (its hook
   resets the dashboard Ingress, see O-2); for an upgrade: the plan of 3.2;
3. values the server stores differently from what was sent (defaults, prunes);
4. non-blocking validation warnings;
5. a unified YAML diff of `spec`, current vs dry-run result, with folded context;
6. the JSON Patch itself (collapsed).

Danger items (turning a feature off, a CNI or OVS bridge change, starting an
upgrade) need an "I understand" checkbox before the apply button is enabled.
Apply sends the same patch without `dryRun`.

### 5.3 Concurrency and conflicts

- The first operation is `test /metadata/generation == <generation when
  editing started>`. Generation only moves on spec changes, so the operator's
  status writes (every reconcile) never cause a false conflict.
- While the draft is clean, the form follows the watch. Once edited, it keeps
  its base; a banner says when someone saved a newer generation meanwhile.
- Settings: a failed test (HTTP 422 "testing value … failed", or 409)
  triggers a three-way rebase: the latest object is fetched; each path the
  user changed is checked. If the server still holds the original value there
  (or already the user's value), the user's change is replayed on the newer
  spec and the review opens again (with a note). If both sides changed the
  same path, a conflict table shows original / saved meanwhile / yours, and
  the user keeps theirs or mine for those fields; the other side's other
  changes are kept either way.
- ClusterUpgrade: the patch is rebuilt from the same intent on the latest
  object and dry-run again; the review reopens with "the upgrade changed
  while you were choosing". Pause, resume and stop are applied at once and
  retried once on a conflict.
- Management changes test the ReleaseManifest generation too: a release sync
  between loading and clicking fails cleanly with "reload and try again".
  Re-apply and Retry only set one annotation key (merge patch) and need no
  precondition.
- Closing the dialog while a dry run, rebase or apply is in flight ends that
  attempt: late results are dropped instead of reopening the dialog (an
  applied write is still recorded, so the form does not go stale).

### 5.4 Compatibility rules baked into the draft

- `isDefault` is always written explicitly for both controllers. Operator
  v0.3.0 read a missing value as false; from v0.4.0 the CRD defaults it to
  true. Explicit values mean the same to both.
- Setting the ingress IP materializes the controller's key with both fields.
- On Traefik releases nothing is written to `ingress.nginx` (0.1.0 mirrored
  the Traefik IP there for operators before v0.4.0, which the plugin never
  meets: it ships from v2.4.0 with v0.5.0).
- Settings that are only for Cilium clusters are only offered there; a Cilium
  ingress IP on a Calico cluster is a warning.

### 5.5 Validation

Errors block "Review changes", warnings are repeated in the review:

- dedicated IPs: IPv4/IPv6 syntax (no leading zeros, no CIDR); not inside the
  pod or service network; not the control plane VIP; ingress and Cilium IPs
  differ (errors); equal to a node address (warning: leave it empty instead);
- Cilium devices: Linux interface names (1-15 chars, no space or `/`, a
  trailing `+` wildcard allowed), no duplicates (errors); `ovs-bridge` when the
  OVS bridge is on (warning: added automatically);
- emulation mode in `auto|true|false`;
- overrides: values must parse as a YAML mapping (YAML 1.2 core rules, so
  `yes`/`on` stay strings; error with line number); each helmArg must be
  `--set key=value`, `--set=key=value` or `key=value` (the operator strips
  only those prefixes; `--set-string` & co. would become bogus keys or fail
  the component); values on a non-Helm component and, for headlamp, overriding
  `initContainers`/`volumes`/`volumeMounts` (lists replace, which would drop
  this plugin) are warnings;
- upgrades: the drain timeout is a whole number ≥ 1; the graph URL is
  http(s) or empty; targets come from `availableReleases` only.

### 5.6 What survives what

| Change made in the plugin | k4all release sync (`k4all-upgrade`) | Operator |
|---|---|---|
| ClusterConfig settings and overrides | untouched (the sync only writes the ReleaseManifest) | applied on next reconcile |
| `management: Unmanaged` | kept explicitly by `merge_release_manifest` | leaves the component alone |
| `management: Removed` | not kept explicitly; the server-side apply overwrites it when the release entry sets `management` for that component (today: nmstate, ingress-nginx, k4all-operator), otherwise the plugin's field manager keeps owning it and it stays (H-2) | uninstalls |
| force-resync annotation | untouched (the sync only applies spec fields it owns) | consumed and removed |
| ClusterUpgrade spec | untouched | drives the upgrade |

The UI words the Removed caveat as "a later release can set it back"; the
server-side-apply detail comes from reading `k4all-upgrade` and should be
confirmed on the lab cluster.

### 5.7 Keeping the pages live (0.1.1)

During an upgrade the API server restarts several times (kubeadm upgrade,
the reboot) and, on a single node, Headlamp's own pod is recreated.
Headlamp's list watches then stop without an error, and its multiplexed
WebSocket reconnects only when something subscribes again: the page froze
until F5 (lab, v2.7.0 upgrade of a single node). Every k4all route is
therefore wrapped in `K4allLive` (`src/api/live.tsx`, logic in
`src/model/live.ts`):

- ClusterConfig, ReleaseManifest, NodeConfig, ClusterUpgrade and Node lists
  are watched (each watch is a small component keyed by a counter) and
  polled with plain list requests: every 10 s while an upgrade is active
  (Progressing or Paused, or a node outside Done/Pending) or the cluster
  does not answer, every 60 s otherwise.
- Per object the copy with the newer resourceVersion wins (numbers; the
  later copy when not comparable); creations and deletions follow the newer
  list. A failed watch or poll keeps the last good copy on screen.
- The watches are remounted, which subscribes them again, after a watch
  error that a new watch can fix (not 401/403/404, and not while the
  cluster is down), when the cluster answers again, when the poll found
  them behind twice in a row, and on Refresh; at most every 10 s.
- A watch reports its list only when names or resourceVersions change.
- Upgrades and Overview show "Updated N s ago" with Refresh, and "The
  cluster is not answering (for N s) … retrying every 10 s" while polls
  fail with network errors or 5xx. When Headlamp's pod comes back, the next
  poll succeeds and the watches are remounted: no reload needed, unless
  Headlamp itself asks to log in again.

### 5.8 Switching an Ingress from nginx to traefik (0.1.1)

`src/model/ingressMigration.ts`, applied by "Switch to traefik":

- `spec.ingressClassName: traefik`; the `kubernetes.io/ingress.class`
  annotation is removed (the API server refuses both).
- `nginx.ingress.kubernetes.io/force-ssl-redirect` or `ssl-redirect`
  `"true"` → `traefik.ingress.kubernetes.io/router.middlewares:
  traefik-redirect-https@kubernetescrd` (appended to existing middlewares,
  once; the Middleware is created by k4all); `"false"` is dropped.
- `backend-protocol: HTTPS` → `traefik.ingress.kubernetes.io/service.serversscheme:
  https` on every backend Service (merge patch on that key); `HTTP` is
  dropped.
- Every other `nginx.ingress.kubernetes.io/*` annotation (including other
  backend protocols) stays and has no effect any more: listed as a warning.
- Helm (managed-by label, release annotations, chart label) or Argo CD
  (tracking annotation, instance label): warning that the change must be
  made at the source, or the next upgrade or sync reverts it.
- Kept annotations or a managing tool require ticking "I understand"
  before applying. A TLS Ingress without a redirect annotation gets a note:
  ingress-nginx redirected it to HTTPS by default, Traefik does not.
- The Ingress patch is a JSON Patch guarded by its generation; everything
  is dry-run first, then the Services and the Ingress are written
  (fieldManager k4all-headlamp).

## 6. RBAC

| Action | Verbs |
|---|---|
| All pages | `get,list,watch` on `clusterconfigs`, `releasemanifests`, `nodeconfigs`, `clusterupgrades` (`k4all.magesgate.com`) and core `nodes` |
| Save settings / overrides | `patch` on `clusterconfigs` |
| Management, re-apply | `patch` on `releasemanifests` |
| Start, pause, resume, stop, retry upgrades; upgrade settings | `patch` on `clusterupgrades`, name `k4all` |
| Ingresses on the nginx class | `list,watch` on `ingresses` (`networking.k8s.io`); "Switch to traefik": `patch` on `ingresses`, and on `services` for backend-protocol HTTPS |
| v2.7.0 pages | `list` on `kubevirts` (`kubevirt.io`), `storageclasses`, `storageprofiles` (`cdi.kubevirt.io`), `cephclusters` (`ceph.rook.io`); `get` on the kubevirt-manager leftovers; saving and Pause / Resume: `patch` on `clusterconfigs` |
| Optional | `list` pods in `k4all-operator-system` (the operator's node, last in the plan), `list` pods and `get` pods/proxy in `hangar-system` (the disks Ceph would take), `get` the ConfigMap `kube-system/kubelet-config` (what a cleared kubelet field goes back to); without them the pages say "unknown" or give the rule |

The plugin asks the API server (SelfSubjectAccessReview via
`getAuthorization('patch')`, with the name `k4all` for the ClusterUpgrade)
and disables the controls with an explanation instead of failing on click.
`distribution/rbac.yaml` has `k4all-viewer`, `k4all-editor` and
`k4all-upgrader` (patch on the ClusterUpgrade `k4all` only; an upgrade
reboots every node, so it is a role of its own). k4all's default login
(`headlamp-admin` token, cluster-admin) needs none of this.

## 7. Error and edge states

| Situation | Behaviour |
|---|---|
| k4all CRDs missing (404) | one discovery request on `/apis/k4all.magesgate.com/v1alpha1` decides it at once (the list hooks would retry a 404 for seconds): "k4all-operator is not installed"; the Node section renders nothing and sends no NodeConfig request |
| ClusterUpgrade not served (operator before v0.4.0) | the same discovery lists the group's resources: the Upgrades page says "Upgrades from Headlamp need k4all-operator v0.4.0", which operator runs, that k4all v2.4.0 brings it, and `sudo k4all-upgrade run --to v2.4.0` per node meanwhile (bridge first on v2.0-v2.2.3); with an operator that should serve it, it points at the installation instead; the Overview card says the same in a line. A list without clusterupgrades is asked again on the next mount |
| ClusterUpgrade `k4all` missing | "No ClusterUpgrade yet": the operator creates it at start; `kubectl -n k4all-operator-system get pods` |
| ClusterUpgrade without status | "Waiting for k4all-operator"; targets disabled |
| Single-node cluster | review: cordon only, everything down while it reboots; drain options hidden |
| No list permission (slow path) | Headlamp's query client retries failed list requests (about 7 s) before the 403 shows; acceptable, noted |
| No list permission (403) | "No access to the k4all resources" (or "to the cluster upgrade") with the role to ask for |
| No patch permission | read-only notice, controls disabled, tooltips name the missing verb |
| No ClusterConfig / ReleaseManifest | explanation (created by `deploy-operator.sh`); Settings works without a ReleaseManifest |
| Several ClusterConfigs | warning: the operator uses the first by name; the plugin edits that one |
| Operator idle | banner after 15 minutes without a reconcile |
| Settings saved but not applied | "Applying settings" banner while `status.observedGeneration < generation`; same on the Upgrades page |
| Node upgrade hop | banner and per-node pill; the operator is paused, which the overview says |
| Node in HOLD / ABANDONED / drain timed out | guidance with commands, Retry where it helps (4.3) |
| Component failed | Overview banner, attention list, full message on the detail page |
| Dry run rejected (400/422) | message from the API server; unknown fields get "upgrade k4all first" |
| Conflict | rebase or conflict table (5.3) |
| API unreachable / 5xx | writes: "could not be reached, try again" with Retry; pages: the last known state with "The cluster is not answering … retrying", polls every 10 s, watches remounted when it answers again (5.7) |
| Watch silently stopped (API server restarted) | the poll shows newer data; after two polls ahead the watches are remounted (5.7) |
| Session expired (401) | Headlamp's own logout flow; hint in the dialog |
| Component name in URL not found | warning with a link back to the list |

## 8. Changes needed outside the plugin (proposals)

None is required for the plugin to work; each improves correctness or lets the
plugin do more. O = k4all-operator (coordinate with its session), H = k4all
host side (this repo), U = ClusterUpgrade API (before operator v0.4.0 is
tagged, if possible).

| Id | Where | Proposal | Plugin impact today |
|---|---|---|---|
| ~~O-1~~ | operator | MetalLB counts the Traefik IP. **Done** in v0.4.0 (k4all-operator#7). | mirror only for older operators (5.4) |
| **O-2** | operator `headlamp_hook.go` + H `update-routes.sh` | Dashboard routes have two owners that disagree. The headlamp hook replaces the whole Ingress spec with one rule `dashboard.<node-ip>.nip.io` on every re-apply, and any ClusterConfig change re-applies headlamp (hash). `update-routes.sh` (timer, every 10 min, `set -e`) patches `/spec/rules/1/host` first, which a one-rule Ingress does not have, so it stops before rule 0. Proposal: one owner, e.g. the hook builds both rules from the effective ingress IP and the node FQDN, and update-routes.sh only writes the MOTD. From reading the code: needs a lab check. | review dialog warns when headlamp is re-applied |
| **O-3** | operator `appliedHash` | Hash only the ClusterConfig fields each hook reads, so turning on Argo CD does not `helm upgrade` the ingress controller, Headlamp, MetalLB, Calico… | the review lists what gets re-applied |
| **O-4** | CRD (kubebuilder markers) | `format: ipv4/ipv6` (or CEL) on dedicated IPs; CEL `self == oldSelf` with a message on install-time fields (networks, API endpoint, `ha.*`), not on fields a migration rewrites | the plugin already treats them as read-only; server messages would show up in the dry run |
| **O-5** | operator status | Set `status.features.ovsBridgeReady` (declared, never written); per-component `observedGeneration` or a ReleaseManifest `status.observedGeneration` | Overview could show a sync in progress |
| **O-6** | operator `cilium_hook.go` | Enable Cilium's ingress controller when `ingress.cilium.dedicatedIP` is set; today the IP only reaches the MetalLB pool | the field is labelled "added to the MetalLB address pool" |
| **O-7** | operator v0.8.0 | CNI switch and OVS bridge on/off on the existing fields `networking.cni.type` and `features.ovsBridge.enabled` (the plugin's controls turn on by version, 4.1), with progress in status | read-only with "coming with k4all-operator v0.8.0" |
| **O-8** | operator v0.6.0 (RookHook) | The seeded `ceph-rbd` StorageProfile lists RWX Block only. KubeVirt 1.9 creates VM state (EFI/TPM) volumes in Filesystem mode and, without a Filesystem entry, asks for RWX Filesystem, which RBD cannot provide: `vmStateStorageClass: ceph-rbd` would leave such VMs Pending. A Filesystem ReadWriteOnce entry in the seeded profile fixes it (KubeVirt then copies the state on migration) | the VM state row warns |
| **O-10** | operator (ClusterUpgrade API) | A machine-readable reason for a node whose drain is blocked before the cordon (`nodes[].reason`, e.g. `DrainBlocked`, with the kind: budget or pods without a controller). Today the node stays Pending with only `drain.BlockedMessage` as its message; the enum change is an API change | the plugin reads the shared drain's phrases (4.3) |
| ~~O-9~~ | operator v0.6.0 | Activation rules of v0.6.0 (`engine.FeatureEnabled`, `shouldInstall`), mirrored in `components.ts`: gate `rook` = `features.rook.enabled`; gate `snapshots` (snapshot-controller) = virt or Rook; gate `virtMetadata` (k4all-metadata) = virt and `features.virt.metadata.enabled`; `hangar-node-agent` left out by name when `features.virt.hangar.nodeAgent` is `false`. **Done** (operator feat/270-remainders, feat/270-metadata) | the Components page and the feature cards show these states |
| ~~U-1~~ | `ReleaseInfo` | `minFrom`, `crio`, and `path` (the hops the operator would plan) in `availableReleases`. **Done** (k4all-operator 7ef70c4). | the review and the list show the operator's own path |
| ~~U-2~~ | status | `currentReleaseInfo`. **Done**. | the "from" of every change |
| ~~U-3~~ | `nodes[]` | `reason` (DrainTimeout, HostHold, Abandoned, TargetRejected, RollbackRebooted, NodeNotReady) and `hostPhase` for every node. **Done**. | guidance by reason only |
| ~~U-4~~ | retry annotation | Semantics documented on the constant: DrainTimeout and Abandoned only, the drain starts over. **Done**. | Retry offered exactly there |
| ~~U-5~~ | `path[]`, `nodes[]` | `startedAt`/`completedAt`. **Done**. | durations in the trail and the nodes table |
| ~~U-6~~ | conditions | `GraphAvailable`, `Progressing`, `Succeeded`, `Failed` with machine-readable reasons. **Done**. | graph banner, failed-plan reasons, completion time |
| ~~U-7~~ | status | An unreadable graph shows in every phase (condition and, when Idle, message). **Done**. | "graph unreadable", not "up to date" |
| **U-8** | host `k4all-upgrade` | Write `k4all.magesgate.com/upgrade-reason` (TargetRejected, RollbackRebooted) next to HOLD; until then every HOLD reaches the plugin as HostHold, and a refused target gets the generic hold guidance | handled when it appears |
| **H-1** | `k4all-upgrade` | Node annotations for release and HOLD reason. **Done** in the v2.4.0 host tool (`release`, `upgrade-phase`, `upgrade-message`). | shown on Overview, Upgrades and the Node page |
| **H-2** | `k4all-upgrade` `merge_release_manifest` | Make the Removed rule explicit: keep a cluster-side `management: Removed` unless the release changed that component's management itself | the UI warns that a release can set it back |
| **H-3** | node scripts | Proxy: read `spec.proxy` from the ClusterConfig on boot (or document it as install-time in the CRD) | read-only with explanation |
| **H-4** | bootc `Containerfile` | Pre-load the plugin image with the other images (DISTRIBUTION.md) | the first Headlamp start after a sync pulls it |

## 9. Decisions (made without asking, revisit as needed)

1. **Patch, not update; JSON Patch, not merge patch or SSA** (5.1).
2. **Precondition on `metadata.generation`, not `resourceVersion`**: status
   writes bump resourceVersion every reconcile and would make every save a
   conflict.
3. **CNI type and OVS bridge are read-only** until operator v0.8.0 (user
   decision: editable from the plugin once the operator supports it), gated
   by the installed operator version (4.1).
4. **Proxy is read-only**: the cluster resource does not reach the nodes.
5. **No ReleaseManifest value/version editing**; overrides go to
   `componentOverrides` so they survive upgrades. Values editor only for Helm
   components (the operator ignores values elsewhere).
6. **Removed is guarded**: protected components (k4all-operator, headlamp),
   the active CNI, feature-gated components (use the switch) and components
   another active one depends on cannot be removed from the plugin; others need
   the name typed.
7. **No nginx key on Traefik releases** (user decision for 0.1.1): no
   MetalLB mirror, no "move" button; inherited values are shown and the
   first change writes `spec.ingress.traefik`.
8. **Plain text editor for YAML** (monospace TextField) instead of Monaco: no
   dependency on how Headlamp configures the Monaco loader, works offline;
   validation gives line numbers. Monaco is a later nicety.
9. **YAML 1.2 core schema** for override values: `yes`/`on` stay strings.
10. **English only** for now; strings are plain so Headlamp's i18n can be added.
11. **Plugin name** `k4all-headlamp-plugin` (folder and package name), API
    `@kinvolk/headlamp-plugin` **0.14.0**, the version Headlamp v0.46.0 ships
    in its own tree (chart 0.46.0 → appVersion 0.46.0). Headlamp loads plugins
    whose declared headlamp-plugin version is `>=0.8.0-alpha.3`.
12. **License** `GPL-3.0-only` in package.json, like the k4all repo.
13. **Upgrade writes are intent-based**: a conflict rebuilds the patch from
    "target vX" on the newest object and shows the review again, instead of
    a three-way merge of a draft.
14. **Starting an upgrade lifts a pause** left in the spec: the user asked to
    go, and the review lists it.
15. **Retry only where it helps**: a hold resumes by itself on the node, so
    Retry is not offered for it.
16. **Downtime is an estimate** (5-15 minutes per node and hop plus drains),
    labelled as such; it exists to set expectations, not to schedule.
17. **Stop asks for a confirmation**, Pause does not: stopping leaves the
    nodes on two releases until the next start.
18. **`k4all-upgrader` is a role of its own** in `rbac.yaml`, limited to the
    ClusterUpgrade `k4all`.
19. **Watch plus poll, not poll only** (0.1.1): the watch keeps the page
    instant in the normal case; the poll is the safety net, every 60 s when
    nothing runs.
20. **Switching an Ingress applies at once** after its own review, outside
    the settings draft; Helm and Argo CD are only detected and warned about,
    the plugin does not touch their sources.
21. **The v2.7.0 settings live on their own pages**, each its own edit
    session on the ClusterConfig (the same save flow), not more Settings
    tabs: consoles link to stable paths and anchors, and a page shows the
    live objects its settings act on (KubeVirt CR, nodes, CephClusters).
22. **Absent means not owned**: every new control has a "Not set by k4all"
    state, and clearing a value removes the field and the objects it leaves
    empty, never an explicit empty value.
23. **Gate ownership from the annotation, maturity from Hangar's tables**,
    copied verbatim (one source for both consoles); the plugin refuses a GA
    gate in the off list, which the operator would write anyway.
24. **The node plan is predicted from the changed fields**, in the
    operator's own order (workers, control planes, the bootstrap node, the
    operator's node last); once saved the rollout shows its real state.
25. **Pause / Resume of the node rollout apply at once**, like the upgrade's,
    outside the draft.

## 10. Code layout, build, tests

```
plugin/
  package.json, package-lock.json, tsconfig.json
  src/index.tsx                     registrations (sidebar, routes, Node section)
  src/model/                        pure logic, no React, fully unit-tested
    types.ts                        CRD types (mirror of api/v1alpha1, v0.6.0)
    capabilities.ts                 what the installed operator supports
    objects.ts                      path get/set, JSON equality, JSON pointers
    patch.ts                        diff → JSON Patch, preconditions, applyOps, query
    rebase.ts                       three-way rebase and conflict resolution
    editor.ts                       edit-session reducer (base / latest / draft)
    settings.ts                     draft setters: ingress controller, Traefik
                                    (inherited values), overrides
    fields.ts                       field catalog: labels, help, live/install/node, why,
                                    liveWith capability
    validation.ts, net.ts           IP/CIDR, devices, helmArgs, YAML values
    changes.ts                      change list, consequences, re-applied components
    components.ts, semver.ts        activation (port of shouldInstall), rows,
                                    upgrade path (port of UpgradeStep), guards
    live.ts                         watch/poll merge by resourceVersion, poll
                                    interval, when to remount the watches
    ingressMigration.ts             nginx-class Ingresses and their move to traefik
    upgrades.ts                     path (operator's), view, conditions, durations,
                                    node order, drain timer, estimate, guidance by
                                    reason, ClusterUpgrade writes
    gates.ts, gateTables.ts         KubeVirt gates: tables (generated copy of
                                    Hangar's), the §7.2 merge, state, ownership
                                    from the annotations, setter, checks
    nodeSettings.ts                 action classes, the plan, hugepage math, CPU
                                    checks, the rollout view, pause
    storage.ts                      Rook view, defaults per node count, disks
                                    Ceph would take, checks
    virtSettings.ts                 VM state StorageClass and access mode,
                                    metadata service checks
    health.ts                       health headline, banners, node rows
    overrides.ts                    overrides form <-> componentOverrides
    textDiff.ts                     line diff, folding, YAML dump
    errors.ts                       API error classification
  src/icons.ts                      offline registration of the mdi icons used
  src/api/                          KubeObject classes, discovery, K4allLive (live
                                    data for every route), hooks, writes
  src/api/clusterObjects.ts         KubeVirt CR, StorageClasses, StorageProfiles,
                                    CephClusters, operator pod, agent inventories,
                                    kubevirt-manager leftovers (polled)
  src/components/                   pages and widgets (MUI + Headlamp)
    settings/editorShell.tsx        the edit session, stale notice, unsaved bar
                                    every settings page shares
    virtualization/, nodes/, storage/  the k4all v2.7.0 pages and their sections
    upgrades/                       Upgrades page, review and settings dialogs,
                                    progress, release list, Overview card, write flow
```

```bash
cd plugin
npm ci
npm run lint && npm run tsc && npm test && npm run build   # dist/main.js
```

Tests: 416 (vitest, jsdom). Plugin 0.2.0 adds model tests for the gates
(tables by version, the operator's merge, KubeVirt's on/off rules, owner
from the annotations, pending, the hot-plug pair, GA refusal), the node
settings (action classes from the changed fields, the plan and its order,
single node, skipped nodes, hugepage math, CPU and max pods checks, the
rollout view, pause), Rook (defaults per node count, created vs creation
inputs, refused turn-off and its steps, disks Ceph would take), the VM
state access mode and the metadata checks, the new component activation
rules, capabilities by operator version, the refusal/waiting prefixes, the
health banners, the change texts and the pause write (requests as sent,
one retry on a conflict); and rendering tests of every new section, the
review with the plan, the links and banners. Before: 277. The model tests cover patch generation and
application, preconditions, rebase/conflicts, the editor reducer, the
ingress controller of the release (ingress-nginx and Traefik), Traefik
inherited values and exposure, capabilities, the live data (watch or poll
by resourceVersion, membership, poll interval by phase, remounts), the move
of nginx-class Ingresses (class, redirect, backend protocol, kept
annotations, Helm/Argo CD, TLS note), Removed components hidden, overrides form round-trips
(including Helm nulls), validation (IPs, CIDRs, devices, helmArgs, YAML),
operator parity (`shouldInstall` of v0.4.0, `UpgradeStep`, semver), change
descriptions and re-applied components, health and node rows, error
classification, text diff, and the upgrade logic (the operator's path and
what each hop changes from `currentReleaseInfo`, an unreachable release,
node order, estimates, drain timer, durations, stages including an
unreadable graph, the Failed and Succeeded conditions, guidance for every
node reason and none from message texts, Retry, and the spec of every
intent). Rendering
tests (Testing Library) cover the Ingress (both controllers), Features and
Networking sections (including the capability-gated controls), the review
dialog's acknowledgement gate, the conflict table, and for upgrades the
release list (including an unreadable graph and a release without a path),
the review dialog (path, order, drain, downtime, single node, the
acknowledgement, re-checking with new drain options), the progress panel
(order, drain timer, durations, pause, stop, retry, HOLD and ABANDONED
guidance), the states without ClusterUpgrade, the Overview card, the
freshness bar, and the nginx-class Ingress list and its switch (confirmation,
dry runs before writes, Services before the Ingress). K4allLive runs against
fake watches and a fake API: a poll filling a missed update, the intervals,
remounts after an error, after falling behind, after an outage, refresh. The two save flows run against a fake
API server applying the patches (dry run then apply, rebase or rebuild on a
newer version, conflict then "keep mine", late results after closing, API
errors, pause with a conflict retried once, the retry annotation), and the
ClusterUpgrade requests are checked as sent (path, query, content type,
body). One more test checks that every icon used is registered for offline
use.

An independent review of the Headlamp integration (against the 0.14.0 lib
sources) found two bugs, both fixed: Headlamp keeps a route mounted when only
`:name` changes, so the component page is now keyed by name (otherwise unsaved
overrides of one component could be saved into the next one); and closing the
dialog during a dry run let the result reopen it. The upgrade flow uses the
same session guard.

A second independent review compared the Upgrades page with the operator's
controller (`feat/cluster-upgrade`, `decide.go`) and found that abandoned
hops and drain timeouts were told apart wrongly (fixed, and since operator
7ef70c4 read from `nodes[].reason` instead of messages), Retry was offered for failed plans
where the operator ignores it (fixed), the upgrade settings form reset on
every status write (fixed: filled when it opens), and smaller issues (a
bounded conflict loop, "Try again" on the newest object, discovery and
permissions following a cluster switch, "pausing" only with a node in
flight, the "target already set" warning only while an upgrade is active),
all fixed.

Not done: a run against a live Headlamp/cluster (planned on the lab cluster,
see DISTRIBUTION.md) with the real ClusterUpgrade controller.

## 11. Later

- An app-bar indicator while an upgrade runs (needs a cheap watch).
- Overrides editor with Monaco and the chart's values schema for completion.
- CNI switch and OVS bridge once operator v0.8.0 ships (4.1).
- Per-node groups of node settings (the v2.7.0 field names are chosen for
  them), and per-node kernel arguments in the plan from Hangar's inventory.
- Italian (and other) translations through Headlamp's i18n.
- Storybook stories for the pages with mocked resources.
