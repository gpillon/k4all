#!/bin/bash

set -euxo pipefail

echo "Running pre-install script..."
# Pre-install script

DISK=$(/usr/local/bin/disk-helper.sh)
/usr/local/bin/edit-disk.sh
/usr/local/bin/edit_network.sh
/usr/local/bin/include_config.sh

# end of pre-install script
echo "Pre-install script complete."
