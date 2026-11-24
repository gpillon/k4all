# Release notes

One file per release, named after its tag (`v2.7.0.md`): the hand-written part
of the GitHub release. The release job of `.github/workflows/build.yaml` ends
the release body with it (`release-checks.py notes`), so the release appears
with its notes. Add the file in the release commit, before the tag.

Without a file the release is published without notes, and the job warns.
A file whose name is not a release of `bootc/upgrade/releases.yaml` fails the
checks. A published release keeps its body: to change it later, use
`gh release edit <tag> --notes-file <file>`.

The short `notes` of `bootc/upgrade/releases.yaml` are something else: they go
into the upgrade graph, where the addon's Upgrades page shows them.
