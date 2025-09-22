#!/bin/bash

# Function to validate the networking section
validate_networking() {
  # Check for networking section
  if ! check_json_value '.networking'; then
    echo "Missing 'networking' section."
    return 1
  fi

  # Check for networking.cni section
  if ! check_json_value '.networking.cni'; then
    echo "Missing 'networking.cni' section."
    return 1
  fi

    # Check for networking.cni.type section
  if ! check_json_value '.networking.cni.type'; then
    echo "Missing 'networking.cni.type' section."
    return 1
  fi

  # Check if networking.cni has either 'calico' or 'cilium' values
  CNI_CONFIG=$(jq -r '.networking.cni.type' "$CONFIG_FILE")
  if [[ "$CNI_CONFIG" != "calico" && "$CNI_CONFIG" != "cilium" ]]; then
    echo "Invalid 'networking.cni.type' value. Must be 'calico' or 'cilium'."
    return 1
  fi

  # Check for networking.net section
  if ! check_json_value '.networking.iface'; then
    echo "Missing 'networking.iface' section."
    return 1
  fi

    # Check for networking.iface.dev section
  if ! check_json_value '.networking.iface.dev'; then
    echo "Missing 'networking.iface.dev' section."
    return 1
  fi

   # Check for networking.iface.ipconfig section
  if ! check_json_value '.networking.iface.ipconfig'; then
    echo "Missing 'networking.iface.ipconfig' section."
    return 1
  fi

   # Check for networking.firewalld section
  if ! check_json_value '.networking.firewalld'; then
    echo "Missing 'networking.firewalld' section."
    return 1
  fi

  # Check for networking.firewalld.enabled
  if ! check_json_value '.networking.firewalld.enabled'; then
    echo "Missing 'networking.firewalld.enabled' section."
    return 1
  fi

  # Check if nnetworking.firewalld.enabled has either 'true' or 'false' values
  FIREWALLD_ENABLED=$(jq -r '.networking.firewalld.enabled' "$CONFIG_FILE")
  if [[ "$FIREWALLD_ENABLED" != "true" && "$FIREWALLD_ENABLED" != "false" ]]; then
    echo "Invalid 'networking.firewalld.enabled' value. Must be 'true' or 'false'."
    return 1
  fi

  # Check if networking.ipconfig has either 'dhcp' or 'static' values
  IP_CONFIG=$(jq -r '.networking.iface.ipconfig' "$CONFIG_FILE")
  if [[ "$IP_CONFIG" != "dhcp" && "$IP_CONFIG" != "static" ]]; then
    echo "Invalid 'networking.iface.ipconfig' value. Must be 'dhcp' or 'static'."
    return 1
  fi

  # If 'static', check for required fields and their validity
  if [[ "$IP_CONFIG" == "static" ]]; then
    if ! check_json_value '.networking.iface.ipaddr'; then
      echo "Missing 'networking.iface.ipaddr' field."
      return 1
    fi
    if ! check_json_value '.networking.iface.subnet_mask'; then
      echo "Missing 'networking.iface.subnet_mask' field."
      return 1
    fi
    if ! check_json_value '.networking.iface.gateway'; then
      echo "Missing 'networking.iface.gateway' field."
      return 1
    fi

    IP_ADDR=$(jq -r '.networking.iface.ipaddr' "$CONFIG_FILE")
    SUBNET_MASK=$(jq -r '.networking.iface.subnet_mask' "$CONFIG_FILE")
    GATEWAY=$(jq -r '.networking.iface.gateway' "$CONFIG_FILE")

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
    if ! check_json_value '.networking.iface.dns'; then
      echo "Missing 'networking.iface.dns' field."
      return 1
    fi

    # Validate DNS are IP comma-separated (no whitespaces)
    DNS=$(jq -r '.networking.iface.dns' "$CONFIG_FILE")
    if ! [[ $DNS =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(,([0-9]{1,3}\.){3}[0-9]{1,3})*$ ]]; then
      echo "Invalid DNS: $DNS"
      return 1
    fi

    if ! check_json_value '.networking.iface.dns_search'; then
      echo "Missing 'networking.dns_search' field."
      return 1
    fi

  fi

  echo "Networking section is valid."
  return 0
}
