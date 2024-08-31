#!/bin/bash

# Function to validate the networking section
validate_networking() {
  # Check for networking section
  if ! check_json_value '.networking'; then
    echo "Missing 'networking' section."
    return 1
  fi

  # Check for networking.ipconfig section
  if ! check_json_value '.networking.ipconfig'; then
    echo "Missing 'networking.ipconfig' section."
    return 1
  fi

  # Check if networking.ipconfig has either 'dhcp' or 'static' values
  IP_CONFIG=$(jq -r '.networking.ipconfig' "$CONFIG_FILE")
  if [[ "$IP_CONFIG" != "dhcp" && "$IP_CONFIG" != "static" ]]; then
    echo "Invalid 'networking.ipconfig' value. Must be 'dhcp' or 'static'."
    return 1
  fi

  # If 'static', check for required fields and their validity
  if [[ "$IP_CONFIG" == "static" ]]; then
    if ! check_json_value '.networking.ipaddr'; then
      echo "Missing 'networking.ipaddr' field."
      return 1
    fi
    if ! check_json_value '.networking.subnet_mask'; then
      echo "Missing 'networking.subnet_mask' field."
      return 1
    fi
    if ! check_json_value '.networking.gateway'; then
      echo "Missing 'networking.gateway' field."
      return 1
    fi

    IP_ADDR=$(jq -r '.networking.ipaddr' "$CONFIG_FILE")
    SUBNET_MASK=$(jq -r '.networking.subnet_mask' "$CONFIG_FILE")
    GATEWAY=$(jq -r '.networking.gateway' "$CONFIG_FILE")

    if ! is_valid_ip "$IP_ADDR"; then
      echo "Invalid IP address: $IP_ADDR"
      return 1
    fi
    if ! is_valid_ip "$SUBNET_MASK"; then
      echo "Invalid subnet mask: $SUBNET_MASK"
      return 1
    fi
    if ! is_valid_ip "$GATEWAY"; then
      echo "Invalid gateway: $GATEWAY"
      return 1
    fi

    # Validate DNS
    if ! check_json_value '.networking.dns'; then
      echo "Missing 'networking.dns' field."
      return 1
    fi

    # Validate DNS are IP comma-separated (no whitespaces)
    DNS=$(jq -r '.networking.dns' "$CONFIG_FILE")
    if ! [[ $DNS =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(,([0-9]{1,3}\.){3}[0-9]{1,3})*$ ]]; then
      echo "Invalid DNS: $DNS"
      return 1
    fi

    if ! check_json_value '.networking.dns_search'; then
      echo "Missing 'networking.dns_search' field."
      return 1
    fi

  fi

  echo "Networking section is valid."
  return 0
}
