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
curl -fsSL https://github.com/gpillon/k4all/releases/download/v2.2.4/k4all-bridge.sh \
  | sudo bash -s -- --now
```

Without `--now` the bridge is staged and applied on the next reboot. With
`--now` the script stages it, stops kubelet and the pods (30 seconds each at
most), then reboots. The script checks the node first, and stops without
changing anything if a check fails.
It also turns off bootc's own auto-update timer (see below).

## Versions: minor and patch

| | Changes | How it is reached |
|---|---|---|
| **minor** (`v2.Y.0`) | the Kubernetes minor, the Fedora major or the CRI-O minor; replaces a platform component (e.g. the ingress controller); or carries a migration `bootc rollback` cannot undo (CRDs, the first component sync) | every minor is a mandatory stop |
| **patch** (`v2.Y.z`) | fixes, tooling, Kubernetes patches, component patches inside the same lines | patches inside a stream can be skipped |

Kubernetes never moves more than one minor per release, and never in the
same release as a Fedora major. Before it leaves a stream, a node always takes
that stream's latest patch first.

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
| v2.7.0 | unattended join: `kubeadm init` and `join` become declarative (Kubernetes unchanged) |
| v2.8.0 | cluster components ready for Kubernetes 1.37 (once upstream supports it) |
| v2.9.0 | Kubernetes 1.37 |

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

bootc ships its own `bootc-fetch-apply-updates.timer`, which runs
`bootc upgrade --apply`. That command would reboot a node into a new
Kubernetes minor without running kubeadm first, so k4all masks the timer.
Don't unmask it.

## What a hop does

1. **Preflight.** The node runs the release the hop starts from, and no other
   deployment is staged. There is enough space on `/sysroot` and `/var`.
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
   Right before the reboot kubelet stops and every pod still on the node
   (DaemonSets, or all of them on a single node) gets 30 seconds to exit, so
   a pod with a long grace period cannot hold the shutdown.
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
  node (DaemonSets), 30 seconds each at most.
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
`upgrade-target`, it only publishes `release` and `node-type`). The agent reads the node's own Node object, with
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
retry on its own: retry from the operator.

To see what a node reports:

```bash
kubectl get node <name> -o jsonpath='{.metadata.annotations}'
sudo journalctl -u k4all-upgrade-agent -u k4all-upgrade-resume
```

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
  operators (the v2.4.0 hop, Immediate to WaitForFirstConsumer) are not
  covered: note the profile's spec before that hop.
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
