#!/bin/bash

# Function to check if a value exists in a JSON file using jq
check_json_value() {
  jq -e "$1" "$CONFIG_FILE" > /dev/null 2>&1
}

# Function to validate IP address
is_valid_ip() {
  local ip=$1
  if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    local IFS=.
    ip=($ip)
    for octet in "${ip[@]}"; do
      if (( octet < 0 || octet > 255 )); then
        return 1
      fi
    done
    return 0
  else
    return 1
  fi
}

# Function to check that the number is an integer
is_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

is_json_integer() {
  # Use jq to check if the value is an integer and print "true" or "false"
  jq -r '.disk.root.size_mib | type == "number"' "$1"
}