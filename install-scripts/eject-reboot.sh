#!/bin/bash

set -euxo pipefail

# Function to force eject the CD-ROM
try_eject() {
  # Check if /dev/sr0 exists

  if [ -e /dev/sr0 ]; then
    # Try to eject the CD-ROM and handle potential failures gracefully
    eject /dev/sr0 &> /dev/null || echo "Failed to eject CD-ROM /dev/sr0"
  else
    echo "CD-ROM device not found."
  fi
}

# Call the function to force eject the CD-ROM
printf "\n\n"

echo "Installation Complete :) Please remove the Installation Media. Rebooting in 5 seconds" | tee /dev/tty1
sleep 5

try_eject

# Prompt system-wide to manually remove the CD-ROM

reboot
		  