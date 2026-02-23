#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/setup-headlamp.done" ]; then
  echo "Headlamp setup already done. Exiting."
  exit 0
fi

HOME=/root/
source /usr/local/bin/k4all-utils

helm --kubeconfig=/etc/kubernetes/admin.conf repo add headlamp https://kubernetes-sigs.github.io/headlamp/
helm --kubeconfig=/etc/kubernetes/admin.conf upgrade --install headlamp headlamp/headlamp \
  --create-namespace --namespace headlamp \
  -f /usr/local/share/headlamp-values.yaml

kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f /usr/local/share/headlamp-users.yaml

kubectl --kubeconfig=/etc/kubernetes/admin.conf patch service headlamp -n headlamp \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/type","value":"NodePort"},{"op":"add","path":"/spec/ports/0/nodePort","value":32323}]'

if grep -q "#### K4ALL HELPER ####" /root/.bash_profile; then
  echo "Existing helper block found. Deleting it."
  remove_tagged_block "/root/.bash_profile" "K4ALL HELPER" "END K4ALL HELPER"
fi

printf '\n
#### K4ALL HELPER ####
#### pls, DO NOT REMOVE "K4ALL HELPER" tags, or you could mess up updates :) ###

HOST_IP=$(hostname -I | awk '"'"'{print $1}'"'"')
echo ""
echo "Welcome! Connect to Headlamp using those addresses: "
if [ -f /etc/login_data ]; then
    cat /etc/login_data
fi
echo " - Nodeport Fallback Route: http://$HOST_IP:32323"
echo ""
echo "Using this token"
echo "$(kubectl get secret admin-user -n headlamp -o jsonpath={".data.token"} | base64 -d)"
echo ""
#### END K4ALL HELPER ####
' >> /root/.bash_profile

touch /opt/k4all/setup-headlamp.done
