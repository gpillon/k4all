#!/bin/bash

set -euxo pipefail

# Define paths
CONFIG_FILE="/etc/k4all-config.json"
IGNITION_FILE="/usr/local/bin/k8s.ign"
TMP_JSON_MODIFIED="/tmp/k8s_modified.json"

# Function to add a file to the Ignition configuration
add_file_to_ignition() {
  local source_file=$1
  local target_path=$2
  #local mode=$(printf '%on' $3)
  local mode=0420
  # Prepare the contents to be added to the Ignition file
  FILE_CONTENT=$(cat <<EOF
{
  "path": "$target_path",
  "mode": $mode,
  "contents": {
    "source": "data:;base64,$(base64 -w 0 "$source_file")" 
  }
}
EOF
  )

  # Note on base64: -w 0 is used to prevent line wrapping, default is 76 characters per line

  # Merge the new file into the existing Ignition file
  jq ".storage.files += [$FILE_CONTENT]" "$IGNITION_FILE" > "$TMP_JSON_MODIFIED"
  mv "$TMP_JSON_MODIFIED" "$IGNITION_FILE"
}

# Main script logic
add_file_to_ignition "$CONFIG_FILE" "/etc/k4all-config.json" 0644

echo "The ignition file has been updated to include /etc/k4all-config.json."
