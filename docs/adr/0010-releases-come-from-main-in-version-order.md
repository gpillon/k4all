# Releases come from main in version order, so pinned versions never go down

A release pins every component, the operator included, and a cluster keeps
the versions of its last manifest sync until the next one. Nothing on the way
checks that a sync moves a version up. The merge takes the release's
versions, the operator installs an older version as it would a newer one (a
Helm upgrade to the older chart), an older operator prunes the fields it does
not know ([ADR-0005](0005-the-host-syncs-the-release-manifest-operator-first.md)),
and operator migrations are counted by position. A node also does not visit
every release: it skips patches, and a target release can stop it anywhere.
So every release must carry every pin and every operator migration of every
release a node can come from. k4all gets this from a single line of releases:
every fix lands on main first, and releases are cut from main in version
order. Once X.(Y+1).0 ships, the X.Y stream is frozen. It gets no more
releases, except an exit patch.

## Exit patches

The tool of the release a node leaves does a hop's work up to the reboot
([ADR-0004](0004-one-upgrade-tool-in-every-release.md)). So only a new X.Y
release can fix that work for the hop to X.(Y+1).0. That release is the exit
patch:

- It fixes only that work, and the fix is already on main. Any other fix
  would be lost again at X.(Y+1).0, whose image was built without it.
- It carries the release manifest of the patch before it: no operator,
  component or migration change, and `syncManifest: false`. So its `minFrom`
  cannot reach back past a patch of its stream that syncs, because the graph
  test refuses a patch that skips a sync. In a stream where every patch syncs,
  as in 2.6, `minFrom` is the patch before it.
- It is built from the tag of the patch before it, with the fix picked from
  main.
- When the hop needs it, X.(Y+1).0's `minFrom` is raised to it.
- Nodes see it only once the next release is cut from main. They read the
  graph of the Latest GitHub release, which is the highest tag, and a
  published release keeps its graph. So the exit patch is tagged first, and
  then a release from main lists it in `releases.yaml` and raises the
  `minFrom`.

## Minors stay light

A minor syncs its manifest only when that sync is what makes it a minor: the
first sync, CRD upgrades, a chart's major or a replaced component, as in
v2.4.0 and the planned v2.8.0. It never carries a fix, a component patch or a
new operator forward. Every node of the stream before it goes through it, and
a published minor cannot be replaced, since blocking it leaves that stream
without a path. This refines
[ADR-0001](0001-minor-releases-are-mandatory-stops.md) and does not
contradict it. ADR-0001 says which changes need a minor. This says that a
minor carries nothing else.

## The check

`bootc/tests/upgrade/test_graph.py` checks the published releases against
this rule. Take any release A, and any release S that syncs its manifest and
that some sequence of hops reaches from A. Every component version that A's
release manifest pins must be at most the one in S's.

- The hops are all those the versioning rules allow (`minFrom`, no minor
  skipped, no blocked release), not only the planned path. A target release
  (`--to`, a ClusterUpgrade's `targetRelease`) can take others, and so can a
  plan saved before a release was published.
- A counts even when it does not sync: a cluster installed from A runs A's
  manifest. A blocked A counts too, because clusters may still run it.
- Versions compare as semver. The leading `v` is optional, a prerelease sorts
  before its release, and build metadata does not count. A pin that is not
  semver (`latest`, `master` or empty, as in v2.2.4 and v2.3.0) has nothing
  to go below. In S, though, it fails the check, because nothing shows it is
  not older.
- A component that S does not list is not compared, because the sync leaves
  it as it is. Neither is one that either side has `Removed`, because it
  does not run. A component that only S lists is new. Unmanaged components
  are compared: the host writes kube-vip at its pinned version
  ([ADR-0007](0007-kube-vip-belongs-to-the-host.md)).
- The manifests come from the release tags. The newest release, the one
  being prepared, may have no tag yet: it takes the working tree's manifest.

## Considered options

- Patches of the next stream that accept nodes from the previous minor: a
  v2.6.z with `minFrom: v2.5.0`, carrying 2.5's late fixes, so that 2.5 needs
  no exit patch. Rejected. Such a patch skips a minor. Every published tool
  runs `validate_graph` before it plans, and refuses the whole graph if one
  entry breaks the rule, so every node would stop upgrading
  ([ADR-0004](0004-one-upgrade-tool-in-every-release.md): a graph must stay
  readable by every published tool). Each such patch would also have to do
  the minor's hop and its own changes, from every release of both streams.
  A release that replaces a blocked minor may need something like this; it
  will be designed when it is needed.
- Maintenance branches that keep shipping patches of a stream after the next
  minor. Rejected. Their fixes are missing from the next stream's images
  built before them, so a node loses them at the hop. Their pins can also be
  above the next stream's syncs: an operator newer than X.(Y+1).1's goes back
  down at that sync, and its migrations' count goes with it.

## Consequences

- k4all-operator follows the same rule: its releases come from one line in
  version order, so a newer operator carries every migration of an older one.
  The check sees only the operator's version.
- A frozen stream's clusters get its later fixes through the next stream.
- CI checks out the tags (`fetch-depth: 0`). Every release in `releases.yaml`
  except the newest must be tagged before main lists it, which an exit patch
  is by construction.
- An exit patch's tag runs the release workflow of its own branch. That
  workflow is safe only from v2.6.2 on: it gives Latest only to the highest
  tag and writes `indexDigest`
  ([ADR-0009](0009-graph-pins-images-as-index-digest.md)). So streams before
  2.6 cannot get an exit patch until their tags get a safe release job
  ([#79](https://github.com/gpillon/k4all/issues/79)). The steps are in
  docs/upgrades.md (How releases are cut).
