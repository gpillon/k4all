#!/bin/bash

# Function to validate the ha section
validate_node() {
  # Check for ha section
  if ! check_json_value '.node'; then
    echo "Missing 'node' section."
    return 1
  fi

  # Check for ha section
  if ! check_json_value '.node.ha'; then
    echo "Missing 'node.ha' section."
    return 1
  fi

  # Check for ha.type section
  if ! check_json_value '.node.ha.type'; then
    echo "Missing 'nodeha.type' section."
    return 1
  fi

  # Check if ha.type has either 'none' or 'keepalived' values
  IP_CONFIG=$(jq -r '.node.ha.type' "$CONFIG_FILE")
  if [[ "$IP_CONFIG" != "none" && "$IP_CONFIG" != "keepalived" ]]; then
    echo "Invalid node.ha.type' value. Must be 'none' or 'keepalived'."
    return 1
  fi

  # If 'keeplived', check for required fields and their validity
  if [[ "$IP_CONFIG" == "keepalived" ]]; then
    if ! check_json_value '.node.ha.apiControlEndpoint'; then
      echo "Missing 'node.ha.apiControlEndpoint' field."
      return 1
    fi

    if ! check_json_value '.node.ha.apiControlEndpointSubnetSize'; then
      echo "Missing 'nodeha.apiControlEndpointSubnetSize' field."
      return 1
    fi

    if ! check_json_value '.node.ha.interface'; then
      echo "Missing 'node.ha.interface' field."
      return 1
    fi

    IP_ADDR=$(jq -r '.node.ha.apiControlEndpoint' "$CONFIG_FILE")

    if ! is_valid_ip "$IP_ADDR"; then
      echo "Invalid nodeha.apiControlEndpoint IP address: $IP_ADDR"
      return 1
    fi

    # Check for ha.apiControlEndpointSubnetSize is an integer
    if [ "$(is_json_integer '.node.ha.apiControlEndpointSubnetSize' "$CONFIG_FILE")" != "true" ]; then
      echo "Invalid 'node.ha.apiControlEndpointSubnetSize' value. Must be an integer."
      return 1
    fi

    # Check for ha.apiControlEndpointSubnetSize is greater than 0
    if [[ $(jq -r '.node.ha.apiControlEndpointSubnetSize' "$CONFIG_FILE") -lt 0 ]]; then
      echo "Invalid 'node.ha.apiControlEndpointSubnetSize' value. Must be greater than 0."
      return 1
    fi

    # Check for ha.apiControlEndpointSubnetSize is lesser than 32
    if [[ $(jq -r '.node.ha.apiControlEndpointSubnetSize' "$CONFIG_FILE") -gt 32 ]]; then
      echo "Invalid 'node.ha.apiControlEndpointSubnetSize' value. Must be lesser than 32."
      return 1
    fi

    # Check for ha.interface is string
    if [[ $(is_json_string '.node.ha.interface' "$CONFIG_FILE") != "true" ]]; then
      echo "Invalid 'node.ha.interface' must be a string."
      return 1
    fi

  fi

  echo "ha section is valid."
  return 0
}
