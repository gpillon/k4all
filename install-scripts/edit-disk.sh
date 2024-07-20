#!/bin/bash

set -euxo pipefail

CONFIG_FILE="/tmp/k4all-config.json"
IGNITION_FILE="/usr/local/bin/k8s.ign"

# New disk size to insert into the JSON structure from the CONFIG_FILE
NEW_DISK_SIZE=$(jq -r '.disk.root.size_mib' $CONFIG_FILE)

# Temporary files for processing
TMP_BASE64_DECODED="/tmp/k8s_decoded.gz"
TMP_JSON="/tmp/k8s.json"
TMP_JSON_MODIFIED="/tmp/k8s_modified.json"

# Extract the base64 encoded gzip content from the ignition file
# Adjust the jq path to match where the gzip data is located
BASE64_CONTENT=$(jq -r '.ignition.config.merge[0].source' $IGNITION_FILE | sed 's/^data:;base64,//')

# Decode the base64 content to gzip
echo $BASE64_CONTENT | base64 -d > $TMP_BASE64_DECODED

# Decompress to get the JSON content
gzip -d -c $TMP_BASE64_DECODED > $TMP_JSON

# Use jq to modify the JSON content automatically, updating the size of the partition labeled "root"
jq --arg newSize "$NEW_DISK_SIZE" '(.storage.disks[0].partitions[] | select(.label == "root") | .sizeMiB) |= ($newSize | tonumber)' $TMP_JSON > $TMP_JSON_MODIFIED

# Recompress the edited JSON and re-encode it to base64
gzip -c $TMP_JSON_MODIFIED | base64 -w 0 > $TMP_BASE64_DECODED

# Prepare the new base64 data URI
NEW_BASE64_CONTENT=$(echo -n "data:;base64," && cat $TMP_BASE64_DECODED)

# Update the ignition file with the new base64 content
jq --arg newSource "$NEW_BASE64_CONTENT" '.ignition.config.merge[0].source = $newSource' $IGNITION_FILE > "${IGNITION_FILE}.tmp"

# Replace the old ignition file with the new one
mv "${IGNITION_FILE}.tmp" $IGNITION_FILE

# Cleanup temporary files
#rm -f $TMP_BASE64_DECODED $TMP_JSON $TMP_JSON_MODIFIED

echo "The ignition file has been updated."
