# One upgrade tool from the bridge on; releases differ only in data

A hop is run by two tools, one on each side of its reboot. Up to the reboot
(PREFLIGHT, BACKUP, STAGE, PRE_REBOOT with the Kubernetes hooks and
`kubeadm upgrade apply`, DRAIN), it runs with the `k4all-upgrade` of the
release the node is leaving. After the reboot, `k4all-upgrade-resume.service`
starts the tool of the image the node has just booted. That tool runs the
health checks, the manifest sync and the commit. So whatever runs before the
reboot has to ship before the release that needs it: the planner, the agent
that answers ClusterUpgrade, STAGE and the hooks for the Kubernetes minor a
hop enters. That is why the bridge release v2.2.4 carries the whole tool:
planner, hop phases, manifest sync, the agent, the kube-vip generator and the
hooks for Kubernetes 1.36 and 1.37. v2.2.4 to v2.6.0 ship it unchanged, so
until v2.6.1 both halves of every hop ran the same code. The tool has no code
tied to a release. What a hop does depends on data: the upgrade graph
(`syncManifest`, `minFrom`, the Kubernetes version), the image's release
manifest and the Kubernetes minor the hop enters.

## Consequences

- A published tool cannot be fixed for the work before the reboot. It does
  that work in every hop that starts from its release, on every node that is
  still there. A fix to it helps only hops that start from a later release:
  v2.6.1 fixed the image match in STAGE, see
  [ADR-0009](0009-graph-pins-images-as-index-digest.md). A fix to the work
  after the reboot (health checks, manifest sync, commit) ships with the
  release it fixes, and already applies to the hop into that release.
- Every tool reads the same graph, the one of the latest release, so a graph
  must stay readable by every published tool. A release's manifest, instead,
  is merged by that release's own tool and applied by its own operator
  ([ADR-0005](0005-the-host-syncs-the-release-manifest-operator-first.md)).
- The two halves of a hop meet in `/var/lib/k4all/upgrade/state.json`. A tool
  must read the state that an older tool wrote before the reboot. An older
  tool must read the state that a newer one leaves behind when it rolls the
  node back: the new image's tool decides the rollback, and the old image's
  tool records the HOLD after it.
- The agent runs from the bridge on. Until an operator asks for a hop, it
  only publishes the node's committed release and node type, which the order
  checks between nodes already use.
