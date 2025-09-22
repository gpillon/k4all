#!/bin/bash

# Wrapper to validate a JSON config using validator modules
# Usage: validate_config.sh /path/to/config.json

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
VALIDATOR_DIR="$SCRIPT_DIR/validator"

CONFIG_FILE=${1:-}
if [ -z "${CONFIG_FILE}" ]; then
  echo "Usage: $0 /path/to/config.json" >&2
  exit 2
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Config file not found: $CONFIG_FILE" >&2
  exit 2
fi

export CONFIG_FILE

# shellcheck source=/dev/null
source "$VALIDATOR_DIR/utils.sh"

rc=0

# shellcheck source=/dev/null
source "$VALIDATOR_DIR/networking.sh"
validate_networking || rc=1

# shellcheck source=/dev/null
source "$VALIDATOR_DIR/disk.sh"
validate_disk || rc=1

# shellcheck source=/dev/null
source "$VALIDATOR_DIR/features.sh"
validate_features || rc=1

# shellcheck source=/dev/null
source "$VALIDATOR_DIR/proxy.sh"
validate_proxy || rc=1

# shellcheck source=/dev/null
source "$VALIDATOR_DIR/node.sh"
validate_node || rc=1

exit $rc

#!/bin/bash

CONFIG_FILE=$1
VALIDATOR_DIR="/usr/local/bin/validator"
# VALIDATOR_DIR="$( dirname "${BASH_SOURCE[0]}" )/validator" TO TEST, next step is to test the updated config.

# Source utility and validation scripts
for script in "$VALIDATOR_DIR"/*.sh; do
  source "$script"
done

# Main function to validate the JSON file structure and content
validate_json() {
  # Check if the JSON file is valid
  if ! jq . "$CONFIG_FILE" > /dev/null 2>&1; then
    echo "Invalid JSON Syntax."
    return 1
  fi

  # Validate networking section
  if ! validate_networking; then
    return 1
  fi

  # Validate disk section
  if ! validate_disk; then
    return 1
  fi

  # Validate node section
  if ! validate_node; then
    return 1
  fi

  # Validate features section
  if ! validate_features; then
    return 1
  fi

  echo "JSON configuration file is valid."
  return 0
}

validate_json