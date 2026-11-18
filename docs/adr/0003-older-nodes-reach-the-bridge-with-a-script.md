# Older nodes reach the bridge release with a script, not an operator Job

Nodes on v2.0 to v2.2.3 have no `k4all-upgrade`. On their clusters the
operator never updates itself: from v2.1.0 the CI pins
`k4all-operator.version`, `deploy-operator.sh` applies the ReleaseManifest
only once, and the v2.0 betas have no operator at all. So a Job shipped with
a newer operator would reach no existing cluster without a manual step. These
nodes reach the bridge release, v2.2.4, through `k4all-bridge.sh`, a release
asset run by hand on each node: the bootstrap node, then the other control
planes, then the workers. The script checks the node and masks
`bootc-fetch-apply-updates.timer`, then switches to the bridge image by
digest. From the bridge on, `k4all-upgrade` runs every hop.

## Considered options

- An operator Job that masks bootc's timer, stages the bridge, announces it
  and applies it in a Saturday window a week later, with an opt-out
  annotation. Dropped, because of the pinned operator above.

## Consequences

- With the v2.2.4 tag, the CI moved `:latest` to the bridge one last time and
  froze it there (`LATEST_PIN` in `build.yaml`). Nodes installed from a local
  build follow `:latest` through bootc's own timer, so they take the bridge by
  themselves within hours, and the bridge image masks that timer. `:latest` must never move again: on a node not
  bridged yet, bootc's timer would apply any image it points to, even a new
  Kubernetes minor, without running kubeadm.
- The bridge is a patch with `minFrom: v2.0.0-beta1`, so every older 2.x
  release can switch straight to it.
