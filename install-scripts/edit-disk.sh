#!/bin/bash

set -euxo pipefail

CONFIG_FILE="/etc/k4all-config.json"
IGNITION_FILE="/usr/local/bin/k8s.ign"

MIN_DISK_SIZE=12000
MAX_DISK_SIZE=120000

# Get the new disk size from the CONFIG_FILE
RAW_DISK_SIZE=$(jq -r '.disk.root.size_mib' "$CONFIG_FILE")
DISK=$(/usr/local/bin/disk-helper.sh)

# Function to get disk size in MiB
get_disk_size_mib() {
  local disk=$1
  # Get the total disk size in bytes
  local size_bytes
  size_bytes=$(blockdev --getsize64 "/dev/$disk")
  # Convert bytes to MiB (1 MiB = 1024 * 1024 bytes)
  echo $((size_bytes / 1024 / 1024))
}

# Determine if RAW_DISK_SIZE is a percentage or a fixed size
if [[ "$RAW_DISK_SIZE" == *% ]]; then
  # It's a percentage
  PERCENTAGE=${RAW_DISK_SIZE%\%}
  # Get the total disk size in MiB
  TOTAL_DISK_SIZE_MIB=$(get_disk_size_mib "$DISK")
  # Calculate the new disk size, discarding any fractional part
  NEW_DISK_SIZE=$(( MIN_DISK_SIZE + (TOTAL_DISK_SIZE_MIB - 12000 ) * PERCENTAGE / 100 ))
else
  # It's a fixed size
  NEW_DISK_SIZE=${RAW_DISK_SIZE%\.*}  # Remove any decimal part if present
fi

# Enforce minimum and maximum disk sizes
if [ "$NEW_DISK_SIZE" -lt $MIN_DISK_SIZE ]; then
  NEW_DISK_SIZE=$MIN_DISK_SIZE
elif [ "$NEW_DISK_SIZE" -gt $MAX_DISK_SIZE ]; then
  NEW_DISK_SIZE=$MAX_DISK_SIZE
fi

# Temporary files for processing
TMP_BASE64_DECODED="/tmp/k8s_decoded.gz"
TMP_JSON="/tmp/k8s.json"
TMP_JSON_MODIFIED="/tmp/k8s_modified.json"

# Extract the base64 encoded gzip content from the ignition file
BASE64_CONTENT=$(jq -r '.ignition.config.merge[0].source' "$IGNITION_FILE" | sed 's/^data:;base64,//')

# Decode the base64 content to gzip
echo "$BASE64_CONTENT" | base64 -d > "$TMP_BASE64_DECODED"

# Decompress to get the JSON content
gzip -d -c "$TMP_BASE64_DECODED" > "$TMP_JSON"

# Use jq to modify the JSON content, updating the size of the partition labeled "root"
jq --arg newSize "$NEW_DISK_SIZE" \
   '(.storage.disks[0].partitions[] | select(.label == "root") | .sizeMiB) |= ($newSize | tonumber)' \
   "$TMP_JSON" > "$TMP_JSON_MODIFIED"

# Use jq to modify the JSON content, updating the device
jq --arg newDisk "$DISK" \
   '(.storage.disks[0].device) = "/dev/\($newDisk)"' \
   "$TMP_JSON_MODIFIED" > "${TMP_JSON_MODIFIED}_tmp"

# Replace the modified JSON with the updated one
mv "${TMP_JSON_MODIFIED}_tmp" "$TMP_JSON_MODIFIED"

# Recompress the edited JSON and re-encode it to base64
gzip -c "$TMP_JSON_MODIFIED" | base64 -w 0 > "$TMP_BASE64_DECODED"

# Prepare the new base64 data URI
NEW_BASE64_CONTENT="data:;base64,$(cat "$TMP_BASE64_DECODED")"

# Update the ignition file with the new base64 content
jq --arg newSource "$NEW_BASE64_CONTENT" \
   '.ignition.config.merge[0].source = $newSource' \
   "$IGNITION_FILE" > "${IGNITION_FILE}.tmp"

# Replace the old ignition file with the new one
mv "${IGNITION_FILE}.tmp" "$IGNITION_FILE"

# Cleanup temporary files
rm -f "$TMP_BASE64_DECODED" "$TMP_JSON" "$TMP_JSON_MODIFIED"

echo "The ignition file has been updated."
