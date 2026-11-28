# The k4all section in Headlamp

From k4all v2.4.0 the Headlamp dashboard has a **k4all** section in its
sidebar. It shows the state of the cluster, runs upgrades, and changes the
common settings without editing YAML.

Open Headlamp on NodePort 32323 (`https://<node-ip>:32323/`) and log in with
the admin token. A control plane shows it at root's login (`sudo -i`), or:

```bash
kubectl get secret headlamp-admin-token -n headlamp -o jsonpath='{.data.token}' | base64 -d
```

On a cluster restored from 1.x the Secret is `admin-user`. From v2.7.2,
`sudo k4all-login-info` prints whichever one exists.

## Pages

| Page | What it is for |
|---|---|
| **Overview** | The k4all release, whether an upgrade is available or running, health, components, features, ingress, and each node with its release and upgrade phase. |
| **Upgrades** | Move every node to a newer k4all release and follow it. |
| **Settings** | Features (Virtualization, Argo CD, OVS secondary networks), ingress (dedicated IP, default IngressClass, Ingresses still on the nginx class), Cilium options. Install-time settings are shown read-only, with the reason. From v2.7.0 it links the three pages below and warns when Cilium's pod addresses overlap another network (`PodNetworkOverlap`). |
| **Virtualization** (v2.7.0) | The Virtualization switch and emulation, the KubeVirt feature gates k4all turns on or off, where the VMs' persistent EFI/TPM state lives, Hangar's node agent, the metadata service. |
| **Node settings** (v2.7.0) | Max pods, CPU manager, reserved CPUs, topology manager, hugepages, IOMMU, for every node; the plan before saving and the rollout after. |
| **Storage** (v2.7.0) | Rook/Ceph: turn it on, which disks it takes, what to do below 3 nodes; once created, Cairn manages it. |
| **Components** | Every component of the release: state, versions, Helm value overrides that survive upgrades, management (Managed, Unmanaged, Removed), re-apply. Components the release removed (such as ingress-nginx from v2.4.0, kubevirt-manager from v2.7.0) are hidden unless you turn on "Show removed"; kubevirt-manager's page lists what its removal kept because it is still in use. |

The Node page of Headlamp also gets a k4all section: role, release, upgrade
phase, network interfaces.

Every change opens a review first. The API server checks it (dry run), and
the review lists what changes and what that does to the cluster, with the
YAML diff. Nothing is saved until you apply it. If someone else changed the
same resource in the meantime, the review says so before anything is
written.

When k4all-operator keeps a component it should remove (for example
KubeVirt while VMs exist, or Rook while a Ceph cluster exists), the Overview
and the feature's switch say so with the operator's reason; the component
goes once that is gone.

The Overview and Upgrades pages say when they were last updated, with a
**Refresh** button. While the cluster does not answer, for example while
the API server or Headlamp restarts during an upgrade, they keep the last
known state, say so, and retry by themselves; you do not need to reload.

## Ingresses still on the nginx class

From v2.4.0, the release that brings the plugin, Traefik is the ingress
controller. It still serves the
Ingresses of class `nginx`, through its ingress-nginx compatibility, but
they are best moved to the `traefik` class. **Settings > Ingress** lists
them, and the Overview counts them. **Switch to traefik** sets the class and
converts what has a Traefik equivalent:

- `nginx.ingress.kubernetes.io/force-ssl-redirect` or `ssl-redirect: "true"`
  become the HTTPS redirect middleware k4all provides;
- `nginx.ingress.kubernetes.io/backend-protocol: HTTPS` moves to the
  backend Services (`traefik.ingress.kubernetes.io/service.serversscheme`).

Other nginx annotations stay and stop having an effect: the review lists
them and asks you to confirm. An Ingress that Helm or Argo CD manage must
be changed where it comes from (chart values, Git), or the next upgrade or
sync puts the nginx class back; the review says when it sees one.

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

k4all-operator does not start a drain that could never end, or would delete
pods for good; the node stays uncordoned and the page says why, with what to
do and the commands:

