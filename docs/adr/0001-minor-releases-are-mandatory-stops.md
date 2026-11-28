# Minor releases are mandatory stops; everything else is a patch

A k4all release is a minor (`vX.Y.0`) when it changes the Kubernetes minor,
the Fedora major or the CRI-O minor, replaces a platform component (such as
the ingress controller), or carries a cluster change that `bootc rollback`
cannot undo and that no node may skip (the first ReleaseManifest sync, a CRD
change that is not additive, a chart's major). Everything else is a patch
(`vX.Y.z`): fixes, tooling, Kubernetes patches, component patches inside the
same lines, and additive CRD changes. A Kubernetes minor had to be a
mandatory stop, but making every release one would turn each fix into a stop
that every node must visit, and that does not run by itself, since auto mode
runs only patches by default.

## CRD changes

Amended on 2026-11-28. A CRD change of k4all-operator is additive, and fits a
patch, when all of these hold:

- it adds optional fields, enum values, status fields, condition types or
  new kinds, and nothing else;
- a new field has no CRD default, and leaving it out keeps the behaviour of
  the release before, so the hop changes nothing until someone sets it;
- new validation (CEL rules, patterns, enums) covers only the new fields, so
  every object that exists today stays valid at its next write.

It stays a minor when it changes a stored version, removes or renames a
field or an enum value, changes a field's type or meaning, tightens the
validation of existing fields, or needs a conversion webhook or a migration
of stored objects.

An additive change is safe in a patch for these reasons:

- the manifest sync applies the new operator and its CRDs before anything
  else ([ADR-0005](0005-the-host-syncs-the-release-manifest-operator-first.md)),
  and no older operator runs again (the DowngradeRefused guard,
  [ADR-0010](0010-releases-come-from-main-in-version-order.md)), so no
  operator prunes fields it does not know;
- `bootc rollback` of a node leaves the cluster alone: the CRD and its
  objects keep the new fields, and the operator that serves them stays;
- a node that skips the patch gets the same CRD change from the next release
  it syncs, since every release carries what the releases before it carried
  (ADR-0010);
- the k4all addon and the consoles write with JSON patches or server-side
  apply, which keep the fields they do not know.

## Consequences

- No path skips a minor: a patch's `minFrom` is never older than its
  `vX.Y.0`. Before it leaves a stream, a node takes that stream's latest
  patch, as the Kubernetes version-skew policy wants before a minor.
  `k4all-upgrade` and the operator's ClusterUpgrade plan with these same
  rules, and `build-graph.py` refuses a graph that breaks them.
- Kubernetes moves at most one minor per release, and never in the same
  release as a Fedora major.
- A patch may sync its ReleaseManifest when the change is a component patch,
  a new operator (v2.6.1 does) or an additive CRD change (v2.7.2 does). In
  auto mode it runs in the maintenance window, like any patch.
- k4all-operator's CI compares each release's CRDs with the previous tag's
  and fails on a change that is not additive.
