#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste

if [ -f "/var/lib/setup-dashboard.done" ]; then
  echo "Dashboard setup already done. Exiting."
  exit 0
fi

# Add kubernetes-dashboard repository
helm --kubeconfig=/root/.kube/config repo add kubernetes-dashboard https://kubernetes.github.io/dashboard/
# Deploy a Helm Release named "kubernetes-dashboard" using the kubernetes-dashboard chart
helm --kubeconfig=/root/.kube/config upgrade --install kubernetes-dashboard kubernetes-dashboard/kubernetes-dashboard --create-namespace --namespace kubernetes-dashboard
# Create Dashboard Users
kubectl --kubeconfig=/root/.kube/config apply -f /usr/local/share/dashboard-users.yaml
kubectl --kubeconfig=/root/.kube/config patch service kubernetes-dashboard-kong-proxy -n kubernetes-dashboard --type='json' -p='[{"op":"replace","path":"/spec/type","value":"NodePort"},{"op":"add","path":"/spec/ports/0/nodePort","value":32323}]'

printf '\n
#echo "Get the dashboard token with"
#echo "kubectl get secret admin-user -n kubernetes-dashboard -o jsonpath={\".data.token\"} | base64 -d"
HOST_IP=$(hostname -I | awk '"'"'{print $1}'"'"')
echo ""
echo "Welcome! Connect to the dashbord using those addresses: "
if [ -f /etc/login_data ]; then
    cat /etc/login_data
fi
echo " - Nodeport Fallback Route: https://$HOST_IP:32323"
echo ""
echo "Using this token"
echo "$(kubectl get secret admin-user -n kubernetes-dashboard -o jsonpath={".data.token"} | base64 -d)"
echo ""

' >> /root/.bash_profile

# Crea il file di stato per indicare che l'installazione è stata completata
touch /var/lib/setup-dashboard.done