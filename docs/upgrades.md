# Upgrading k4all nodes

k4all 2.x nodes are bootc images. An upgrade switches the node to a newer
image and reboots it. Kubernetes, CRI-O and kubelet live inside the image, so
an upgrade can also change the Kubernetes version. Doing that safely needs
kubeadm, and `k4all-upgrade` takes care of it.

## TL;DR

On v2.2.4 or newer:

```bash
sudo k4all-upgrade status      # where am I, what is the policy
sudo k4all-upgrade plan        # which releases would be visited
sudo k4all-upgrade run         # do it now (reboots once per release)
```

On v2.0 – v2.2.3 (no `k4all-upgrade` yet), move to the v2.2.4 bridge first.
Do one node at a time: the bootstrap node, then the other control planes, then
the workers. On a cluster with more nodes, drain each one first and read
[Multi-node clusters](#multi-node-clusters):

```bash
curl -fsSL https://github.com/gpillon/k4all/releases/latest/download/k4all-bridge.sh \
  | sudo bash -s -- --now
```

Every release ships the script, always for the same v2.2.4 image. Without
`--now` the bridge is staged and applied on the next reboot. With `--now` the
script stages it, stops kubelet and the pods, then reboots. From the copy of
v2.6.7 each pod gets its own grace period to stop, at least 30 and at most 300
seconds (`K4ALL_POD_STOP_MAX_SECONDS`), as in a hop. Older copies give every
pod 30 seconds. The script checks the node first, and stops without
changing anything if a check fails.
It also turns off bootc's own auto-update timer (see below).

## Versions: minor and patch

| | Changes | How it is reached |
|---|---|---|
| **minor** (`v2.Y.0`) | the Kubernetes minor, the Fedora major or the CRI-O minor; replaces a platform component (e.g. the ingress controller); or carries a migration `bootc rollback` cannot undo (CRDs, the first component sync) | every minor is a mandatory stop |
| **patch** (`v2.Y.z`) | fixes, tooling, Kubernetes patches, component patches inside the same lines | patches inside a stream can be skipped |

Kubernetes never moves more than one minor per release, and never in the
same release as a Fedora major. Before it leaves a stream, a node always takes
that stream's latest patch first. If no hop reaches that patch (its `minFrom`
is a blocked release, say), the plan stops with no path instead of leaving the
stream without it. The tools of v2.6.6 and before do not make this check, so CI
refuses a graph in which a patch cannot be reached from its stream's minor
release.

The 2.x upgrade path:

