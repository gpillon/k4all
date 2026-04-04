#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/setup-nginx-ingress.done" ]; then
  echo "NGINX Ingress setup already done. Exiting."
  exit 0
fi

source /var/opt/k4all/bin/control-plane-utils

HOME=/root/
CLUSTER_IP=$(get_cluster_ip)
NGINX_VERSION=$(get_component_version ingress-nginx)
NGINX_REPO=$(get_component_repo ingress-nginx)
NGINX_CHART=$(get_component_chart ingress-nginx)
NGINX_NS=$(get_component_namespace ingress-nginx)

NGINX_ENABLED=$(jq -r '.ingress.nginx.enabled // "true"' "$K4ALL_CONFIG_FILE")
NGINX_DEDICATED_IP=$(jq -r '.ingress.nginx.dedicatedIP // ""' "$K4ALL_CONFIG_FILE")
NGINX_IS_DEFAULT=$(jq -r '.ingress.nginx.isDefault // "true"' "$K4ALL_CONFIG_FILE")
HA_TYPE=$(jq -r '.cluster.ha.type // "none"' "$K4ALL_CONFIG_FILE")

if [ "$NGINX_ENABLED" != "true" ]; then
  echo "NGINX Ingress is disabled in configuration. Skipping."
  touch /opt/k4all/setup-nginx-ingress.done
  exit 0
fi

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

if [ -z "$NGINX_DEDICATED_IP" ] && [ "$HA_TYPE" != "kubevip" ] && [ "$NGINX_IS_DEFAULT" = "true" ]; then
  echo "Setting controller.hostPort=true because NGINX_DEDICATED_IP is not set, HA_TYPE is none and NGINX_IS_DEFAULT is true"
  HELM_ARGS+=(--set controller.hostPort.enabled=true)
  HELM_ARGS+=(--set controller.service.type=ClusterIP)
else
  echo "Setting controller.hostPort=false because NGINX_DEDICATED_IP is set, HA_TYPE is not none or NGINX_IS_DEFAULT is not true"
  HELM_ARGS+=(--set controller.hostPort.enabled=false)
fi

helm upgrade --kubeconfig=/etc/kubernetes/admin.conf --install ingress-nginx "${NGINX_CHART}" \
  --repo "${NGINX_REPO}" --version "${NGINX_VERSION}" \
  --namespace "${NGINX_NS}" --create-namespace -f /usr/local/share/ingress-values.yaml --timeout 30m \
  "${HELM_ARGS[@]}"

touch /opt/k4all/setup-nginx-ingress.done
