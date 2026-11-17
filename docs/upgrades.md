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
Do one node at a time, control planes first:

```bash
curl -fsSL https://github.com/gpillon/k4all/releases/download/v2.2.4/k4all-bridge.sh \
  | sudo bash -s -- --now
```

Without `--now` the bridge is staged and applied on the next reboot. The script
checks the node first, and stops without changing anything if a check fails.
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
| v2.2.4 | bridge: `k4all-upgrade`, bootc timer masked, script fixes (Kubernetes 1.35, CRI-O 1.32, Fedora 43 unchanged) |
| v2.3.0 | CRI-O 1.35, matching Kubernetes 1.35, plus the latest 1.35 patch |
| v2.4.0 | cluster components updated and pinned; first ReleaseManifest sync |
| v2.5.0 | Fedora 45 |
| v2.6.0 | Traefik replaces ingress-nginx |
| v2.7.0 | Kubernetes 1.36 |
| v2.8.0 | Kubernetes 1.37 |

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
  to run everything automatically.
- `mode: manual`: nothing happens until you run `k4all-upgrade run`.
- `mode: managed`: the k4all-operator drives the upgrade (multi-node rollouts);
  the timer does nothing.

bootc ships its own `bootc-fetch-apply-updates.timer`, which runs
`bootc upgrade --apply`. That command would reboot a node into a new
Kubernetes minor without running kubeadm first, so k4all masks the timer.
Don't unmask it.

## What a hop does

1. **Preflight.** The node runs the release the hop starts from, and no other
   deployment is staged. There is enough space on `/sysroot` and `/var`.
   The apiserver and all nodes are Ready. On multi-node clusters, the order is
   respected (see below).
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
5. **Drain and reboot.** Single-node clusters are not drained.
6. **Post-boot.** kubelet runs the new version, the node is Ready and the
   apiserver answers. If not, the tool rolls back to the previous image once
   (`bootc rollback`) and stops in HOLD.
7. **Sync.** Only for releases that update cluster components. The
   ReleaseManifest of the new image is applied to the cluster in two steps:
   the operator first, then everything else. A failure here stops in HOLD;
   it never rolls the OS back.
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
`sudo k4all-upgrade clear-hold --abandon`. While a node is in HOLD, the
k4all-operator stays paused.

## Multi-node clusters

Upgrade the bootstrap node first, then the other control planes, then the
workers, one at a time. `k4all-upgrade` refuses the wrong order:

- a worker does not move to a newer Kubernetes until the apiserver runs it;
- a control plane does not move until the bootstrap node has upgraded the
  cluster.

A kubelet minor upgrade needs a drain, which requires the admin kubeconfig. On
workers without it, the hop stops and asks you to drain the node from a control
plane. The k4all-operator will drive multi-node rollouts (`mode: managed`)
before the first Kubernetes minor release (v2.7.0).

With only two control planes, every control-plane reboot loses the etcd
quorum. Use one or three.

## Things to know

- The ReleaseManifest sync keeps `custom` and `management: Unmanaged` from the
  cluster. Any other change you made to the ReleaseManifest by hand is
  overwritten by the release.
- `update-node.sh` still exists and now calls `k4all-upgrade`.