| Release | What changes |
|---|---|
| v2.2.4 | bridge: `k4all-upgrade` (the same tool in every later release), bootc timer masked, script fixes (Kubernetes 1.35, CRI-O 1.32, Fedora 43 unchanged) |
| v2.3.0 | CRI-O 1.35, matching Kubernetes 1.35, plus the latest 1.35 patch; image names without a registry (`nginx:latest`) resolve on docker.io only |
| v2.4.0 | first ReleaseManifest sync: k4all-operator v0.5.0 (ClusterUpgrade: from here every upgrade can run from the Headlamp plugin), the k4all Headlamp plugin, then every cluster component pinned and updated (intermediate versions where upstream needs them); kube-vip is the host's; Traefik replaces ingress-nginx, and k4all's routes and `spec.ingress` move to Traefik |
| v2.5.0 | Fedora 45 |
| v2.6.0 | Kubernetes 1.36; ingress-nginx leaves the release manifest (v2.4.0 removed it from every cluster) |
| v2.6.1 | patch with a ReleaseManifest sync: k4all-operator v0.5.1, which fixes the cleanup of the ingress-nginx namespace; `k4all-upgrade` matches an image staged by its index digest (`indexDigest` in the graph) |
| v2.6.2 | patch: a 1.x node moves to 2.x by reinstalling with a backup (`k4all-backup.sh`, the installer's Restore), and the restored cluster keeps its components (Unmanaged); the first boot no longer hangs on Open vSwitch; same components as v2.6.1 |
| v2.6.3 | patch: the installer's layout fits RAID controllers with a large optimal I/O size (a kept disk label reuses its BIOS boot partition), and the storage spoke shows when the layout could not be applied; same components as v2.6.2 |
| v2.6.4 | patch with a ReleaseManifest sync: every node pins the kubelet's `--node-ip` to its own address (no pod-network InternalIP after ovs-bridge); k4all-operator v0.5.3: with the OVS bridge Cilium 1.20 names `ovs-bridge` in its devices (its agents start again at every boot), with KubeVirt VMs on the pod network reach ClusterIPs and DNS, with Multus secondary networks attach; it includes v0.5.2 (a component switched from Unmanaged to Managed follows its upgrade path from the version it runs); KubeVirt's operator and infra prefer control planes (the drain of a cluster's only control plane can end) |
| v2.6.5 | patch with a ReleaseManifest sync: k4all-operator v0.5.4, whose KubeVirt emulation `auto` uses KVM on the nodes that have it (before, every cluster ran its VMs in software emulation); TopoLVM's `topolvm-node` waits for lvmd's socket instead of crash-looping on a new node; a first boot without network waits for it and keeps the DHCP domain; with firewalld on, each node opens the ports of the CNI it runs (`k4all-cni-firewalld`); new clusters accept 250 pods per node; `reinstall.sh --kubernetes` refuses on 2.x and a base reinstall no longer restores a local backup or re-applies the node's files over the cluster's |
| v2.6.6 | patch with a ReleaseManifest sync: k4all-operator v0.5.7: turning Virtualization off is refused while VMs or their disks exist and otherwise lets KubeVirt and CDI uninstall themselves first (#94); KubeVirt/CDI feature gates kept on apply; a recreated TopoLVM StorageClass keeps its CDI StorageProfile (#80); no Failed status for a fresh KubeVirt/CDI (#81) or for a Helm release a stopped operator left pending; drains label their node and a budget that allows no disruption holds the hop (#86, #87); `k4all-upgrade` checks a saved plan before each hop (#73) |
| v2.6.7 | patch with a ReleaseManifest sync: before the reboot each pod gets its own grace period (at most `podStopMaxSeconds`, 300 s), so VMs shut down cleanly on single-node clusters (#98); pods that declare no controller are named before anything changes: a CLI hop stops in PREFLIGHT, and k4all-operator v0.5.8's ClusterUpgrade waits instead of deleting them (#99); both protect the hops that start from v2.6.7 |
| v2.7.0 | ReleaseManifest sync: k4all-operator v0.6.0 and the ClusterConfig settings for node settings (#60), KubeVirt gates and the VM state StorageClass, the metadata service and optional Rook/Ceph; Hangar replaces kubevirt-manager (what is still in use stays), Cairn for Ceph, the k4all addon 0.2.0 settings pages; new Cilium clusters take their pool from `podNetwork`, and `PodNetworkOverlap` reports an overlap (#72); every new field is optional, so the hop changes no setting (Kubernetes unchanged) |
| v2.7.1 | patch with a ReleaseManifest sync: k4all-operator v0.6.1: virt-operator no longer rolls out twice at each KubeVirt apply (k4all-operator#44), the empty image catalog CRD kubevirt-manager's removal left is deleted (k4all-operator#45), Rook and snapshot-controller uninstalls are no longer refused with "cannot tell" when a CRD is gone (k4all-operator#47), Cilium keeps its API server address without kube-proxy, and the first upgrade of a Helm release k4all did not write last is held instead of dropping that release's values (`ValuesDropRefused`, #114); the k4all addon 0.2.1 says on the Node settings page when dedicated CPUs for VMs lack KubeVirt's `CPUManager` gate (#111); `k4all-upgrade status` no longer calls a newer release a rollback (#112) |
| v2.7.x | patches: the cluster components made ready for Kubernetes 1.37, one at a time; v2.7.2 is upgrade readiness and remediations (k4all-operator v0.7.0) |
| v2.8.0 | Kubernetes 1.37 and CRI-O 1.37 |

Declarative `kubeadm init` and `join` (unattended join) come when they are
ready; no release is planned for them.

### How releases are cut

Every fix lands on main first, and releases are cut from main in version
order. A release therefore carries the fixes, the pinned component versions
and the operator migrations of every release before it, and no manifest sync
moves a component back to an older version. CI checks this on every path the
upgrade graph allows, target releases included. Once v2.(Y+1).0 ships, the
v2.Y stream is frozen. The only release it can still get is an exit patch:

- it fixes only the hop to v2.(Y+1).0 and changes nothing in the cluster;
- v2.(Y+1).0's `minFrom` moves up to it when the hop needs the fix;
- it shows up in the upgrade graph with the next release cut from main.

The release commit adds the release's notes as
`docs/release-notes/<version>.md` (see the README there): the release job
publishes them as the end of the GitHub release body.

A minor syncs the ReleaseManifest only when the sync is what makes it a
minor. The decision and the check are in
[ADR-0010](adr/0010-releases-come-from-main-in-version-order.md).

Publishing an exit patch, with v2.6.9 after v2.7.x as the example. The order
matters. Nodes read the upgrade graph of the Latest GitHub release, which is
the highest tag, and a published release keeps its graph. So the exit patch
reaches nodes only through the next release from main.

1. Fix the hop on main first, and merge it.
2. Branch from the tag of the stream's latest patch (`v2.6.8`) and
   cherry-pick the fix (`git cherry-pick -x`). Leave
   `k4all-release.yaml` as it is. Add v2.6.9 to `releases.yaml` with
   `syncManifest: false` and `minFrom` set to the patch before it. If no
   patch of the stream syncs, `minFrom` can be the stream's X.Y.0.
3. Tag `v2.6.9` on that branch and push the tag. The tag runs the branch's
   own release workflow, which publishes the image and the GitHub release.
   That release does not become Latest, so no node sees it yet. Only tags
   from v2.6.2 on have a safe workflow, one that gives Latest only to the
   highest tag and writes `indexDigest` (ADR-0009). So streams before 2.6
   cannot get an exit patch this way
   ([#79](https://github.com/gpillon/k4all/issues/79)).
4. On main, in the next release's PR, add the same v2.6.9 entry to
   `releases.yaml`. If the hop needs the fix, raise v2.7.0's `minFrom` to
   `v2.6.9`. CI reads v2.6.9's manifest from its tag, so the tag has to
   exist first.
5. Publish that release. It becomes Latest, and its `upgrade-graph.json` is
   the first one that gives nodes v2.6.9.

## Automatic or on command

The policy is `/etc/k4all-upgrade.yaml`. When that file is missing,
`/usr/local/share/k4all-upgrade.yaml.default` applies:

```yaml
mode: auto          # auto | manual | managed
autoAllow: patch    # patch | minor
window:
  days: [Sat]
  start: "02:30"    # node local time
  durationMinutes: 120
# podStopMaxSeconds: 300   # from v2.6.7, see below
# maxThinPoolPercent: 90   # from v2.7.2, see below
```

- `mode: auto`: `k4all-upgrade.timer` checks every 15 minutes, and inside the
  window it runs the hops that `autoAllow` permits. With the default
  (`patch`), minor releases wait for `k4all-upgrade run`. Set `autoAllow: minor`
  to run everything automatically. A patch can also sync the ReleaseManifest
  (v2.6.1 brings a new k4all-operator): that runs in the window too.
- `mode: manual`: nothing happens until you run `k4all-upgrade run`.
- `mode: managed`: the timer does nothing. Hops start only when the
  k4all-operator asks for one (see
  [Operator-driven upgrades](#operator-driven-upgrades-from-v240)), or with
  `k4all-upgrade run`.

In every mode the node also follows the k4all-operator's requests.

A plan of the timer or of `k4all-upgrade run` is saved, and its hops can wait:
with `autoAllow: minor`, the rest of a plan waits for the next window. From
v2.6.6, before a hop starts (also a hop that waited), the tool checks it on the
graph it would plan with now: the published one, or offline the image's, which
lists no later release and so changes nothing. When a release was blocked
since, a new patch now ends the stream, or a `minFrom` was raised, the plan is
made again from the committed release: toward the same target, or, for the
timer, toward the latest release when that target is gone, within `autoAllow`.
The log says `plan changed:` and why, and so does the plan's history
(`k4all-upgrade status --json`). A plan of the timer with nothing left that it
may run is dropped (`plan dropped:`). A plan of `run` whose target no path
reaches any more goes to HOLD. A hop past its preflight is never planned again.
The k4all-operator plans at every reconcile and the agent checks each hop it
asks for.

`podStopMaxSeconds` (from v2.6.7, default 300) is the most time one pod gets
to stop right before a reboot. Each pod gets its own grace period, at least
30 seconds and at most this. The pods on the pod network stop first and the
host-network ones after them, so the reboot waits at most twice this. On a single node the preflight warns about the
pods that ask for more (`k4all-upgrade status`, `Warning:`, while the hop
runs; from v2.7.2 the commit no longer keeps this advice, #119). A value that is
not a whole number stops every command until it is fixed.

`maxThinPoolPercent` (from v2.7.2, default 90) protects a node whose
`/sysroot` or `/var` sits on a thin LV, as on nodes installed by 1.x. `df`
sees only the filesystem: the thin pool under it can be almost full while
`df` shows plenty, a hop downloads an image, and a full pool takes its
filesystems down. The preflight reads the pool's data and metadata use
(`lvs`) and stops in HOLD when either is above this percentage. The HOLD names
the pool and both numbers. Free space in the pool (`fstrim --all`, which
`fstrim.timer` runs weekly from v2.7.2) or extend it (`lvextend`), then
`k4all-upgrade clear-hold && k4all-upgrade resume`. `100` turns the check off.
A value that is not a number above 0 and at most 100 stops every command until
it is fixed. Hops that start from v2.7.2 run the check; the hop into v2.7.2
runs the preflight of the release it starts from.

bootc ships its own `bootc-fetch-apply-updates.timer`, which runs
`bootc upgrade --apply`. That command would reboot a node into a new
Kubernetes minor without running kubeadm first, so k4all masks the timer.
Don't unmask it.

## What a hop does

1. **Preflight.** The node runs the release the hop starts from, and no other
   deployment is staged. There is enough space on `/sysroot` and `/var`
   and, from v2.7.2, in the thin pool under them (`maxThinPoolPercent`).
   The apiserver and all nodes are Ready. Right after a boot they may need a
   minute: on control planes the tool waits up to 5 minutes
   (`apiserverReadyTimeoutMinutes` in `/etc/k4all-upgrade.yaml`) before it
   stops in HOLD with the failed `/readyz` checks. On multi-node clusters, the
   order is respected (see below). From v2.6.6, a node that drains itself
   stops in HOLD when a PodDisruptionBudget would keep its drain from ever
   ending (see [Drains that never end](#drains-that-never-end)).
2. **Backup.** The tool runs `k4all-backup.sh` (etcd snapshot, PKI, configs)
   and copies the kubelet config to
   `/var/lib/k4all/upgrade/backup/<from>-<to>/`.
3. **Stage.** `bootc switch --download-only <image>`. It also adds the
   annotation `k4all.magesgate.com/upgrade-in-progress` on the Node, so the
   k4all-operator pauses.
4. **Pre-reboot.** Only when Kubernetes changes, the control plane is upgraded
   first: `kubeadm upgrade apply` on the bootstrap node, `kubeadm upgrade node`
   on the others. kubeadm is the binary of the staged image. The kubelet stays
   on the old version for now, which the Kubernetes version skew policy
   allows.
5. **Drain and reboot.** Control planes drain themselves; a bootstrap node
   alone in its cluster is not drained. A worker cannot drain itself: it
   waits until someone drains it (see [Multi-node clusters](#multi-node-clusters)).
   From v2.6.6 a node being drained carries the label
   `k4all.magesgate.com/draining=true` from its cordon to its uncordon: the
   k4all-operator tolerates the cordon (a single node must still run it), and
   prefers the nodes without that label, so a drain that evicts it does not
   put it back on the node that reboots.
   Right before the reboot kubelet stops, and so do the pods still on the
   node: DaemonSets, or all of them on a single node, its VMs included. From
   v2.6.7 each pod gets its own `terminationGracePeriodSeconds` to exit, at
   least 30 seconds and at most `podStopMaxSeconds` (see below). The pods on
   the pod network stop first, in parallel, while the CNI agent still runs:
   CRI-O tears a pod's network down before it stops its containers. The
   host-network pods (the CNI agent, the static pods) stop after them, in
   parallel. The reboot waits at most twice `podStopMaxSeconds`. A virt-launcher
   pod has its VMI's grace period plus 30 seconds, and its guest shuts down
   cleanly. Up to v2.6.6 every pod got 30 seconds, whatever it asked for
   ([#98](https://github.com/gpillon/k4all/issues/98)). A guest that needed
   longer lost QEMU halfway through its shutdown, as in a power cut. This
   work runs before the reboot, so the tool of the release the node leaves
   does it: a hop that starts from v2.6.6 or older still gives 30 seconds
   (see [VMs on a single node](#vms-on-a-single-node)).
6. **Post-boot.** kubelet runs the new version, the node is Ready and the
   apiserver answers. If not, the tool rolls back to the previous image once
   (`bootc rollback`) and stops in HOLD.
7. **Sync.** Only for releases that update cluster components. The
   ReleaseManifest of the new image is applied to the cluster in two steps:
   the operator first, then everything else. A failure here stops in HOLD;
   it never rolls the OS back. A component whose uninstall the operator
   refuses (from k4all-operator v0.5.7: KubeVirt with Virtualization off
   while VMs exist, its status message starts with `uninstall refused:`)
   does not hold the hop: it waits on you. The tool logs a WARNING, and
   `k4all-upgrade status` shows it with the hop.
8. **Commit.** The annotation is removed and the next hop starts.

The state of the upgrade is in `/var/lib/k4all/upgrade/state.json`.
`k4all-upgrade-resume.service` continues after every reboot.

## When something goes wrong (HOLD)

`k4all-upgrade status` shows the reason. Fix the cause, then:

```bash
sudo k4all-upgrade clear-hold
sudo k4all-upgrade resume
```

To give up the remaining hops instead, run
`sudo k4all-upgrade clear-hold --abandon`. A HOLD after the reboot keeps
the k4all-operator paused (annotation `upgrade-in-progress`). A HOLD before
the reboot leaves the cluster as it was: the operator runs again, and the
hop pauses it once more if it goes on.

A hop abandoned after its reboot leaves the node on the new release. When
that release syncs its ReleaseManifest and the node is the bootstrap node,
the sync has not run (or not to the end), and the next plan would start from
the new release without it. So the node remembers it: `status` shows a
`Sync:` line, `upgrade-message` says it, and `run`, the timer and the agent
start no hop, not even an `upgrade-done` for that release, until the sync is
done:

```bash
sudo k4all-upgrade sync-manifest
```

When the manifest reached the cluster some other way, `sudo k4all-upgrade
clear-hold --sync-done` forgets the sync instead.

## Multi-node clusters

From v2.4.0 a [ClusterUpgrade](#operator-driven-upgrades-from-v240) is the way
to upgrade a cluster with more nodes: the k4all-operator takes the nodes in
order, one at a time, drains each one and uncordons it once it is back. Set
`mode: managed` on every node and start it from the Headlamp plugin. The
bridge, v2.3.0 and v2.4.0 itself come before that operator, so they go node by
node from the command line, as below; later hops can too.

### The bridge, node by node

Move one node at a time: the bootstrap node, then the other control planes,
then the workers, each one Ready again before the next.

- The bridge reboots the node without a drain. Drain it first from a control
  plane, and uncordon it once it is Ready on v2.2.4:

  ```bash
  kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
  # on the node: k4all-bridge.sh --now
  kubectl uncordon <node>
  ```

  Right before the reboot the bridge stops kubelet and the pods left on the
  node (DaemonSets). Each gets its own grace period, from 30 to 300 seconds
  with the script of v2.6.7 or later, and 30 seconds with older copies.
- After the bridge the node has the default policy: `mode: auto`, which runs
  patch hops on its own inside the window (Saturday 02:30), on each node
  apart and in no order. On a cluster with more nodes, right after the
  bridge, on each node:

  ```bash
  printf 'mode: manual\n' | sudo tee /etc/k4all-upgrade.yaml     # hops from the CLI
  printf 'mode: managed\n' | sudo tee /etc/k4all-upgrade.yaml    # from v2.4.0, ClusterUpgrade
  ```

### Hops from the command line

Upgrade the bootstrap node first, then the other control planes, then the
workers, one at a time. What `k4all-upgrade` refuses, and what is up to you:

- On a control plane, a hop to a newer Kubernetes while the cluster
  (`kubeadm-config`) is older, and any hop while the bootstrap node is
  behind. The bootstrap node is the Node annotated
  `k4all.magesgate.com/node-type: bootstrap`, or else the one named
  `kube-bootstrap-*`. Its `k4all.magesgate.com/release` annotation says which
  release it committed last; `k4all-upgrade` publishes it from v2.2.4 (the
  agent, every minute). A bootstrap node without it (still before the
  bridge) is checked on its kubelet version only, which misses the hops that
  change no Kubernetes.
- On a worker, only a hop to a newer Kubernetes while the apiserver is older.
  A worker's `kubelet.conf` can read no other Node, so the tool cannot see
  where the bootstrap node and the control planes are: moving them first is
  up to you.
- Nothing checks that the nodes go one at a time, nor that the previous node
  is Ready again.

Every hop reboots the node, so every hop needs a drain. Control planes drain
themselves with the admin kubeconfig and uncordon after the reboot. A worker
(or a control plane without `admin.conf`) has `kubelet.conf`, which may not
evict pods: its hop waits until the node is cordoned. Drain it from a
control plane, with the label that keeps the k4all-operator off it:

```bash
kubectl label node <node> k4all.magesgate.com/draining=true
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

and the hop can start. A worker cannot read the PodDisruptionBudgets: if the
drain does not end, see [Drains that never end](#drains-that-never-end).

A wrong order and a missing drain are not a HOLD: they pass by themselves.
The hop does not start and nothing is downloaded; `k4all-upgrade status`
shows why (`Waiting:`), and so does the Node's `upgrade-message`.

- A hop of `k4all-upgrade run` that cannot start yet leaves no plan behind:
  the command says why and exits with 3; run it again once it can.
- A hop that waits in a plan goes on by itself at the next pass of the timer
  (mode `auto`, inside the window) or of the agent (while `upgrade-target`
  asks for it; if the operator gives the hop up, the plan is closed). For a
  try right now, `sudo k4all-upgrade resume`, under the same rules; a plan of
  `run` goes on only that way.
- At boot `resume` continues only hops past their reboot: a reboot for
  another reason never starts a hop that waits.

A bootstrap node without `admin.conf` cannot tell whether it is alone: it is
not drained, with a warning in the log.

The tool leaves your cordon alone, also after the reboot: once the node is
back, uncordon it and remove the label (the end of the hop reminds you):

```bash
kubectl uncordon <node>
kubectl label node <node> k4all.magesgate.com/draining-
```

### Drains that never end

A PodDisruptionBudget that allows no disruption (`disruptionsAllowed: 0`)
although all its pods are healthy refuses every eviction of its pods, so the
drain of their node never ends. The usual case is the primary of a
single-instance CloudNativePG cluster: CNPG gives it the budget
`<cluster>-primary` with `minAvailable: 1`, healthy at 1/1 and never
disruptable. A Deployment of one replica with `minAvailable: 1` does the same.
With more instances the primary budget is the same, but CNPG switches the
primary over to a replica when its node is cordoned, and the drain ends.

From v2.6.6 the drivers of a hop check this before they drain, and name each
budget and pod. Pods of DaemonSets, terminating or not running pods, and
budgets whose pods are on other nodes do not count; nor do budgets short of
healthy pods (their pods are starting: the drain waits for them), nor a CNPG
primary with a ready replica on another node.

- `k4all-upgrade` on a node that drains itself stops in HOLD in the
  preflight, before anything is downloaded:
  `the drain of <node> would never end: PDB <namespace>/<name> allows no
  disruption of pod <namespace>/<pod> ...`. Nothing was changed.
- A [ClusterUpgrade](#operator-driven-upgrades-from-v240) does not cordon
  the node, and its status message names the budget until it allows a
  disruption.
- A worker's `k4all-upgrade` cannot read the budgets; look for them before
  its drain:
  `kubectl get pdb -A` (a `0` under ALLOWED DISRUPTIONS) and
  `kubectl get pods -A -o wide --field-selector spec.nodeName=<node>`.

A single-node cluster is not drained, and is not checked.

k4all does not change a database's safety settings: whether it may be down
while its node reboots is your call. For a single-instance CloudNativePG
cluster, either let CNPG drop its budget for the hop:

```bash
kubectl -n <namespace> patch clusters.postgresql.cnpg.io <cluster> --type merge \
  -p '{"spec":{"enablePDB":false}}'
# ... the hop ...
kubectl -n <namespace> patch clusters.postgresql.cnpg.io <cluster> --type merge \
  -p '{"spec":{"enablePDB":true}}'
```

or use its maintenance window, which with `reusePVC: true` keeps the
instance on its volume (a TopoLVM volume is local: the pod waits for its
node to come back):

```bash
kubectl -n <namespace> patch clusters.postgresql.cnpg.io <cluster> --type merge \
  -p '{"spec":{"nodeMaintenanceWindow":{"inProgress":true,"reusePVC":true}}}'
# ... the hop ...
kubectl -n <namespace> patch clusters.postgresql.cnpg.io <cluster> --type merge \
  -p '{"spec":{"nodeMaintenanceWindow":{"inProgress":false}}}'
```

The database is down until the node is back. To keep it up instead, give
the cluster a replica on another node (`instances: 2`) before the hop. Then
`sudo k4all-upgrade clear-hold && sudo k4all-upgrade resume` on the node, or
wait for the ClusterUpgrade to go on by itself.

### Pods that declare no controller

A pod that no controller owns makes `kubectl drain` refuse the whole drain
(`cannot delete Pods that declare no controller (use --force to
override)`), unless you add `--force`, which deletes it. Nothing recreates
it. Examples are a pod of `kubectl run` and a `kubectl debug node/<node>`
pod left running. Up to v2.6.6:

- a ClusterUpgrade (k4all-operator v0.5.0 to v0.5.7) evicted it, and so
  deleted it, without a word;
- `k4all-upgrade` on a node that drains itself found out at DRAIN. That
  comes after STAGE and PRE_REBOOT, so the node was already cordoned, its
  image staged, and `kubeadm upgrade` already run on a hop that changes
  Kubernetes.

From v2.6.7 (k4all-operator v0.5.8,
[#99](https://github.com/gpillon/k4all/issues/99)) the drivers name such
pods before anything changes, and a hop waits instead of deleting them.
Finished pods, static pods' mirrors, DaemonSet pods and terminating pods do
not count.

- `k4all-upgrade` on a node that drains itself stops in HOLD in the
  preflight: `the drain of <node> would refuse the pods that declare no
  controller: <namespace>/<pod> ...`. Nothing was changed.
- A worker that waits for its drain names them first in `Waiting:`.
- A ClusterUpgrade does not cordon the node while it runs one, and its
  status message names them. A pod without a controller on a node already
  being drained is not evicted either: the drain waits for it until its
  timeout.

This is a change: a ClusterUpgrade that used to delete such a pod now waits
for you. Delete the pods (`kubectl delete pod -n <namespace> <pod>`), or
recreate them under a controller (a Deployment, a Job) first. Then run
`sudo k4all-upgrade clear-hold && sudo k4all-upgrade resume` on the node, or
let the ClusterUpgrade go on by itself. A single-node cluster is not drained:
kubelet starts such a pod again after the reboot. The CLI check helps the
hops that start from v2.6.7 or later
([ADR-0004](adr/0004-one-upgrade-tool-in-every-release.md)).

### VMs on a single node

A single node is not drained, so its VMs run until the reboot. From v2.6.7
each virt-launcher pod then gets its own grace period: the VMI's
`terminationGracePeriodSeconds` (KubeVirt's default is 30) plus 30 seconds,
at most `podStopMaxSeconds`. The preflight warns about the pods that ask for
more, for example a Windows VM with 3600 seconds. A hop that starts from
v2.6.6 or older gives every pod 30 seconds. On those releases, stop the VMs
with a slow shutdown yourself before the hop: `virtctl stop <vm>`, and
`virtctl start <vm>` after it. You can also set `mode: manual` and stop them
before `k4all-upgrade run`.

### Two control planes

etcd keeps a quorum only with more than half of its members. With two control
planes, etcd has two members and needs both: every reboot of a control plane
(the bridge, each hop, a `kubeadm upgrade node`) takes etcd, and so the API,
down until that node is back, also through the VIP. In the lab that was 35 to
80 seconds per reboot. Workloads keep running, but nothing can change them
meanwhile. Use one control plane or three.

### kube-vip on HA clusters

On HA clusters with kube-vip, `/etc/kubernetes/manifests/kube-vip.yaml` belongs
to the host: `setup-k8s-ph3.sh` writes it. Up to v2.2.3 the ReleaseManifest
also lists kube-vip as a component the k4all-operator manages, and operators
v0.1.x to v0.4.x apply it by writing that file with the image alone: no
`manager` argument, no settings. kube-vip exits and the API VIP is gone. They
do it whenever they apply the component: with `version: "latest"` at every
new kube-vip release, and at the latest at the first manifest sync (v2.4.0).

The bridge sets kube-vip to `management: Unmanaged` on the bootstrap node, and
every operator leaves an Unmanaged component alone; from v2.4.0 the release
manifest says the same. On a cluster that has not taken the bridge yet, do it
now, on the bootstrap node:

```bash
sudo kubectl --kubeconfig /etc/kubernetes/admin.conf patch releasemanifest k4all \
  --type merge -p '{"spec":{"components":{"kube-vip":{"management":"Unmanaged"}}}}'
```

If the VIP is already gone, `admin.conf` (which points at the VIP) does not
answer: add `--server https://<bootstrap node IP>:6443`. Then look at the
manifest:

```bash
sudo grep -c manager /etc/kubernetes/manifests/kube-vip.yaml
```

`0` means the operator rewrote it, and the bridge stops on such a node
while the VIP does not answer. Write the file again: kubelet starts kube-vip
as soon as it changes. Below is an **example**, what
`k4all-upgrade kube-vip-manifest` prints for a bootstrap node (from v2.4.0;
on v2.2.4 and v2.3.0 add `--version <tag>`, see below).
Fill in `ADDRESS` (`spec.cluster.ha.apiControlEndpoint` in
`/etc/k4all-config.yaml`), `INTERFACE` (`spec.cluster.ha.interface`; for
`auto` the device of the default route, `ip route show default`:
`ovs-bridge` on a node with the OVS bridge) and `VERSION` (the tag of the
image in the rewritten file). On a control plane other than the bootstrap
node the kubeconfig is `/etc/kubernetes/admin.conf`.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kube-vip
  namespace: kube-system
spec:
  containers:
  - name: kube-vip
    image: ghcr.io/kube-vip/kube-vip:VERSION
    imagePullPolicy: IfNotPresent
    args:
    - manager
    env:
    - name: vip_arp
      value: 'true'
    - name: port
      value: '6443'
    - name: vip_nodename
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: vip_interface
      value: INTERFACE
    - name: vip_subnet
      value: '32'
    - name: dns_mode
      value: first
    - name: cp_enable
      value: 'true'
    - name: cp_namespace
      value: kube-system
    - name: svc_enable
      value: 'true'
    - name: lb_class_only
      value: 'true'
    - name: svc_leasename
      value: plndr-svcs-lock
    - name: vip_leaderelection
      value: 'true'
    - name: vip_leasename
      value: plndr-cp-lock
    - name: vip_leaseduration
      value: '15'
    - name: vip_renewdeadline
      value: '10'
    - name: vip_retryperiod
      value: '2'
    - name: address
      value: ADDRESS
    - name: prometheus_server
      value: :2112
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
  - name: kubeconfig
    hostPath:
      path: /etc/kubernetes/super-admin.conf
```

One generator writes kube-vip's static pod on every control plane of a
cluster with `spec.cluster.ha.type: kubevip`:
`sudo k4all-upgrade kube-vip-manifest` prints it, `--write` writes it when it
differs. It reads the HA settings from the ClusterConfig when the API answers,
else from `/etc/k4all-config.yaml`, and the kube-vip version from
`/etc/k4all-release.yaml`, else from the image's release manifest. The
generator ships with `k4all-upgrade` from v2.2.4, but the release manifests
of v2.2.4 and v2.3.0 say kube-vip `latest`: there it writes nothing and says
so (`upgrade-message` during a hop), until v2.4.0 pins kube-vip. `--version
<tag>` gives it a version by hand; a new bootstrap node of v2.2.4 or v2.3.0
looks up the newest kube-vip release at install, as before, and passes it
that way. The
kubeconfig it mounts must exist: `super-admin.conf` on the bootstrap node,
else `admin.conf`; `admin.conf` on the other control planes. Without them,
or without a valid version, it writes nothing, says why and exits with 2
(`--before-init`, for the bootstrap node before `kubeadm init`, mounts the
`super-admin.conf` that init is about to write). It runs:

- on the bootstrap node at install (`setup-k8s-ph3.sh`, with
  `--before-init`: a failure stops the install), and on a control plane
  right after a join that worked (`join_cluster.sh`; `kubeadm join` wants
  the manifest directory empty);
- after the reboot of each hop, before the health checks that go through the
  VIP, and once more after them (a control plane that joined has
  `ha.type: none` in its own `/etc/k4all-config.yaml`).

What it writes:

- a manifest with the image alone is replaced, a missing one written;
- an existing k4all manifest keeps its settings and gets `cp_enable`,
  `svc_enable` and `lb_class_only`, the kube-vip version of the release
  (never an older one), the kubeconfig of the node (`super-admin.conf` on the
  bootstrap node, `admin.conf` on the others), and with `interface: auto` the
  device of today's default route;
- a `kube-vip.yaml` that cannot be read is left as it is: the hop goes on and
  says so in `upgrade-message`;
- the old file goes to `/var/lib/k4all/upgrade/backup/`.

kube-vip holds the API VIP and the LoadBalancer Services of class
`kube-vip.io/kube-vip-class` (`lb_class_only`); MetalLB takes the Services
without a class, so no address has two announcers.

## Operator-driven upgrades (from v2.4.0)

From v2.4.0 the k4all-operator can upgrade the whole cluster: set the target
release on the `ClusterUpgrade` named `k4all` (or in the Headlamp plugin). The
operator walks the hops one at a time, and for each hop one node at a time:
the bootstrap node, then the other control planes, then the workers. For each
node it cordons and drains it, then asks it for the hop through annotations on
the Node. Set `mode: managed` on these nodes, so that they never start a hop on
their own.

On each node `k4all-upgrade-agent.timer` runs `k4all-upgrade agent` every
minute and after boot (from v2.2.4; until an operator writes
`upgrade-target`, it only publishes `release` and `node-type`, and from
v2.7.2 `x86-64-level` on x86_64 nodes). The agent reads the node's own Node object, with
`/etc/kubernetes/admin.conf` on control planes and
`/etc/kubernetes/kubelet.conf` on workers. The Node name is the kubelet's
(the `system:node:<name>` client certificate).

| Annotation (`k4all.magesgate.com/…`) | Written by | Meaning |
|---|---|---|
| `upgrade-target` | operator | release of the hop this node must run now |
| `upgrade-cordoned` | operator | the operator cordoned the node; it uncordons it once the node is past the reboot (SYNC or COMMIT), or after the hop |
| `draining` (a label, from v2.6.6) | operator, node | `true` from the cordon to the uncordon (or the end of the hop): the operator's own pod prefers the other nodes |
| `release` | node | release the node runs: the last committed hop |
| `node-type` | node | `bootstrap`, `control` or `worker` (from `/etc/node-type`) |
| `upgrade-phase` | node | phase of the hop in progress (`PREFLIGHT` … `COMMIT`), `HOLD` or `ABANDONED`; absent when idle |
| `upgrade-message` | node | the reason for `HOLD` or `ABANDONED` |
| `upgrade-reason` | node | next to `HOLD`: `TargetRejected` (the target is not a legal hop) or `RollbackRebooted` (the node rolled back); absent for any other HOLD |
| `upgrade-done` | node | the target, once its hop is committed; removed when the operator removes `upgrade-target` |
| `upgrade-in-progress` | node | the pause gate, as before |
| `x86-64-level` (from v2.7.2) | node | x86_64 nodes only: the CPU's x86-64 level, `v1` to `v4`: the highest one glibc's loader reports supported (`/lib64/ld-linux-x86-64.so.2 --help`), else what the flags of `/proc/cpuinfo` add up to; found once per boot (`/run/k4all/x86-64-level`). The operator picks the cephcsi build for CPUs below x86-64-v3 from it (#121). Absent on aarch64, on nodes that run an older release, and when the node cannot tell |

When `upgrade-target` names a newer release, the agent runs that hop in any
mode, outside the window, and also when it is a minor. The node is not drained
again, and on workers the admin kubeconfig is not needed. The k4all-operator
is not scaled down either: it knows the pause gate. On the bootstrap node the
component sync and its wait happen before the commit, so before
`upgrade-done`. When the target is the release the node already runs,
`upgrade-done` is written at once.

The agent accepts only one legal hop: the release that `k4all-upgrade plan`
would visit next. A target that is older, skips a minor or the latest patch of
the stream, is blocked, or is not in the graph puts the node in `HOLD` with the
reason in `upgrade-message` and `upgrade-reason: TargetRejected`, and nothing
starts. A corrected target is picked up at the next minute.

A HOLD during the hop works as described above: after `clear-hold` and
`resume`, the operator goes on by itself. `clear-hold --abandon` also removes
`upgrade-target` and writes `upgrade-phase: ABANDONED`. The node then does not
retry on its own: retry from the operator. After a hop abandoned in SYNC on
the bootstrap node, the retry is refused (`TargetRejected`) until
`sync-manifest` has run on that node (see the HOLD section).

To see what a node reports:

```bash
kubectl get node <name> -o jsonpath='{.metadata.annotations}'
sudo journalctl -u k4all-upgrade-agent -u k4all-upgrade-resume
```

### The node that runs the operator (from v2.7.0)

From k4all-operator v0.6.0 (k4all v2.7.0) the node that runs the operator's
pod goes last among the nodes of its type. The bootstrap node still goes
first, and the workers still go after the control planes. Its drain never
counts the operator's own pod. Once every other pod has left the node, the
operator evicts its own pod, and only then asks for the hop (#97). The next
pod of its Deployment, the next leader, starts on another node: the
`draining` label keeps it off this one. It waits for the old pod to go, then
asks for the hop and drives the rest of the upgrade. Before v0.6.0 the leader
went down with that node's reboot, and nothing drove the upgrade until the
node was back.

The operator evicts itself once per drain. It does so only when another node
is Ready and schedulable, and never a pod put back on the node after the
drain started. A single node is not drained, so nothing changes there.

The node-settings rollout (next section) and a ClusterUpgrade never change two
nodes at once. A ClusterUpgrade cordons no node while a node is in its
node-settings step, and a node-settings step does not start during a
ClusterUpgrade.

## Node settings (from v2.7.0)

From k4all v2.7.0 (k4all-operator v0.6.0) the ClusterConfig sets node
settings for every node in `spec.nodes` (#60). The k4all addon writes them on
its Nodes page (`/k4all/settings/nodes`).

```yaml
spec:
  nodes:
    kubelet:
      maxPods: 250
      cpuManagerPolicy: static          # none | static
      reservedSystemCPUs: "0-1"         # required with static
      topologyManagerPolicy: single-numa-node
      topologyManagerScope: container   # container | pod
    hugepages:
      "1Gi": 4                          # pages per node; 0 or absent: none
      "2Mi": 0
    iommu: true                         # intel_iommu=on / amd_iommu=on, iommu=pt
    rollout:
      paused: false                     # stop before the next node
```

A field left out is not k4all's. k4all writes nothing for it and leaves what
kubeadm or the admin set. A cluster that moves to v2.7.0 changes nothing until
someone sets a field. Clearing a field undoes what k4all had written for it,
and only that. A kubelet field gets back the value `kubelet-config` had
before k4all first wrote it: a cluster's maxPods goes back to the 250 kubeadm
gave it, not to the kubelet's default of 110. A field that was not there
before goes again. The kernel arguments k4all added are removed. Putting a
value back is a rollout like any other, with the action class of what
changes back.

| Setting | Where k4all writes it | What the node does (action class) |
|---|---|---|
| `kubelet.maxPods` | `kube-system/kubelet-config` | `restart`: kubelet restarts; no drain |
| `kubelet.cpuManagerPolicy`, `reservedSystemCPUs`, `topologyManagerPolicy`, `topologyManagerScope` | `kube-system/kubelet-config` | `drain-restart`: drained; the CPU and memory manager state files are removed; kubelet restarts |
| `hugepages`, `iommu` | kernel arguments (`rpm-ostree kargs`) | `drain-reboot`: drained, then reboots |

`kube-system/kubelet-config` is kubeadm's KubeletConfiguration for every
node. Nodes that join later get it, and `kubeadm upgrade` keeps it. A node
does what its heaviest change needs. Only maxPods changes: a restart. Hugepages
change too: a drain and a reboot.

### Dedicated CPUs for VMs

`cpuManagerPolicy: static` is not enough for a VM with dedicated CPUs
(`dedicatedCpuPlacement: true`). Such a VM also needs KubeVirt's
`CPUManager` feature gate (#111). On KubeVirt 1.9 (k4all v2.7.x) that gate is
Alpha and off by default. Without it, virt-handler never labels the nodes
`cpumanager=true`, and the VM stays `ErrorUnschedulable` ("didn't match Pod's
node affinity/selector").

Turn the gate on in one of two ways:

- in the addon's Virtualization page, under KubeVirt feature gates
  (`/k4all/settings/virtualization#feature-gates`). From v2.7.1 the Node
  settings page says so when the static policy is set and the gate is off;
- or in the ClusterConfig:

  ```yaml
  spec:
    features:
      virt:
        kubevirt:
          featureGates: [CPUManager]
  ```

virt-handler labels the nodes within about a minute, and the VM then
schedules, pinned. Turning the gate on restarts neither KubeVirt's infra nor
running VMs.

### The rollout

The operator takes one node at a time: the workers, then the control planes,
then the bootstrap node, and the node that runs the operator last. It talks
to each node through annotations on its Node, as for upgrades
([ADR-0011](adr/0011-node-settings-roll-out-through-node-annotations.md)).

| Annotation (`k4all.magesgate.com/…`) | Written by | Meaning |
|---|---|---|
| `node-settings-target` | operator | settings hash the node must apply, written once it is drained |
| `node-settings-applied` | node | settings hash the node applied, once kubelet is Ready with it |
| `node-settings-message` | node | why the node waits (`waiting: …`) or refuses the settings (any other text); removed with `applied` |
| `node-settings-step` | operator | the node is in its step, from the cordon to the uncordon (JSON: hash, action class, who cordoned it, the drain's start) |
| `draining` (a label) | operator | from the cordon to the uncordon, as in an upgrade |

On `kube-system/kubelet-config` the operator keeps the annotation
`k4all.magesgate.com/node-settings`. It is JSON with the settings hash, the
kubelet fields k4all wrote, what each of them had before k4all first wrote
it, the hugepages and IOMMU, and the settings of older hashes some node still
has. The nodes read the kernel arguments from there.

For each node, the operator:

1. writes the settings into `kubelet-config`, the first time for these
   settings;
2. cordons and drains the node, with the drain of a ClusterUpgrade and its
   `spec.drain` (timeout, PDB settle time, `continueOnTimeout`). A single node
   is cordoned only: its workloads stop for the reboot. A `restart` needs no
   drain, so the node is not cordoned. A node whose drain could never end
   (a budget that allows no disruption) is not cordoned, as in an upgrade;
3. writes `node-settings-target`;
4. waits for `node-settings-applied` to name the target and the node to be
   Ready, then uncordons the node;
5. waits for the PodDisruptionBudgets to have their healthy pods back, at most
   the settle time, and goes on with the next node.

On the node, `k4all-upgrade agent` (every minute) sees a target other than
`applied`:

- While an upgrade hop runs on the node, it waits and says so in the message.
- It checks that `kubelet-config` carries that settings hash.
- It refuses, with a message, kernel arguments set by hand that would clash
  (hand-set hugepages, or another IOMMU value), and a CPU manager or kernel
  argument change on a node that is not cordoned.
- It runs `kubeadm upgrade node phase kubelet-config`, which writes
  `/var/lib/kubelet/config.yaml` from `kubelet-config`.
- When the CPU manager policy or the reserved CPUs change, it stops kubelet
  and removes `/var/lib/kubelet/cpu_manager_state` and
  `memory_manager_state`.
- It sets or removes only the kernel arguments it added itself. It keeps
  their list in `/etc/k4all/node-settings.json`, and a kernel argument set by
  hand is never touched.
- It restarts kubelet, or reboots when the kernel arguments changed, the same
  way a hop does: kubelet and the pods are stopped first.
- Once kubelet is Ready, it writes `node-settings-applied`.

`spec.nodes.rollout.paused: true` stops the rollout before the next node; the
node in progress finishes. Settings changed while a node drains go to that
node at once. A node that refuses the settings holds the rollout until the
cause is fixed or the settings change.

The rollout does not start a node while a ClusterUpgrade is Progressing or
Paused, or while a node runs a hop (also one started by hand). It does not
write `kubelet-config` then either. A node in its step finishes.

Nodes on a release older than v2.7.0 have no agent for the settings. They
are skipped, with a message, and get them after their upgrade. A
Kubernetes hop's kubeadm also writes `config.yaml` from `kubelet-config`.
So a node the rollout has not reached yet (paused, or older) can get new CPU
manager settings without their reset. From v2.7.0 the hop then removes the
two state files before its reboot, when kubelet and every pod are stopped.

### Status and validation

`status.nodes` of the ClusterConfig shows the rollout:

- `settingsHash`: the settings every node must have;
- `rollout.phase`: `Idle` (every node has them), `Rolling`, `Paused` or
  `Blocked`, with `currentNode` and `message`;
- `perNode`: each node's `appliedHash`, `phase` (`Done`, `Pending`,
  `Draining`, `Applying`, `Skipped`) and `message`.

The condition `NodeSettingsRollout` is True once every node has the settings.
Otherwise it is False, and its reason says why:

| Reason | Meaning |
|---|---|
| `Rolling` | the rollout is moving |
| `Paused` | `spec.nodes.rollout.paused` |
| `Invalid` | the settings do not fit a node |
| `UpgradeInProgress` | a ClusterUpgrade or a hop runs |
| `NodeRefused` | a node's agent refuses the settings |
| `DrainBlocked` | a budget that allows no disruption, or a pod that declares no controller, keeps a node's drain from ending (the message names them; see [Drains that never end](#drains-that-never-end) and [Pods that declare no controller](#pods-that-declare-no-controller)) |
| `DrainTimeout` | a drain took longer than the timeout; the node stays cordoned and the drain goes on |
| `NodesSkipped` | the nodes left are older than v2.7.0 |
| `KubeletConfigMissing` | there is no `kube-system/kubelet-config` |

The operator refuses settings that do not fit, before it writes anything, and
names the node:

- the reserved CPUs must exist on every node and leave CPUs for its pods;
- the hugepages may take at most 80 % of the smallest node's memory (the
  addon warns from 50 %);
- maxPods must fit each node's pod CIDR. That is at most 250 with Cilium's
  /24 (`cluster-pool-ipv4-mask-size` of `cilium-config`), or each node's
  `spec.podCIDR`. Calico takes its address blocks on demand, so there is no
  limit.

To follow a rollout:

```bash
kubectl get clusterconfig -o jsonpath='{.items[0].status.nodes}'
kubectl get node <name> -o jsonpath='{.metadata.annotations}'
sudo cat /etc/k4all/node-settings.json; sudo rpm-ostree kargs
```

Kernel arguments live in the OS deployment, like
`/etc/k4all/node-settings.json`. A `bootc rollback` therefore boots the
previous deployment with the kernel arguments it had. A change of kernel
arguments (hugepages, IOMMU) makes a new deployment of the same release. So
after such a change, `bootc rollback` boots the same release with the
previous kernel arguments, and the release before it can no longer be
reached by rollback. The next hop's image keeps the kernel arguments.

## Things to know

- The ReleaseManifest sync keeps `custom` and `management: Unmanaged` from the
  cluster. Any other change you made to the ReleaseManifest by hand is
  overwritten by the release.
- Every k4all release pins its k4all-operator version. A cluster gets a new
  operator only through the ReleaseManifest sync of a k4all release, never
  because a newer operator was published.
- `update-node.sh` still exists and now calls `k4all-upgrade`.
- From v2.6.4 every node pins the kubelet's `--node-ip` in
  `/etc/sysconfig/kubelet` (`KUBELET_EXTRA_ARGS`), from
  `k4all-node-ip.service` at every boot. A `--node-ip` you or a restore set
  (in that file or in `/var/lib/kubelet/kubeadm-flags.env`) stays; the one
  k4all wrote (`/var/lib/k4all/kubelet-node-ip`) follows the node when its
  address changes.
- From v2.6.4 (k4all-operator v0.5.3) Cilium gets, from the ClusterConfig:
  `devices: [ovs-bridge, ...]` with `forceDeviceDetection: true` when the OVS
  bridge is on (Cilium 1.20 skips the OVS bridge in its device detection, and
  without it an agent that starts on such a node stops with "unable to
  determine direct routing device"), `socketLB.hostNamespaceOnly: true` with
  KubeVirt (VMs on the pod network reach ClusterIPs, DNS included), and
  `cni.exclusive: false` with Multus (`features.ovsCni`). The operator does not
  restart the agents: during the v2.6.4 hop the bootstrap names ovs-bridge in
  `cilium-config` after its reboot, restarts its own agent, and after the sync
  restarts its agent and Multus again; the other nodes read the configuration
  when they reboot into the release.
- A cluster whose Cilium is `Unmanaged` (one restored from 1.x) gets none of
  this. Cilium 1.19 still detects ovs-bridge by itself; for VMs on the pod
  network it needs `socketLB.hostNamespaceOnly`, and with Multus
  `cni.exclusive=false`. Set them by hand, then restart the agents once:

  ```bash
  helm -n kube-system upgrade cilium oci://quay.io/cilium/charts/cilium \
    --version "$(helm -n kube-system get metadata cilium | awk '/^VERSION:/ {print $2}')" \
    --reuse-values --set socketLB.hostNamespaceOnly=true --set cni.exclusive=false
  kubectl -n kube-system rollout restart ds/cilium
  ```

  (`cni.exclusive=false` only where Multus runs; on Cilium 1.20 with the OVS
  bridge add `--set devices='{ovs-bridge}' --set forceDeviceDetection=true`.)
- From v2.7.1 (k4all-operator v0.6.1) such a cluster can hand Cilium to k4all
  with `spec.components.cilium.management: Managed`, without losing the
  values set by hand (#114):
  - First set what k4all has a setting for in the ClusterConfig
    (`networking.cni.cilium.l2announcements: true` for L2 announcements).
    Carry every other value of `helm get values cilium -n kube-system` you
    keep under `spec.componentOverrides.cilium.values`. Leave out
    `k8sServiceHost` and `k8sServicePort`. Without kube-proxy, k4all sets them
    from kubeadm's `controlPlaneEndpoint`, otherwise from the API server's
    advertise address. If it finds neither, Cilium is not applied and the
    message says so.
  - While k4all's values would drop or change any of the release's values,
    the release keeps running untouched. The component is Failed with `not
    taking over: revision N of the Helm release cilium was written by Helm,
    not by k4all-operator, …` and the list of those values, and the
    ReleaseManifest has the condition `ValuesDropRefused`.
  - Carry the listed values, or accept the drop of exactly revision N with
    `kubectl annotate releasemanifest k4all
    k4all.magesgate.com/allow-values-drop=cilium=N`. The chart defaults
    `routingMode: tunnel`, `tunnelProtocol: vxlan` and `k8sClientRateLimit`
    10/20 can be dropped. Never drop `l2announcements.enabled` while
    Services use L2-announced IPs: the agents stop announcing them at their
    next restart.
  - The agents read the new `cilium-config` when they start. Restart them
    once (`kubectl -n kube-system rollout restart ds/cilium
    deploy/cilium-operator`), so a missing value shows now and not at the
    next reboot.
  - The same hold applies to every Helm component whose release was last
    written outside k4all-operator.
- From v2.6.4 KubeVirt's operator and infra (virt-api, virt-controller,
  virt-exportproxy) prefer control planes instead of requiring them. Before,
  the drain of a cluster's only control plane never ended with KubeVirt on:
  their PodDisruptionBudgets (minAvailable 1) let nothing move. The hop that
  brings v2.6.4 drains with the old placement, so on such a cluster apply it
  first, on the control plane:

  ```bash
  kubectl -n kubevirt patch deployment virt-operator --type strategic -p \
    '{"spec":{"template":{"spec":{"affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":null,"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":100,"preference":{"matchExpressions":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists"}]}}]}}}}}}'
  kubectl -n kubevirt patch kubevirt kubevirt --type merge -p \
    '{"spec":{"infra":{"nodePlacement":{"affinity":{"nodeAffinity":{"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":100,"preference":{"matchExpressions":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists"}]}}]}}}}}}'
  ```

- A v2.6.x cluster with Cilium (Managed) and the OVS bridge whose agents
  already stop after a reboot (nodes NotReady) cannot start the hop (the
  preflight wants every node Ready). Name ovs-bridge first, on a control
  plane:

  ```bash
  kubectl -n kube-system patch configmap cilium-config --type merge \
    -p '{"data":{"devices":"ovs-bridge","force-device-detection":"true"}}'
  kubectl -n kube-system delete pod -l k8s-app=cilium
  ```
- From v2.6.5 (k4all-operator v0.5.4) the KubeVirt CR's `useEmulation`
  follows `features.virt.emulation`. `auto` (the default) decides from the
  nodes where virt-handler runs: `false` once a node offers KVM
  (`devices.kubevirt.io/kvm` allocatable) for 30 seconds, `true` once no node
  has offered KVM for 10 minutes. `"true"` and `"false"` apply at once. A
  manual edit of `useEmulation` in the KubeVirt CR is reverted at the next
  reconcile: change `features.virt.emulation` in the ClusterConfig instead.
  Up to v2.6.4 `auto` always turned emulation on, because the operator looked
  for `/dev/kvm` in its own pod. Running VMs keep running as they are; VMs
  started or restarted after the change use KVM, so they run only on nodes
  with KVM. To run VMs on the nodes without KVM too (software emulation), set
  `features.virt.emulation: "true"`.
- On a cluster with no KVM node, emulation turns on 10 minutes after
  virt-handler starts. A VM started in those minutes stays Pending on
  `devices.kubevirt.io/kvm` until it is restarted.
- From v2.6.5 TopoLVM's `topolvm-node` waits for lvmd's socket (init
  container `wait-for-lvmd`) instead of crash-looping on a node that joins or
  boots. The v2.6.5 manifest sync re-applies TopoLVM with the same chart:
  `topolvm-node` restarts once on every node, one node at a time; lvmd does
  not restart. A `componentOverrides.topolvm` that sets
  `node.lvmdEmbedded: true` must also set `node.initContainers: []`.
- From v2.6.5 `k4all-cni-firewalld.path` watches `/etc/cni/net.d`. When
  firewalld runs, it opens the missing ports of the CNI that runs on the node
  (Cilium, Calico or Flannel), runtime and permanent; it never closes a port
  and never reloads firewalld. Without firewalld it only logs. Existing nodes
  get their CNI's missing ports when the CNI rewrites its configuration, at
  the hop's reboot (for example 8472/udp on a Cilium node installed before
  v2.6.4).
- Clusters installed from v2.6.5 accept 250 pods per node (`maxPods` in
  `kube-system/kubelet-config`; the kubelet's default is 110). Existing
  clusters keep their `kubelet-config`. To raise the limit on one, add
  `maxPods: 250` to the `kubelet-config` ConfigMap, then on every node run
  `sudo kubeadm upgrade node phase kubelet-config` and
  `sudo systemctl restart kubelet`.
- From v2.6.6 (k4all-operator v0.5.5 and later) an apply of KubeVirt or CDI
  keeps the feature gates set on the cluster
  (`spec.configuration.developerConfiguration.featureGates` of the KubeVirt
  CR, `spec.config.featureGates` of the CDI CR): the operator applies the
  cluster's gates plus the ones upstream's CR requires. Before, every apply
  (an upgrade step, a new spec, a hop with a component change) replaced them
  with upstream's list, empty for KubeVirt. After the first apply by v0.5.5
  the operator owns the list (`managedFields`): a gate removed by hand stays
  removed, unless upstream requires it (CDI's `HonorWaitForFirstConsumer`).
  A gate lost to an apply of v0.5.4 or earlier does not come back: set it
  again. Fields upstream's CR does not set, such as `permittedHostDevices`,
  were never touched.
- From v2.6.6 (k4all-operator v0.5.6), when the operator recreates the
  `topolvm-provisioner` StorageClass for a new `volumeBindingMode` (a
  `componentOverrides.topolvm`, or TopoLVM switched from Unmanaged to
  Managed), it saves the spec of the class's CDI StorageProfile
  (`cloneStrategy`, `claimPropertySets`, ...) in the ConfigMap
  `topolvm-system/topolvm-storageprofile-saved` and puts it back on the
  profile CDI creates for the new class. Recreations done by older
  operators are not covered: see the next item.
- A cluster installed before v2.4.0 (v2.3.x or earlier) with
  Virtualization on loses the settings of its CDI StorageProfile at the hop
  to v2.4.0. Its `topolvm-provisioner` class is Immediate. v2.4.0 is a
  mandatory stop, and its manifest sync installs k4all-operator v0.5.0,
  which recreates the class as WaitForFirstConsumer without saving the
  profile: CDI creates an empty one and goes back to its defaults (for
  TopoLVM, `copy` clones instead of a `cloneStrategy` set by hand). If you
  changed the profile's spec, save it before the hop to v2.4.0 and put it
  back once the v2.4.0 sync is done (`topolvm` Installed, the class
  WaitForFirstConsumer). Only the spec goes back: the new profile has a new
  uid, so the saved object as a whole cannot be applied.
  ```sh
  # before the hop to v2.4.0
  kubectl get storageprofile topolvm-provisioner -o json | jq '{spec}' > storageprofile-spec.json
  # after the v2.4.0 sync
  kubectl patch storageprofile topolvm-provisioner --type merge --patch-file storageprofile-spec.json
  ```
  The clone strategy alone can also live on the class, where no
  recreation loses it: CDI uses the class's annotation
  `cdi.kubevirt.io/clone-strategy` (`copy`, `snapshot` or `csi-clone`)
  when the profile's spec sets no `cloneStrategy`. Set it through
  `componentOverrides.topolvm` after the v2.4.0 sync. The override's
  `storageClasses` replaces the manifest's whole list, so build it from the
  ReleaseManifest the cluster runs: a list copied from v2.3.0 would keep
  the class Immediate. An annotation is changed in place, the class is not
  recreated. The override then pins the list: compare it with the
  ReleaseManifest's after a release that changes TopoLVM's
  `storageClasses`.
  ```sh
  kubectl get releasemanifest k4all -o json | jq '{spec:{componentOverrides:{topolvm:{values:{storageClasses:
    (.spec.components.topolvm.values.storageClasses
     | map(if .name == "topolvm-provisioner"
           then .storageClass.annotations["cdi.kubevirt.io/clone-strategy"] = "csi-clone" else . end))}}}}}' > topolvm-override.json
  kubectl patch clusterconfig k4all-cluster-config --type merge --patch-file topolvm-override.json
  ```
- From v2.6.6 a fresh KubeVirt or CDI shows `Pending` ("reports no version
  yet; waiting for it") while its operator starts, instead of `Failed` until
  the next 5-minute reconcile.
- From v2.6.6 (k4all-operator v0.5.7) a Helm release left `pending-install`,
  `pending-upgrade` or `pending-rollback` by an operator that stopped in the
  middle of the operation (on a fresh install k4all moves the operator pod
  off CRI-O's bridge; an OOM kill or a node reboot does the same) is
  recovered after a minute instead of failing its component for good with
  "another operation (install/upgrade/rollback) is in progress": a first
  install's stuck record is deleted and the install adopts what it created,
  an upgrade is rolled back to the last deployed revision and done again.
  Nothing is uninstalled.
- From v2.6.6 (k4all-operator v0.5.7) turning Virtualization off
  (`features.virt.enabled: false`) is refused while VMs, VMIs, DataVolumes or
  PVCs made by CDI exist: KubeVirt, CDI and kubevirt-manager stay
  `Installed`, with "uninstall refused: <reason>" in their status and in the
  k4all addon. Without them, the operator deletes the KubeVirt and CDI CRs
  first (both carry `uninstallStrategy: BlockUninstallIfWorkloadsExist`),
  waits up to 15 minutes for their operators to remove their webhooks,
  APIServices and CRDs, and only then deletes the operators. Up to v2.6.5
  it deleted the operators first, from under running VMs; the webhooks and
  APIServices left behind blocked VM changes, the eviction of VMs during a
  drain and every namespace deletion, and the ReleaseManifest still said
  Ready. A cluster already hit: see issue #94 for the recovery, which keeps
  the VM disks.
- From v2.7.0 (k4all-operator v0.6.0) the operator never moves a component
  below the version it has installed. A release that pins a component
  lower leaves it as it runs: the component is `Failed` with "not
  downgrading: the release pins <version>, older than the installed
  <version> (...)", and the ReleaseManifest has the condition
  `DowngradeRefused`, which names the components. To allow one downgrade,
  annotate the ReleaseManifest with
  `k4all.magesgate.com/allow-downgrade: "<component>=<version>"` (entries
  separated by commas); an entry allows exactly that version, so a stale
  annotation allows nothing else. A pin that is not a version (`latest`)
  is never refused (#77).
- From v2.7.0 (k4all-operator v0.6.0) an operator that finds more
  migrations recorded on the ClusterConfig than it knows (an older
  operator after a newer one) reconciles no component. The ClusterConfig
  and the ReleaseManifest get the condition `MigrationsAhead`, the
  ReleaseManifest is not Ready, and the operator does not update itself
  either: put the newer operator back by hand (#77). The k4all-operator
  component is refused like any other, so a manifest sync that pins an
  older operator does not get Ready, and the hop stops in HOLD on the
  bootstrap node.
- From v2.7.0, a Ceph cluster that `features.rook.smallCluster: Allow`
  creates on 2 nodes, with one disk each, stays in HEALTH_WARN
  `TOO_FEW_OSDS` for good. Ceph warns while it has fewer OSDs than its
  `osd_pool_default_size`, 3 by default, although k4all's pool `vm-pool` has
  size 2 and is clean. The pool works, and `RookReady` stays True
  (`CephHealthWarn`, with the check in its message). To clear the warning,
  give the default the pool's size in the CephCluster, which k4all leaves to
  you once it is created. Pools created later then default to 2 copies too:

  ```bash
  kubectl -n rook-ceph patch cephcluster rook-ceph --type merge \
    -p '{"spec":{"cephConfig":{"global":{"osd_pool_default_size":"2"}}}}'
  ```

## Ingress: Traefik (v2.4.0)

v2.4.0 replaces ingress-nginx with Traefik. During the manifest sync of that
hop the operator uninstalls ingress-nginx, then installs Traefik on the same
LoadBalancer IP (or the same host ports). The routes are down in between.
The operator (v0.5.0) removes ingress-nginx first, then goes through the
components in dependency order, one upgrade step each: Traefik comes after
the first step of the CNI and of cert-manager, and after MetalLB,
metrics-server, nmstate and TopoLVM. Plan for some minutes without routes.
The Traefik image ships with the node image, so Traefik does not wait on a
pull.

- k4all's own routes, the Headlamp dashboard and Argo CD, use the `traefik`
  class. Where ingress-nginx had `force-ssl-redirect`, they name the
  Middleware `traefik/redirect-https` that comes with Traefik
  (`traefik.ingress.kubernetes.io/router.middlewares:
  traefik-redirect-https@kubernetescrd`). The dashboard route has a rule for
  `dashboard.<FQDN>` and one for `dashboard.<IP>.nip.io`: the IP is Traefik's
  dedicated IP, or the node's address when there is none.
- Your own Ingresses with `ingressClassName: nginx` and
  `nginx.ingress.kubernetes.io/*` annotations keep working: Traefik serves
  them through its Ingress-NGINX provider, ssl-passthrough included. The
  `nginx` IngressClass stays for them, never as the default class. Move them
  to the `traefik` class (the Headlamp plugin will have a button for that):

  | ingress-nginx | Traefik |
  |---|---|
  | `ingressClassName: nginx` | `ingressClassName: traefik` |
  | `nginx.ingress.kubernetes.io/force-ssl-redirect: "true"` | `traefik.ingress.kubernetes.io/router.middlewares: traefik-redirect-https@kubernetescrd` |
  | `nginx.ingress.kubernetes.io/backend-protocol: HTTPS` | `traefik.ingress.kubernetes.io/service.serversscheme: https` on the backend Service; Traefik verifies the backend certificate, so a self-signed one also needs a `ServersTransport` with `insecureSkipVerify` |
  | `nginx.ingress.kubernetes.io/ssl-passthrough: "true"` | an `IngressRouteTCP` with `tls.passthrough: true` |

- Settings: `spec.ingress.traefik` (`dedicatedIP`, `isDefault`) in the
  ClusterConfig. Clusters installed before v2.4.0 have `spec.ingress.nginx`
  instead, which moves to `spec.ingress.traefik` with the same values: on
  each node `k4all-migrate-config.sh` moves it in `/etc/k4all-config.yaml` at
  the first boot of v2.4.0 (the file as it was stays in
  `/etc/k4all-config.yaml.ingress-nginx.migrated`), and the k4all-operator
  moves it in the ClusterConfig during the v2.4.0 sync. Until then Traefik
  follows `spec.ingress.nginx`.
- Kickstart: `--ingress-traefik-ip`, `--no-ingress-traefik` and
  `--ingress-default=traefik|cilium`. The old `--ingress-nginx*` options are
  still accepted.
- From v2.6.0 the release manifest no longer lists `ingress-nginx`. Every
  cluster has passed v2.4.0, a mandatory stop, which uninstalled it; the
  cluster's ReleaseManifest keeps its `management: Removed` entry.
