#!/bin/bash

# Function to validate the proxy section
validate_proxy() {
  # Check for proxy section
  if ! check_json_value '.proxy'; then
    echo "Missing 'proxy' section."
    return 1
  fi

  # Ensure expected fields exist
  if ! check_json_value '.proxy.http_proxy'; then
    echo "Missing 'proxy.http_proxy' section."
    return 1
  fi

  if ! check_json_value '.proxy.https_proxy'; then
    echo "Missing 'proxy.https_proxy' section."
    return 1
  fi

  if ! check_json_value '.proxy.no_proxy'; then
    echo "Missing 'proxy.no_proxy' section."
    return 1
  fi

  # Enforce type: strings
  if [[ $(is_json_string '.proxy.http_proxy' "$CONFIG_FILE") != "true" ]]; then
    echo "Invalid 'proxy.http_proxy' value. Must be a string."
    return 1
  fi
  if [[ $(is_json_string '.proxy.https_proxy' "$CONFIG_FILE") != "true" ]]; then
    echo "Invalid 'proxy.https_proxy' value. Must be a string."
    return 1
  fi
  if [[ $(is_json_string '.proxy.no_proxy' "$CONFIG_FILE") != "true" ]]; then
    echo "Invalid 'proxy.no_proxy' value. Must be a string."
    return 1
  fi

  echo "proxy section is valid."
  return 0
}


