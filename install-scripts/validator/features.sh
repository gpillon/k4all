#!/bin/bash

# Function to validate the features section
validate_features() {

  # Check for virt section
  if ! check_json_value '.features.virt'; then
    echo "Missing 'features.virt' section."
    return 1
  fi

  if ! check_json_value '.features.virt.enabled'; then
    echo "Missing 'features.virt.enabled' section."
    return 1
  fi

  VIRT_ENABLED=$(jq -r '.features.virt.enabled' "$CONFIG_FILE")
  if [[ "$VIRT_ENABLED" != "true" && "$VIRT_ENABLED" != "false" ]]; then
    echo "Invalid features virt.enabled' value. Must be 'true' or 'false'."
    return 1
  fi

  if ! check_json_value '.features.virt.emulation'; then
    echo "Missing 'features.virt.emulation' section."
    return 1
  fi

  VIRT_EMULATION=$(jq -r '.features.virt.emulation' "$CONFIG_FILE")
  if [[ "$VIRT_EMULATION" != "true" && "$VIRT_EMULATION" != "false" && "$VIRT_EMULATION" != "auto" ]]; then
    echo "Invalid features virt.emulation' value. Must be 'true', 'false' or 'auto' (Found '$VIRT_EMULATION')."
    return 1
  fi

  # Check for argocd section
  if ! check_json_value '.features.argocd'; then
    echo "Missing 'features.argocd' section."
    return 1
  fi

  if ! check_json_value '.features.argocd.enabled'; then
    echo "Missing 'features.argocd.enabled' section."
    return 1
  fi

  ARGOCD_ENABLED=$(jq -r '.features.argocd.enabled' "$CONFIG_FILE")
  if [[ "$ARGOCD_ENABLED" != "true" && "$ARGOCD_ENABLED" != "false" ]]; then
    echo "Invalid features argocd.enabled' value. Must be 'true' or 'false'."
    return 1
  fi

  echo "features section is valid."
  return 0
}
