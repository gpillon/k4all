#!/bin/bash

CONFIG_FILE=$1
VALIDATOR_DIR="/usr/local/bin/validator"

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

  echo "JSON configuration file is valid."
  return 0
}

validate_json