# The k4all section in Headlamp

From k4all v2.4.0 the Headlamp dashboard has a **k4all** section in its
sidebar. It shows the state of the cluster, runs upgrades, and changes the
common settings without editing YAML.

Open Headlamp on NodePort 32323 (`https://<node-ip>:32323/`) and log in with
the admin token:

```bash
kubectl get secret admin-user -n headlamp -o jsonpath='{.data.token}' | base64 -d
```

## Pages

| Page | What it is for |
|---|---|
| **Overview** | The k4all release, whether an upgrade is available or running, health, components, features, ingress, and each node with its release and upgrade phase. |
| **Upgrades** | Move every node to a newer k4all release and follow it. |
| **Settings** | Features (Virtualization, Argo CD, OVS secondary networks), ingress (dedicated IP, default IngressClass), Cilium options. Install-time settings are shown read-only, with the reason. |
| **Components** | Every component of the release: state, versions, Helm value overrides that survive upgrades, management (Managed, Unmanaged, Removed), re-apply. |

The Node page of Headlamp also gets a k4all section: role, release, upgrade
phase, network interfaces.

Every change opens a review first. The API server checks it (dry run), and
the review lists what changes and what that does to the cluster, with the
YAML diff. Nothing is saved until you apply it. If someone else changed the
same resource in the meantime, the review says so before anything is
written.

## Upgrading the cluster

From v2.4.0 every k4all upgrade can be run from **k4all > Upgrades**. The
k4all-operator moves the nodes one at a time: the bootstrap node, then the
other control planes, then the workers. Each release on the way is one *hop*;
every node reboots once per hop. A hop never skips a minor release, and a
node takes the latest patch of its release line before moving to the next
one (see [upgrades.md](upgrades.md)).

1. **Choose a release.** The page lists the releases the cluster can move
   to, newest first: whether it is a minor or a patch, its Kubernetes and
   Fedora versions, its notes, and the hops it takes from where you are. If
   k4all-operator cannot read the upgrade graph, the page says so instead of
   "up to date".
2. **Review.** The review shows the path hop by hop and what each hop
   changes, the node order, how nodes are drained, and how many reboots and
   how much downtime to expect. You can change the drain timeout and whether
   a node goes ahead when its drain times out. Tick the box and start.
3. **Follow it.** The page shows the hop in progress, each node's phase
   (waiting, draining, upgrading, done), what `k4all-upgrade` is doing on
   the node (staging, rebooting, syncing…), how long each hop and node took,
   and how long the current drain has left.

While the node that runs Headlamp reboots, the page loses its connection. It
comes back when the node is up; reload it if it does not.

**Pause** stops the upgrade before the next node; the node in progress
finishes its hop. **Resume** goes on. **Stop** clears the target: the node in
progress finishes, and the nodes already upgraded stay on their release until
you start again. Prefer Pause for a break.

### Draining

On a cluster with more than one node, each node is cordoned and its pods are
evicted before its hop, respecting PodDisruptionBudgets. If that takes longer
than the drain timeout (30 minutes by default), the node fails and the
upgrade waits; or, with "continue when the drain times out", the hop runs
anyway and the pods left on the node stop when it reboots.

A single-node cluster is only cordoned: its workloads, the Kubernetes API and
the dashboard are down while it reboots.

### When a node gets stuck

The page explains what happened and what to run. Commands to run on a node
need `ssh` to it and `sudo`.

- **On hold**: `k4all-upgrade` on the node stopped the hop and waits for you.
  Find the cause with `sudo k4all-upgrade status`, fix it, then
  `sudo k4all-upgrade clear-hold && sudo k4all-upgrade resume`. The upgrade
  continues by itself. To give up the hop on that node instead:
  `sudo k4all-upgrade clear-hold --abandon`, then **Retry** or **Stop**.
- **Refused the hop**: the node plans on a different upgrade graph than the
  cluster. The graph in
  the upgrade settings must be the one in `/etc/k4all-upgrade.yaml` on the
  nodes.
- **Rolled back**: the new image did not start, so the node went back to the
  previous one and holds; the same commands as for a hold.
- **Abandoned**: the hop was given up on the node. **Retry** drains the node
  again and asks it for the hop.
- **Waiting for a node to be Ready**: not an error; the next node starts once
  every node is Ready.
- **Drain did not finish**: find the pods left on the node
  (`kubectl get pods -A -o wide --field-selector spec.nodeName=<node>`) and
  the PodDisruptionBudgets that hold them, move or delete them, then
  **Retry**. Or turn on "continue when the drain times out" in the upgrade
  settings, then **Retry**: the drain starts over and, at the timeout, the
  hop runs anyway.
- **The upgrade stopped without a stuck node** (for example a target older
  than the cluster, or a node without the k4all-upgrade annotations): the
  page shows k4all-operator's message. Choose another target, or **Stop**.

### Before v2.4.0

Clusters on older releases have no upgrades from Headlamp; the page says so.
Upgrade each node with `sudo k4all-upgrade run --to v2.4.0`, the bootstrap
node first, as in [upgrades.md](upgrades.md). Nodes on v2.0 – v2.2.3 take the
v2.2.4 bridge first.

## Settings that need a newer operator

Switching the CNI (Calico, Cilium) and turning the OVS bridge on or off are
read-only for now, marked "coming with k4all-operator v0.5.0". Once the
cluster runs that operator, the same rows become editable.

## Users other than admin

The admin token can do everything. For other users, bind one of the
ClusterRoles in `headlamp-plugin/distribution/rbac.yaml`:

| Role | Can |
|---|---|
| `k4all-viewer` | see every page |
| `k4all-editor` | also change settings, overrides, management, re-apply |
| `k4all-upgrader` | also start, pause, resume, stop and retry upgrades |

Controls a user may not use are disabled, with the reason.

## Updates of the plugin itself

The plugin is part of the k4all release, like every component: a release
that brings a new version updates Headlamp during the release sync. Reload
the page afterwards. Developer notes: `headlamp-plugin/DESIGN.md` and
`headlamp-plugin/DISTRIBUTION.md`.
