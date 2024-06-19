#!/bin/bash

set -euxo pipefail

dmsetup remove_all -f

DISK=$(/usr/local/bin/disk-helper.sh)
#edit-disk.sh
/usr/local/bin/edit-disk.sh

/usr/bin/coreos-installer install /dev/$DISK --ignition-file /usr/local/bin/k8s.ign
