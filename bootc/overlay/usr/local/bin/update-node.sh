#!/bin/bash
# K4All - deprecated entry point, kept for scripts and docs that still call it.
# Node upgrades are done by k4all-upgrade, one safe release hop at a time:
#   k4all-upgrade status | plan | run [--to vX.Y.Z]
set -euo pipefail

echo "update-node.sh is deprecated: using k4all-upgrade." >&2
action="${1:-upgrade}"
case "$action" in
    upgrade|update)
        tag="${2:-latest}"
        if [ "$tag" = "latest" ]; then
            exec /usr/local/bin/k4all-upgrade run
        fi
        exec /usr/local/bin/k4all-upgrade run --to "$tag"
        ;;
    status)
        exec /usr/local/bin/k4all-upgrade status
        ;;
    rollback)
        echo "Check 'k4all-upgrade status' first; a manual rollback is" >&2
        echo "'bootc rollback && systemctl reboot'." >&2
        exit 1
        ;;
    *)
        exec /usr/local/bin/k4all-upgrade --help
        ;;
esac
