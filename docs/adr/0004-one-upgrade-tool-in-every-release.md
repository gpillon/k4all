# One upgrade tool from the bridge on; releases differ only in data

A hop is always run by the `k4all-upgrade` of the release the node is
leaving. So the hop into v2.4.0, the first ReleaseManifest sync, runs with
v2.3.0's tool, and the code that applies v2.4.0's manifest had to ship
before v2.4.0. The bridge release v2.2.4 therefore carries the whole tool:
planner, hop phases, manifest sync, the agent that answers ClusterUpgrade,
the kube-vip generator and the hooks for Kubernetes 1.36 and 1.37.
v2.2.4 to v2.6.0 ship it unchanged. The tool has no code tied to a release.
What a hop does depends on data: the upgrade graph (`syncManifest`, `minFrom`,
the Kubernetes version), the image's release manifest and the Kubernetes
minor the hop enters.

## Consequences

- A published tool cannot be fixed. It runs every hop that starts from its
  release, on every node that is still there. A fix helps only hops that
  start from a later release (v2.6.1 fixed the image match, see
  [ADR-0009](0009-graph-pins-images-as-index-digest.md)).
- Every tool reads the same graph, the one of the latest release, so a graph
  must stay readable by every published tool. The same holds for the release
  manifest that a sync merges.
- The agent runs from the bridge on. Until an operator asks for a hop, it
  only publishes the node's committed release and node type, which the order
  checks between nodes already use.
