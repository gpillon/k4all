#!/bin/bash

# Function to validate the node section
validate_node() {
  # Check for ha section
  if ! check_json_value '.cluster'; then
    echo "Missing 'node' section."
    return 1
  fi

  # Check for ha section
  if ! check_json_value '.cluster.ha'; then
    echo "Missing 'node.ha' section."
    return 1
  fi

  # Check for ha.type section
  if ! check_json_value '.cluster.ha.type'; then
    echo "Missing 'node.ha.type' section."
    return 1
  fi

  if ! check_json_value '.cluster.apiEndPointUseHostName'; then
    echo "Missing 'node.apiEndPointUseHostName' section."
    return 1
  fi

  if ! check_json_value '.cluster.customApiEndPoint'; then
    echo "Missing 'node.customApiEndPoint' section."
    return 1
  fi

    # Check if node.apiEndPointUseHostName has either 'true' or 'false' values
  NODE_USEHOSTNAME=$(jq -r '.cluster.apiEndPointUseHostName' "$CONFIG_FILE")
  if [[ "$NODE_USEHOSTNAME" != "true" && "$NODE_USEHOSTNAME" != "false" && "$NODE_USEHOSTNAME" != "short"  ]]; then
    echo "Invalid 'node.apiEndPointUseHostName' value. Must be 'true', 'false' or short."
    return 1
  fi

    # Check if nnetworking.firewalld.enabled has either 'true' or 'false' values
  FIREWALLD_ENABLED=$(jq -r '.networking.firewalld.enabled' "$CONFIG_FILE")
  if [[ "$FIREWALLD_ENABLED" != "true" && "$FIREWALLD_ENABLED" != "false" ]]; then
    echo "Invalid 'networking.firewalld.enabled' value. Must be 'true' or 'false'."
    return 1
  fi

  # Check if ha.type has either 'none' or 'keepalived' values
  HA_TYPE=$(jq -r '.cluster.ha.type' "$CONFIG_FILE")
  if [[ "$HA_TYPE" != "none" && "$HA_TYPE" != "keepalived"  && "$HA_TYPE" != "kubevip" ]]; then
    echo "Invalid node.ha.type' value. Must be 'none', 'keepalived' or kubevip."
    return 1
  fi

  # If 'keeplived', check for required fields and their validity
  if [[ "$HA_TYPE" == "keepalived" ||  "$HA_TYPE" == "kubevip" ]]; then
    if ! check_json_value '.cluster.ha.apiControlEndpoint'; then
      echo "Missing 'node.ha.apiControlEndpoint' field."
      return 1
    fi

    if  [[ "$HA_TYPE" == "keepalived" ]] && ! check_json_value '.cluster.ha.apiControlEndpointSubnetSize'; then
      echo "Missing 'nodeha.apiControlEndpointSubnetSize' field."
      return 1
    fi

    if ! check_json_value '.cluster.ha.interface'; then
      echo "Missing 'node.ha.interface' field."
      return 1
    fi

    IP_ADDR=$(jq -r '.cluster.ha.apiControlEndpoint' "$CONFIG_FILE")

    if ! is_valid_ip "$IP_ADDR"; then
      echo "Invalid nodeha.apiControlEndpoint IP address: $IP_ADDR"
      return 1
    fi

    # Check for ha.apiControlEndpointSubnetSize is an integer
    if [[ "$HA_TYPE" == "keepalived" ]] && [ "$(is_json_integer '.cluster.ha.apiControlEndpointSubnetSize' "$CONFIG_FILE")" != "true" ]; then
      echo "Invalid 'node.ha.apiControlEndpointSubnetSize' value. Must be an integer."
      return 1
    fi

    # Check for ha.apiControlEndpointSubnetSize is greater than 0
    if  [[ "$HA_TYPE" == "keepalived" ]] && [[ $(jq -r '.cluster.ha.apiControlEndpointSubnetSize' "$CONFIG_FILE") -lt 0 ]]; then
      echo "Invalid 'node.ha.apiControlEndpointSubnetSize' value. Must be greater than 0."
      return 1
    fi

    # Check for ha.apiControlEndpointSubnetSize is lesser than 32
    if  [[ "$HA_TYPE" == "keepalived" ]] && [[ $(jq -r '.cluster.ha.apiControlEndpointSubnetSize' "$CONFIG_FILE") -gt 32 ]]; then
      echo "Invalid 'node.ha.apiControlEndpointSubnetSize' value. Must be lesser than 32."
      return 1
    fi

    # Check for ha.interface is string
    if [[ $(is_json_string '.cluster.ha.interface' "$CONFIG_FILE") != "true" ]]; then
      echo "Invalid 'node.ha.interface' must be a string."
      return 1
    fi

  fi

  echo "ha section is valid."
  return 0
}
