#!/bin/bash

set -euxo pipefail

dmsetup remove_all -f

/usr/bin/coreos-installer install /dev/sda --ignition-file /usr/local/bin/k8s.ign
