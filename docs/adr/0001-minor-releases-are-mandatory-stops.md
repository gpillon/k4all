# Minor releases are mandatory stops; everything else is a patch

A k4all release is a minor (`vX.Y.0`) when it changes the Kubernetes minor,
the Fedora major or the CRI-O minor, replaces a platform component (such as
the ingress controller), or carries a cluster change that `bootc rollback`
cannot undo (the first ReleaseManifest sync, CRD upgrades, a chart's major).
Everything else is a patch (`vX.Y.z`): fixes, tooling, Kubernetes patches and
component patches inside the same lines. A Kubernetes minor had to be a
mandatory stop, but making every release one would turn each fix into a stop
that every node must visit, and that does not run by itself, since auto mode
runs only patches by default.

## Consequences

- No path skips a minor: a patch's `minFrom` is never older than its
  `vX.Y.0`. Before it leaves a stream, a node takes that stream's latest
  patch, as the Kubernetes version-skew policy wants before a minor.
  `k4all-upgrade` and the operator's ClusterUpgrade plan with these same
  rules, and `build-graph.py` refuses a graph that breaks them.
- Kubernetes moves at most one minor per release, and never in the same
  release as a Fedora major.
- A patch may sync its ReleaseManifest when the change is a component patch
  or a new operator (v2.6.1 does). In auto mode it runs in the maintenance
  window, like any patch.
