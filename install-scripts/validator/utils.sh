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
  local field=$1
  # Use jq to check if the value is an integer and print "true" or "false"
jq -r "$1 | type == \"number\"" "$2"
}

is_json_string() {
  local field=$1
  # Use jq to check if the value is an string and print "true" or "false"
jq -r "$1 | type == \"string\"" "$2"
}

# Function to check if a JSON value is an integer or a percentage from 0 to 100%
is_valid_size() {
  local json_path=$1
  local file=$2

  # Extract the value from JSON file
  local value=$(jq -r "$json_path" "$file")

  # Check if the value is an integer
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    return 0  # Success exit code
  # Check if the value is a valid percentage within 0% to 100%
  elif [[ "$value" =~ ^([0-9]|[1-9][0-9]|100)%$ ]]; then
    return 0  # Success exit code
  else
    return 1  # Failure exit code
  fi
}