# The operator and the nodes coordinate upgrades through Node annotations

In a ClusterUpgrade the operator plans the path and takes one node at a
time: the bootstrap node, then the other control planes, then the workers.
It cordons and drains the node through the eviction API, then asks for one
hop by writing `k4all.magesgate.com/upgrade-target` on that Node. On the
node, the `k4all-upgrade` agent runs the hop and reports through
annotations on its own Node (`release`, `node-type`, `upgrade-phase`,
`upgrade-message`, `upgrade-reason`, `upgrade-done`). The operator drains,
because a worker has only `kubelet.conf`, which may not evict pods. The
node runs the hop, because only the host can switch the image, run kubeadm
and reboot. Annotations on the node's own Node need no credentials beyond
the ones every node already has.

## Considered options

- `NodeConfig.spec.upgrade.desired` and `NodeConfig.status.upgrade`, with a
  ServiceAccount token per worker, limited by `resourceNames`, that the
  operator would hand out. Dropped for the annotations, which need no token.

## Consequences

- A hop request names one legal hop: the release the node's own planner
  would visit next. Anything else (older, skips a minor or a stream's latest
  patch, blocked, not in the graph) is a HOLD with
  `upgrade-reason: TargetRejected`, and nothing starts. The operator's
  planner follows the same rules.
- The node runs an operator-driven hop in any upgrade mode, outside the
  maintenance window and also for a minor. It neither drains nor uncordons
  itself, and does not scale the operator down.
- Pause gate: from STAGE until COMMIT, and in a HOLD after the reboot, the
  node carries `upgrade-in-progress`, and while any node does, the operator
  reconciles no component. Operators older than the gate, on clusters
  before v2.4.0's sync, are scaled to zero instead by the node's tool,
  during hops that change Kubernetes.
- The agent never interrupts a hop in progress.
- The annotation names are constants on both sides: `k4all-upgrade` and the
  operator's `api/v1alpha1`. Every published tool keeps speaking the
  protocol it shipped with
  ([ADR-0004](0004-one-upgrade-tool-in-every-release.md)), so a change has to
  stay compatible with all of them.
