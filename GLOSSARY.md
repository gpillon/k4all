# k4all

k4all builds Kubernetes clusters from a bootable OS image and keeps them
upgraded, from each node's OS to the components in the cluster. These are
the words for its releases, for how nodes and clusters move between them,
and for the cluster objects the operator reconciles.

## Releases

**Release**:
A published k4all version, `vX.Y.Z`: an OS image together with the component versions it pins. Unqualified, "release", "minor" and "patch" are k4all's, never Kubernetes' or the operator's.
_Avoid_: version, build, image (for the release as a whole)

**Stream**:
All the releases that share `vX.Y`, from the minor release that opens it to its latest patch.
_Avoid_: release line, series

**Minor release**:
The `vX.Y.0` release that opens a stream. It carries a change that no node may skip.
_Avoid_: major, feature release

**Patch release**:
A later release inside a stream. A patch may be skipped, and never crosses a minor.
_Avoid_: hotfix, point release

**Frozen stream**:
A stream whose next minor release has shipped. It gets no more releases, except an exit patch.
_Avoid_: old stream, maintenance branch, end-of-life stream

**Exit patch**:
A patch of a frozen stream that fixes only the hop out of it, and keeps the release manifest of the patch before it.
_Avoid_: bridge patch (the bridge release is v2.2.4), backport

**Mandatory stop**:
A release that no path may skip. Every minor release is one.
_Avoid_: checkpoint, milestone

**Release ladder**:
The mandatory stops of the 2.x line in order, which every existing cluster climbs, from the bridge release to the newest release.
_Avoid_: upgrade path (a path is one node's)

**Bridge release**:
The release that nodes too old for the upgrade tool reach with a one-off script. In 2.x it is v2.2.4, for nodes on v2.0 to v2.2.3.
_Avoid_: "bridge" alone (also the OVS bridge, and CRI-O's bridge network)

**Upgrade graph**:
The published list of every release with what reaching it takes: the oldest release that can hop to it, its kind, and whether it is blocked. The nodes and the operator plan from the same graph.
_Avoid_: release graph, release list

**Blocked release**:
A release withdrawn from the upgrade graph: no path picks it.
_Avoid_: withdrawn, yanked, deprecated release

**Sync release**:
A release whose hop ends with a manifest sync, which applies the release's own ReleaseManifest to the cluster.
_Avoid_: syncing release, "sync" alone

## Moving a node

**Host**:
What a node runs outside the cluster's control: the OS image, its scripts and the upgrade tool. Its counterpart in the cluster is the operator.
_Avoid_: node OS, machine

**Upgrade tool**:
The program on each node that plans that node's hops and runs them.
_Avoid_: updater, update script

**Upgrade agent**:
The part of the upgrade tool that keeps the node's reports to the cluster current and takes the operator's hop requests.
_Avoid_: "agent" alone

**Hop**:
One node moving from its committed release to the next release on its path, with one image switch and one reboot.
_Avoid_: step, jump, "upgrade" for a single hop

**Path**:
The hops, in order, from a release to a target release, as the planner draws them from the upgrade graph.
_Avoid_: route, ladder (the ladder is the whole line)

**Target release**:
The release where a plan or a ClusterUpgrade ends.
_Avoid_: "target" for a hop request, which names only the next hop

**Plan**:
The path a node has set out on, kept on the node until its last hop commits or it is abandoned. The node starts it itself in auto mode, or a person does, or a hop request does.
_Avoid_: job, schedule, "mode" for who started it

**Committed release**:
The release a node last finished a hop to, or was installed with. During a hop it stays the release the hop started from, even after the reboot.
_Avoid_: current release, running release

**Upgrade mode**:
A node's policy for starting hops on its own: auto (inside the maintenance window), manual (only on command) or managed (the operator drives the upgrades). Hop requests are followed in every mode.
_Avoid_: update policy, "mode" for a plan's origin

**Maintenance window**:
The weekly span in which a node in auto mode starts hops on its own: patches only, unless minors are allowed too.
_Avoid_: schedule, update window

**Waiting**:
A hop that cannot start yet, because a node that goes first is behind or the node is not drained yet, and that starts by itself once it can. It is not a HOLD.
_Avoid_: blocked (a blocked release is something else), stuck

**HOLD**:
A hop stopped for a person: nothing more happens until someone clears it, then resumes or abandons the plan.
_Avoid_: failed, stuck, paused

**Abandon**:
Giving up the rest of a plan from a HOLD: the node stays on its committed release and does not retry on its own.
_Avoid_: cancel, abort

**Rollback**:
Returning a node to the image it ran before a hop. The upgrade tool does it once on its own, when the new image is not healthy after the reboot, and then holds. It never undoes what a hop did to the cluster.
_Avoid_: downgrade (no path goes to an older release)

## The cluster

**Operator**:
The k4all-operator: the controller in the cluster that installs and upgrades the components of the ReleaseManifest, applies the ClusterConfig and runs ClusterUpgrades. Its counterpart on each node is the host.
_Avoid_: controller (alone)

**Component**:
One piece of cluster software listed in the ReleaseManifest, such as the CNI, the ingress controller, or the operator itself.
_Avoid_: addon, app, package

**ReleaseManifest**:
The cluster's list of components, with each one's pinned version, source and management policy. Each release's image carries the release's own, which the manifest sync merges into the cluster's.
_Avoid_: release file, BOM, component list

**Management policy**:
How the operator treats a component: **Managed** (it installs and upgrades it), **Unmanaged** (it leaves it alone, because someone else owns it) or **Removed** (it uninstalls it). A component that a newer release no longer lists is left as it is, not Removed.
_Avoid_: ignored, disabled, deleted

**Component upgrade path**:
The intermediate versions a component must pass through, one per reconcile, on its way to its pinned version.
_Avoid_: "path" alone (a path goes through releases), stepping

**Manifest sync**:
Applying a release's ReleaseManifest to the cluster, done by the bootstrap node before its hop to that release commits: the operator alone first, then the whole manifest.
_Avoid_: "sync" alone, resync (the operator re-applying a component)

**Operator migration**:
A one-time, forward-only change the operator makes to the ClusterConfig or to cluster objects, once the ReleaseManifest reaches the release that needs it. Migrations are numbered and run in order.
_Avoid_: "migration" for moving a cluster to a newer release (that is an upgrade)

**ClusterConfig**:
The cluster's settings: features, networking, ingress, HA, and overrides of component values. First written at install; the operator applies it.
_Avoid_: cluster spec, k4all config

**ClusterUpgrade**:
The one cluster-wide request to bring every node to a target release. The operator walks the path one hop at a time, and each hop one node at a time.
_Avoid_: rolling upgrade, cluster update

**Hop request**:
The operator asking one node for one hop, by naming that hop's release. The node accepts only the hop its own planner would take next.
_Avoid_: "target" (the target release is where the whole upgrade ends)

**Operator-driven hop**:
A hop a node runs because of a hop request: in any upgrade mode, outside the maintenance window, minors included, with the drain done by the operator.
_Avoid_: managed hop

**Pause gate**:
The mark a node carries during its hop, which keeps the operator from reconciling components while any node has it.
_Avoid_: "pause" alone (pausing a ClusterUpgrade only keeps new nodes from starting), lock

**Node type**:
A node's k4all role, fixed at install: bootstrap (the control plane that created the cluster), control (any other control plane) or worker.
_Avoid_: role (Kubernetes' control-plane role covers both bootstrap and control), node kind

**Bootstrap node**:
The control plane that created the cluster. It goes first in every hop, and it is the only node that runs the manifest sync.
_Avoid_: master, first node, primary
