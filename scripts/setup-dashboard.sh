#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-dashboard.done" ]; then
  echo "Dashboard setup already done. Exiting."
  exit 0
fi

HOME=/root/

# Add kubernetes-dashboard repository
helm --kubeconfig=/etc/kubernetes/admin.conf repo add kubernetes-dashboard https://kubernetes.github.io/dashboard/
# Deploy a Helm Release named "kubernetes-dashboard" using the kubernetes-dashboard chart
helm --kubeconfig=/etc/kubernetes/admin.conf upgrade --install kubernetes-dashboard kubernetes-dashboard/kubernetes-dashboard --create-namespace --namespace kubernetes-dashboard
# Create Dashboard Users
kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f /usr/local/share/dashboard-users.yaml
kubectl --kubeconfig=/etc/kubernetes/admin.conf patch service kubernetes-dashboard-kong-proxy -n kubernetes-dashboard --type='json' -p='[{"op":"replace","path":"/spec/type","value":"NodePort"},{"op":"add","path":"/spec/ports/0/nodePort","value":32323}]'

# Function to delete existing block in .bash_profile
remove_existing_dashboard_block() {
  sed -i '/#### K4ALL HELPER ####/,/#### END K4ALL HELPER ####/d' /root/.bash_profile
}

# Check if the block already exists and delete it
if grep -q "#### K4ALL HELPER ####" /root/.bash_profile; then
  echo "Existing dashboard block found. Deleting it."
  remove_existing_dashboard_block
fi

# Append new block
printf '\n
#### K4ALL HELPER ####
#### pls, DO NOT REMOVE "K4ALL HELPER" tags, or you could mess up updates :) ###

HOST_IP=$(hostname -I | awk '"'"'{print $1}'"'"')
echo ""
echo "Welcome! Connect to the dashboard using those addresses: "
if [ -f /etc/login_data ]; then
    cat /etc/login_data
fi
echo " - Nodeport Fallback Route: https://$HOST_IP:32323"
echo ""
echo "Using this token"
echo "$(kubectl get secret admin-user -n kubernetes-dashboard -o jsonpath={".data.token"} | base64 -d)"
echo ""
#### END K4ALL HELPER ####
' >> /root/.bash_profile

# Crea il file di stato per indicare che l'installazione è stata completata
touch /opt/k4all/setup-dashboard.done
