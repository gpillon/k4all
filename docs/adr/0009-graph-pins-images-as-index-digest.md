# The upgrade graph pins images as `indexDigest`, never as `digest`

When a graph entry has `digest`, the `k4all-upgrade` of v2.2.4 to v2.6.0
switches to `image@digest`, then checks the staged deployment by comparing
that digest with the `imageDigest` bootc reports. bootc reports the digest
of the manifest it pulled for the node's architecture, while the graph holds
the digest of the multi-arch index, so every hop stopped in HOLD at STAGE.
Those tools are on nodes, and they run every hop that starts from their
releases ([ADR-0004](0004-one-upgrade-tool-in-every-release.md)). From
v2.6.1, `build-graph.py` writes each release's index digest as
`indexDigest`. The old tools ignore that key and keep switching by tag. The
new tool compares the ref first, then the digest.

## Considered options

- Graphs without any digest. This was the first fix, and it is what the
  v2.2.4 to v2.6.0 release assets still carry, but it leaves the new tools
  with nothing to pin.
- Fixing the comparison only. It does nothing for the tools already on
  nodes.

## Consequences

- No published graph may carry `digest` again. The release jobs of the
  v2.2.4 to v2.6.0 tags must never run again: they build the graph with
  their own `build-graph.py`, which writes `digest`.
- The operator reads `digest` as optional and does not use it.
