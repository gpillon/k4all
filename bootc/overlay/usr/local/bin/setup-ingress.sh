#!/bin/bash
# DEPRECATED: This script is kept for backward compatibility.
# The logic has been split into:
#   - setup-nginx-ingress.sh  (NGINX Ingress Controller installation)
#   - setup-ingress-routes.sh (Ingress route configuration)
set -euxo pipefail

if [ -f "/opt/k4all/setup-ingress.done" ]; then
  echo "Ingress setup already done. Exiting."
  exit 0
fi

/usr/local/bin/setup-nginx-ingress.sh || true
/usr/local/bin/setup-ingress-routes.sh || true

touch /opt/k4all/setup-ingress.done
