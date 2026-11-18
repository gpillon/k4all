#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Guards of the release workflow (.github/workflows/build.yaml).

    release-checks.py new-version VERSION < tags
    release-checks.py published VERSION < releases

new-version  Fails when VERSION is already a tag. A build with that
             version pushes the images of a published release again, and
             nodes follow those images by tag.
published    Prints true when the GitHub release of VERSION is published
             (not a draft), false otherwise. The release job of a
             published release keeps the upgrade-graph.json and
             k4all-bridge.sh it has: built again, the graph would carry
             what the registry and the code say today.

Tags come one per line on stdin, as `git tag -l` or `git ls-remote --tags`
prints them. Releases come as `gh release list --json tagName,isDraft`
prints them.
"""

import argparse
import json
import os
import sys


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
    return 0


if __name__ == "__main__":
    sys.exit(main())
