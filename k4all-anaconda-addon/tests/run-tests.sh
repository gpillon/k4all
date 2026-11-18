#!/bin/bash
# =============================================================================
# K4All Anaconda Addon - Test Runner
# =============================================================================
# Runs tests in two modes:
#   1. "mock" (default) - Uses mock pyanaconda, runs locally with pytest
#   2. "full"           - Builds a container with real anaconda and runs tests
#
# Usage:
#   ./tests/run-tests.sh              # Mock mode (fast, no network)
#   ./tests/run-tests.sh full         # Full mode (builds container, needs network)
#   ./tests/run-tests.sh mock -v -k "test_parse"  # Pass extra pytest args
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDON_DIR="$(dirname "$SCRIPT_DIR")"
MODE="${1:-mock}"

cd "$ADDON_DIR"

# Find available python with pytest
PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -m pytest --version &>/dev/null; then
    for candidate in python3.11 python3.12 python3.10 python3; do
        if command -v "$candidate" &>/dev/null && "$candidate" -m pytest --version &>/dev/null; then
            PYTHON="$candidate"
            break
        fi
    done
fi

case "$MODE" in
    mock)
        shift 2>/dev/null || true
        echo "╔══════════════════════════════════════════════════╗"
        echo "║   K4All Addon Tests (mock mode)                  ║"
        echo "╚══════════════════════════════════════════════════╝"
        echo ""
        echo "Running with mocked pyanaconda/dasbus/pykickstart..."
        echo "Using Python: $PYTHON"
        echo ""

        PYTHONPATH="$ADDON_DIR:$ADDON_DIR/tests" \
            "$PYTHON" -m pytest tests/ -v --tb=short "$@"
        ;;

    full)
        shift 2>/dev/null || true
        echo "╔══════════════════════════════════════════════════╗"
        echo "║   K4All Addon Tests (full integration)           ║"
        echo "╚══════════════════════════════════════════════════╝"
        echo ""
        echo "Building test container with real Anaconda..."
        echo ""

        IMAGE_NAME="k4all-addon-test:latest"
        podman build -t "$IMAGE_NAME" -f tests/Containerfile.test .
        echo ""
        echo "Running tests in container..."
        echo ""
        podman run --rm "$IMAGE_NAME" python3 -m pytest -v --tb=short "$@"
        ;;

    *)
        echo "Usage: $0 [mock|full] [pytest args...]"
        echo ""
        echo "Modes:"
        echo "  mock  - Fast tests with mocked dependencies (default)"
        echo "  full  - Integration tests in container with real Anaconda"
        exit 1
        ;;
esac
