#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Guards of the release workflow (.github/workflows/build.yaml).

    release-checks.py new-version VERSION < tags
    release-checks.py published VERSION < releases
    release-checks.py graph upgrade-graph.json

new-version  Fails when VERSION is already a tag. A build with that
             version pushes the images of a published release again, and
             nodes follow those images by tag.
published    Prints true when the GitHub release of VERSION is published
             (not a draft), false otherwise. The release job of a
             published release keeps the upgrade-graph.json and
             k4all-bridge.sh it has: built again, the graph would carry
             what the registry and the code say today.
graph        Fails when an entry of the upgrade graph has `digest`, or has
             an indexDigest that is not the digest of the release's
             multi-arch index in the registry (docker buildx imagetools,
             logged in as the release job is). The k4all-upgrade of
             v2.2.4 - v2.6.0 switches to image@digest on `digest` and then
             stops in HOLD at STAGE; build-graph.py writes indexDigest only,
             and this checks the file that is about to be uploaded.

Tags come one per line on stdin, as `git tag -l` or `git ls-remote --tags`
prints them. Releases come as `gh release list --json tagName,isDraft`
prints them.
"""

import argparse
import json
import os
import subprocess
import sys

# What a multi-arch tag points to (docker manifest push writes the OCI one).
INDEX_MEDIA_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
)


def read_tags(text):
    """Tag names from `git tag -l` or `git ls-remote --tags` output."""
    tags = set()
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        name = fields[-1]
        if name.startswith("refs/tags/"):
            name = name[len("refs/tags/"):]
        if name.endswith("^{}"):        # ls-remote's peeled annotated tag
            name = name[:-len("^{}")]
        tags.add(name)
    return tags


def new_version_error(version, tags):
    """Why a build may not use ``version``, or None."""
    if version in tags:
        return ("%s is already a tag: a build with this version would push "
                "the images of that release again, over the ones nodes "
                "follow by tag. Use a version that is not a tag yet."
                % version)
    return None


def is_published(version, releases):
    """True when ``releases`` (gh release list --json tagName,isDraft) has
    a published release, not a draft, for ``version``."""
    return any(rel.get("tagName") == version and rel.get("isDraft") is False
               for rel in releases)


def registry_index(image, version):
    """What ``image:version`` points to in the registry, as `docker buildx
    imagetools inspect --format '{{json .Manifest}}'` prints it (as
    build-graph.py reads it); LookupError when it cannot be read."""
    ref = "%s:%s" % (image, version)
    proc = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", ref,
         "--format", "{{json .Manifest}}"],
        capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise LookupError(proc.stderr.strip()
                          or "docker exited with %d" % proc.returncode)
    try:
        manifest = json.loads(proc.stdout)
    except ValueError as exc:
        raise LookupError("unreadable output: %s" % exc) from exc
    if not isinstance(manifest, dict):
        raise LookupError("unexpected output: %s" % proc.stdout.strip())
    return manifest


def is_index(manifest):
    """True for a multi-arch index (manifest list)."""
    return (manifest.get("mediaType") in INDEX_MEDIA_TYPES
            or bool(manifest.get("manifests")))


def graph_errors(doc, lookup=registry_index):
    """What keeps upgrade-graph.json ``doc`` from being published.
    ``lookup(image, version)`` returns what registry_index does."""
    if not isinstance(doc, dict):
        return ["the graph is not a JSON object"]
    image = doc.get("image")
    releases = doc.get("releases")
    if not image:
        return ["the graph names no image"]
    if not releases or not isinstance(releases, list):
        return ["the graph lists no release"]
    errors = []
    for entry in releases:
        version = entry.get("version", "?")
        if "digest" in entry:
            errors.append(
                "%s has digest: the k4all-upgrade of v2.2.4 - v2.6.0 would "
                "switch to it and stop in HOLD at STAGE (indexDigest only)"
                % version)
        index = entry.get("indexDigest")
        if not index:
            errors.append("%s has no indexDigest" % version)
            continue
        ref = "%s:%s" % (image, version)
        try:
            manifest = lookup(image, version)
        except LookupError as exc:
            errors.append("%s: cannot read %s from the registry: %s"
                          % (version, ref, exc))
            continue
        if not is_index(manifest):
            errors.append("%s: %s is not a multi-arch index (%s)"
                          % (version, ref, manifest.get("mediaType", "?")))
        elif manifest.get("digest") != index:
            errors.append("%s: indexDigest is %s, the registry has %s for %s"
                          % (version, index, manifest.get("digest"), ref))
    return errors


def error(message):
    """An error line; a GitHub Actions annotation under Actions."""
    prefix = "::error::" if os.environ.get("GITHUB_ACTIONS") == "true" else "error: "
    print(prefix + message, file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    new_version = sub.add_parser("new-version",
                                 help="fail when VERSION is already a tag")
    new_version.add_argument("version")
    published = sub.add_parser("published",
                               help="print whether VERSION is a published release")
    published.add_argument("version")
    graph = sub.add_parser("graph",
                           help="check upgrade-graph.json against the registry")
    graph.add_argument("path")
    args = parser.parse_args(argv)

    if args.command == "new-version":
        problem = new_version_error(args.version, read_tags(sys.stdin.read()))
        if problem:
            error(problem)
            return 1
        print("%s is not a tag yet" % args.version)
    elif args.command == "published":
        try:
            releases = json.loads(sys.stdin.read())
        except ValueError as exc:
            error("cannot read the release list: %s" % exc)
            return 1
        if not isinstance(releases, list):
            error("the release list is not a JSON array")
            return 1
        print("true" if is_published(args.version, releases) else "false")
    elif args.command == "graph":
        try:
            with open(args.path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError) as exc:
            error("cannot read %s: %s" % (args.path, exc))
            return 1
        problems = graph_errors(doc)
        for problem in problems:
            error("%s: %s" % (args.path, problem))
        if problems:
            return 1
        print("%s: no digest, and each indexDigest is the registry's "
              "(%d releases)" % (args.path, len(doc["releases"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
