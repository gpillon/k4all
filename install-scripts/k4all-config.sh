#!/bin/bash

# Define the path to the JSON configuration file and the default JSON file
TIMEOUT=15
CONFIG_FILE="/tmp/k4all-config.json"
DEFAULT_CONFIG_FILE="/usr/local/share/default-cluster-config.json"
VALIDATOR_SCRIPT="/usr/local/bin/validate_config.sh"
TEMP_CONFIG_FILE="/tmp/temp-k4all-config.json"
TEMP_STRIPPED_CONFIG_FILE="/tmp/temp-stripped-k4all-config.json"

# Function to strip comments from the JSON file
strip_comments() {
  echo "Removing comments from the JSON configuration file and saving to $1..."
  sed '/^\s*\/\//d' "$TEMP_CONFIG_FILE" > "$1"
}

# Function to validate the JSON file using the stripped version
validate_json() {
  strip_comments $TEMP_STRIPPED_CONFIG_FILE
  bash "$VALIDATOR_SCRIPT" "$TEMP_STRIPPED_CONFIG_FILE"
}

# Function to edit the JSON configuration file with the chosen editor
edit_json() {
  local editor=$1
  echo "Opening the JSON configuration file for editing with $editor..."
  $editor "$TEMP_CONFIG_FILE"
}

# Function to reload the default configuration
reload_default() {
  echo "Reloading the default configuration..."
  cp "$DEFAULT_CONFIG_FILE" "$TEMP_CONFIG_FILE"
  echo "Default configuration reloaded."
}

save_file() {
  strip_comments $CONFIG_FILE
  echo "Configuration file saved to $CONFIG_FILE."
  exit 0
}

# Function to choose the editor
choose_editor() {
  local with_timeout=$1

  while true; do
    echo "Choose an editor to edit the JSON configuration file:"
    echo "1) nano"
    echo "2) vi"

    if [ "$with_timeout" = true ]; then
      echo "You have 10 seconds to make a choice (default: load default configuration and exit)."
      read -t $TIMEOUT -p "Enter your choice (1 or 2): " editor_choice
      if [ $? -ne 0 ]; then
        echo "No choice made within 10 seconds. Loading default configuration..."
        save_file
      fi
    else
      read -p "Enter your choice (1 or 2): " editor_choice
    fi

    case "$editor_choice" in
      1)
        edit_json "nano"
        break
        ;;
      2)
        edit_json "vi"
        break
        ;;
      *)
        echo "Invalid choice. Please enter '1' for nano or '2' for vi."
        ;;
    esac
  done
}

# Main script logic
reload_default
choose_editor true

while true; do
  # Validate the JSON configuration file
  if validate_json; then
    echo "JSON configuration file is valid."
    save_file
  else
    echo "JSON configuration file is invalid."

    # Ask the user if they want to edit the configuration file or reload the default configuration
    while true; do
      read -p "Do you want to edit the configuration file (e) or reload the default configuration (r)? (e/r): " choice
      case "$choice" in
        [eE])
          choose_editor false
          break
          ;;
        [rR])
          reload_default
          choose_editor false
          break
          ;;
        *)
          echo "Invalid choice. Please enter 'e' to edit or 'r' to reload."
          ;;
      esac
    done
  fi
done
