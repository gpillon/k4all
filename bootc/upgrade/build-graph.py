#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build upgrade-graph.json from bootc/upgrade/releases.yaml.

    build-graph.py releases.yaml [-o upgrade-graph.json]
                   [--image ghcr.io/gpillon/k4all-bootc]
                   [--digest v2.2.4=sha256:...] [--resolve-digests]
                   [--require-digests]

The versioning rules live in k4all-upgrade itself; this script imports them,
so the CI, the image and the node all agree on what a valid graph is.

Each release gets the digest of its multi-arch index as `indexDigest`, never
as `digest`. The k4all-upgrade of v2.2.4 - v2.6.0 switches to image@digest
when an entry has `digest`, then cannot match what bootc staged (bootc
reports the platform manifest's digest) and stops in HOLD at STAGE. Those
tools ignore keys they do not know, so they keep using the release tags.
"""

import argparse
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "overlay", "usr", "local", "bin", "k4all-upgrade")


def load_tool():
    loader = importlib.machinery.SourceFileLoader("k4all_upgrade", TOOL)
    spec = importlib.util.spec_from_loader("k4all_upgrade", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def load_yaml(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    try:
        import yaml  # pylint: disable=import-outside-toplevel
        return yaml.safe_load(text)
    except ImportError:
        out = subprocess.run(["yq", "-o=json", "eval", ".", path],
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out)


def resolve_digest(image, version):
    """Digest of the multi-arch index (manifest list) for image:version, or ''."""
    proc = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", "%s:%s" % (image, version),
         "--format", "{{json .Manifest}}"],
        capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        return ""
    return json.loads(proc.stdout).get("digest", "")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("releases")
    parser.add_argument("-o", "--output", default="-")
    parser.add_argument("--image", default="ghcr.io/gpillon/k4all-bootc")
    parser.add_argument("--digest", action="append", default=[],
                        metavar="VERSION=DIGEST",
                        help="index digest of a release (written as indexDigest)")
    parser.add_argument("--resolve-digests", action="store_true",
                        help="look up missing digests in the registry")
    parser.add_argument("--require-digests", action="store_true",
                        help="fail when a release has no digest")
    args = parser.parse_args(argv)

    tool = load_tool()
    data = load_yaml(args.releases) or {}
    releases = tool.load_graph(data)
    errors = tool.validate_graph(releases)
    if errors:
        for err in errors:
            print("graph error: %s" % err, file=sys.stderr)
        return 1

    known = dict(item.split("=", 1) for item in args.digest)
    out = []
    for rel in releases:
        entry = rel.to_dict()
        entry.pop("digest", None)       # never: see the module docstring
        digest = known.get(rel.version) or rel.index_digest
        if not digest and args.resolve_digests:
            digest = resolve_digest(args.image, rel.version)
        if digest:
            entry["indexDigest"] = digest
        elif args.require_digests:
            print("graph error: no digest for %s" % rel.version, file=sys.stderr)
            return 1
        out.append(entry)

    doc = json.dumps({"schema": 1, "image": args.image, "releases": out},
                     indent=2) + "\n"
    if args.output == "-":
        sys.stdout.write(doc)
    else:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