- a PodDisruptionBudget allows no disruption of a pod on the node (a
  single-instance database, for example): relax the budget or move the
  workload ([Drains that never end](upgrades.md#drains-that-never-end));
- pods on the node declare no controller (started with `kubectl run`, or
  by hand): nothing would recreate them after the drain. Delete them, or
  recreate them under a Deployment, StatefulSet or Job
  ([Pods that declare no controller](upgrades.md#pods-that-declare-no-controller)).

The upgrade, or the node-settings rollout, goes on by itself once they are
gone.

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

## Virtualization settings (v2.7.0)

**k4all > Virtualization** (`/k4all/settings/virtualization`; Hangar links
to it):

- **Feature gates** (`#feature-gates`): the gates of the KubeVirt version
  the cluster runs, with their maturity (GA, Beta, Alpha), whether they are
  on by default and now, and who set them: **k4all** (this page), **set
  elsewhere** (Hangar or an admin, in the KubeVirt CR), or nobody. For each
  gate choose **On** (k4all adds it, next to the others' gates), **Off**
  (k4all removes it, even where Hangar set it) or **Not set** (Hangar
  decides). GA gates are always on and cannot be turned off. Turning one of
  HotplugVolumes / DeclarativeHotplugVolumes on turns the other off.
- **VM state** (`#vm-state`): the StorageClass of the VMs' persistent EFI
  variables and TPM. Not set, the KubeVirt CR's value (Hangar) applies, else
  the default StorageClass. A ReadWriteOnce class works, but KubeVirt copies
  the state at each live migration.
- **Hangar node agent**: the privileged agent behind Hangar's Hardware tab
  and PCI passthrough; on by default with Virtualization.
- **Metadata service** (`#metadata`): VMs reach `169.254.169.254` (OpenStack
  and EC2 formats) for their instance metadata, the SSH keys of their
  `accessCredentials` and ServiceAccount tokens; the user-data served is the
  one of the VM's cloud-init volume (user-data without a cloud-init disk
  comes in a later release). With **Labelled** a VM opts in with the template label
  `k4all.magesgate.com/metadata: enabled` (Hangar's wizard sets it) and picks
  its ServiceAccount with `k4all.magesgate.com/service-account`. The VM needs
  a pod-network (masquerade) interface, and namespaces that enforce
  PodSecurity `baseline` or `restricted` are skipped: their VMs keep a
  cloud-init disk.

## Node settings (v2.7.0)

**k4all > Node settings** (`/k4all/settings/nodes`) sets the same values on
every node. Each field starts "not set by k4all": kubeadm's (or your own)
value stays until you set it. Clearing a value k4all set gives back what
`kube-system/kubelet-config` had before k4all set it (kubelet's default,
such as 110 pods, if it had none); the page names that value when it can
read it. A clear rolls out like any change: kubelet restarts for max pods,
the nodes drain for the CPU and topology settings.

| Change | What each node does |
|---|---|
| Max pods only | kubelet restarts; no drain, pods keep running |
| CPU manager, reserved CPUs, topology manager | drained, kubelet restarts with a fresh CPU manager state |
| Hugepages, IOMMU | drained, reboots with the new kernel arguments |

Before you save, the page shows the plan: the nodes in order (workers,
control planes, the bootstrap node, the node running k4all-operator last),
what each does, and what stops. On a single node nothing can move: the node is only
cordoned and the workloads stop while it restarts or reboots. The hugepages
row shows how much of each node's memory they take: keep it at 50 % or less;
k4all-operator refuses more than 80 %. Reserved CPUs must exist on every
node (each node's CPU count is shown).

VMs with dedicated CPUs (`dedicatedCpuPlacement`) need more than the static
CPU manager: KubeVirt's `CPUManager` gate too, which KubeVirt 1.9 leaves
off. Without it those VMs stay unschedulable. From addon 0.2.1, with
Virtualization on, the CPU manager row says so while the gate is off, and
links to the gates of the Virtualization page (`#feature-gates`), where you
turn it on.

After saving, the rollout goes one node at a time; **Pause** stops it before
the next node (the one in progress finishes), **Resume** goes on. It never
runs during a cluster upgrade. When it is held (a node refuses the settings,
a drain cannot evict a pod, nodes still on an older release), the page says
why and what to do.

## Storage (v2.7.0)

**k4all > Storage** (`/k4all/settings/storage`; Cairn links to it) turns
Rook/Ceph on. k4all then creates, once, a Ceph cluster on the blank disks of
the nodes (or those matching **Disks for Ceph**, a regular expression such
as `^sdb$`; with Hangar's node agent the page lists the disks that would
become OSDs), the pool `vm-pool` and the StorageClass `ceph-rbd`. Below 3
nodes it creates nothing unless **Below 3 nodes** is **Allow**, which means
no redundancy: a failed disk loses data.

Once the cluster exists the page says **Created: manage it in Cairn**:
disks, pools and daemon counts are Cairn's from then on, and the creation
inputs here do nothing.

Turning Rook off is refused while a Ceph cluster exists; the page shows the
reason and the steps (move or delete what lives on Ceph in Cairn, then
delete the CephCluster). k4all never wipes disks: before turning Rook on
again, wipe `/var/lib/rook` on every node and the disks the OSDs used.

## Settings that need a newer operator

The Virtualization, Node settings and Storage pages need k4all-operator
v0.6.0 (k4all v2.7.0); with an older operator they say so and are
read-only. Switching the CNI (Calico, Cilium) and turning the OVS bridge on
or off are read-only, marked "coming with k4all-operator v0.7.0". Once the
cluster runs that operator, the same rows become editable.

## Users other than admin

The admin token can do everything. For other users, bind one of the
ClusterRoles in `headlamp-plugin/distribution/rbac.yaml`:

| Role | Can |
|---|---|
| `k4all-viewer` | see every page (with read access to the KubeVirt CR, StorageClasses, StorageProfiles and CephClusters for the v2.7.0 pages) |
| `k4all-editor` | also change settings, overrides, management, re-apply, and switch Ingresses to traefik |
| `k4all-upgrader` | also start, pause, resume, stop and retry upgrades |

Controls a user may not use are disabled, with the reason.

## Updates of the plugin itself

The plugin is part of the k4all release, like every component: a release
that brings a new version updates Headlamp during the release sync. Reload
the page afterwards. Developer notes: `headlamp-plugin/DESIGN.md` and
`headlamp-plugin/DISTRIBUTION.md`.
