#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/setup-ingress.done" ]; then
  echo "Ingress setup already done. Exiting."
  exit 0
fi

source /var/opt/k4all/bin/control-plane-utils

HOME=/root/
CLUSTER_IP=$(get_cluster_ip)
CNI_TYPE=$(jq -r '.networking.cni.type // "calico"' "$K4ALL_CONFIG_FILE")

NGINX_ENABLED=$(jq -r '.ingress.nginx.enabled // "true"' "$K4ALL_CONFIG_FILE")
NGINX_DEDICATED_IP=$(jq -r '.ingress.nginx.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
NGINX_IS_DEFAULT=$(jq -r '.ingress.nginx.isDefault // "true"' "$K4ALL_CONFIG_FILE")

CILIUM_INGRESS_ENABLED=$(jq -r '.ingress.cilium.enabled // "false"' "$K4ALL_CONFIG_FILE")
CILIUM_INGRESS_DEDICATED_IP=$(jq -r '.ingress.cilium.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
CILIUM_INGRESS_IS_DEFAULT=$(jq -r '.ingress.cilium.isDefault // "false"' "$K4ALL_CONFIG_FILE")

HA_TYPE=$(jq -r '.cluster.ha.type // "none"' "$K4ALL_CONFIG_FILE")

# --- NGINX Ingress Controller ---
if [ "$NGINX_ENABLED" = "true" ]; then
  echo "Installing NGINX Ingress Controller..."

  HELM_ARGS=()

  HELM_ARGS+=(--set controller.service.type=LoadBalancer)
  HELM_ARGS+=(--set controller.service.labels."k4all-ingress"="nginx")

  if [ -n "$NGINX_DEDICATED_IP" ]; then
    HELM_ARGS+=(--set controller.hostNetwork=false)
    HELM_ARGS+=(--set controller.service.loadBalancerIP="$NGINX_DEDICATED_IP")
  else
    HELM_ARGS+=(--set controller.service.externalIPs[0]="$CLUSTER_IP")
    HELM_ARGS+=(--set controller.service.loadBalancerIP="$CLUSTER_IP")
  fi 

  if [ "$HA_TYPE" = "kubevip" ] && [ "$NGINX_DEDICATED_IP" != "true" ]; then
    HELM_ARGS+=(--set controller.service.loadBalancerClass=kube-vip.io/kube-vip-class)
  fi

  if [ "$NGINX_IS_DEFAULT" = "true" ]; then
    HELM_ARGS+=(--set controller.ingressClassResource.default=true)
  else
    HELM_ARGS+=(--set controller.ingressClassResource.default=false)
  fi

  # if not NGINX_DEDICATED_IP, HA_TYPE is not kubevip and NGINX_IS_DEFAULT = true, then set set controller.hostPort=true
  if [ -z "$NGINX_DEDICATED_IP" ] && [ "$HA_TYPE" != "kubevip" ] && [ "$NGINX_IS_DEFAULT" = "true" ]; then
    echo "Setting controller.hostPort=true because NGINX_DEDICATED_IP is not set, HA_TYPE is none and NGINX_IS_DEFAULT is true"
    HELM_ARGS+=(--set controller.hostPort.enabled=true)
    HELM_ARGS+=(--set controller.service.type=ClusterIP)
  else
    echo "Setting controller.hostPort=false because NGINX_DEDICATED_IP is set, HA_TYPE is not none or NGINX_IS_DEFAULT is not true"
    HELM_ARGS+=(--set controller.hostPort.enabled=false)
  fi

  helm upgrade --kubeconfig=/etc/kubernetes/admin.conf --install ingress-nginx ingress-nginx \
    --repo https://kubernetes.github.io/ingress-nginx --version 4.14.3 \
    --namespace ingress-nginx --create-namespace -f /usr/local/share/ingress-values.yaml --timeout 30m \
    "${HELM_ARGS[@]}"
fi

# # --- Cilium Ingress Controller ---
# # This is actually done in setup-cni-cilium.sh
# # Cilium ingress is configured via Helm in setup-cni-cilium.sh (ingressController.enabled).
# # Here we only set the default annotation if needed.
# if [ "$CILIUM_INGRESS_ENABLED" = "true" ] && [ "$CILIUM_INGRESS_IS_DEFAULT" = "true" ]; then
#   echo "Marking Cilium as the default IngressClass..."
#   while ! kubectl --kubeconfig=/etc/kubernetes/admin.conf get ingressclass cilium 2>/dev/null; do
#     echo "Waiting for cilium IngressClass to appear..."
#     sleep 5
#   done
#   kubectl --kubeconfig=/etc/kubernetes/admin.conf annotate ingressclass cilium \
#     ingressclass.kubernetes.io/is-default-class=true --overwrite
# fi

# # If Cilium ingress has a dedicated IP, create a Service with loadBalancerIP
# if [ "$CILIUM_INGRESS_ENABLED" = "true" ] && [ -n "$CILIUM_INGRESS_DEDICATED_IP" ]; then
#   echo "Creating Cilium Ingress Service with dedicated IP $CILIUM_INGRESS_DEDICATED_IP..."
#   cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
# apiVersion: v1
# kind: Service
# metadata:
#   name: cilium-ingress-lb
#   namespace: kube-system
#   labels:
#     k4all.io/component: cilium-ingress
# spec:
#   type: LoadBalancer
#   loadBalancerIP: "$CILIUM_INGRESS_DEDICATED_IP"
#   selector:
#     k8s-app: cilium
#   ports:
#     - name: http
#       port: 80
#       targetPort: 8080
#       protocol: TCP
#     - name: https
#       port: 443
#       targetPort: 8443
#       protocol: TCP
# EOF
# fi

# --- Apply dashboard/headlamp ingress routes ---
while true; do
  if kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f /usr/local/share/headlamp-ingress-routes.yaml; then
    break
  else
    echo "Failed to apply Ingress routes configuration. Retrying in 10 seconds..."
    sleep 10
  fi
done

touch /opt/k4all/setup-ingress.done
