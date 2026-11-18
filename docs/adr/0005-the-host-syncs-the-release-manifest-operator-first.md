# The host syncs each release's ReleaseManifest, operator first

A release's component versions reach the cluster only through the manifest
sync. On the bootstrap node, after the hop to a release with
`syncManifest: true`, `k4all-upgrade` merges the image's release manifest
into the cluster's ReleaseManifest and applies it in two steps. First it
applies the `k4all-operator` entry alone and waits until the new operator
runs, then the whole manifest. The host does this, because on existing
clusters the operator never updates itself
([ADR-0003](0003-older-nodes-reach-the-bridge-with-a-script.md)). The
operator goes first because an older one does not know the release's new
fields (`upgradePath`, for example) and prunes them. So each release's
components are applied by that release's operator.

## Considered options

- The operator updates itself and then applies the release, so release N is
  applied by operator N-1. Dropped for the two reasons above.

## Consequences

- Every release pins every component, the operator included. A new operator
  or component release changes no cluster until a k4all release pins it.
- The merge keeps each component's `custom` and `management: Unmanaged` from
  the cluster. Any other change made to the ReleaseManifest by hand is
  overwritten. A component left out of a newer release stays as it is: only
  `management: Removed` uninstalls one.
- Step one is a JSON patch of `spec.components.k4all-operator` alone, not a
  server-side apply. The ReleaseManifest was created with a client-side
  apply, and an SSA of that one entry, with any field manager, removed every
  other component. Step two is an SSA with field manager `k4all-upgrade` and
  `--force-conflicts`.
- A failure during the sync is a HOLD, never an OS rollback: the image booted
  fine, and the cluster has already moved.
