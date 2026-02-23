#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/feature-gateway-setup.done" ]; then
  echo "Gateway API setup already done. Exiting."
  exit 0
fi

HOME=/root/
source /usr/local/bin/k4all-utils

GWAPI_VERSION=$(curl -sL https://api.github.com/repos/kubernetes-sigs/gateway-api/releases/latest | jq -r '.tag_name')

kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f \
  "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GWAPI_VERSION}/standard-install.yaml"

helm --kubeconfig=/etc/kubernetes/admin.conf repo add kong https://charts.konghq.com
helm --kubeconfig=/etc/kubernetes/admin.conf repo update kong

helm --kubeconfig=/etc/kubernetes/admin.conf upgrade --install kong kong/ingress \
  --create-namespace --namespace kong \
  -f /usr/local/share/kong-values.yaml \
  --timeout 10m

kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f - <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: kong
  annotations:
    konghq.com/gatewayclass-unmanaged: "true"
spec:
  controllerName: konghq.com/kic-gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: kong
  namespace: kong
spec:
  gatewayClassName: kong
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: All
  - name: https
    protocol: HTTPS
    port: 443
    allowedRoutes:
      namespaces:
        from: All
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: kong-default-tls
        namespace: kong
EOF

touch /opt/k4all/feature-gateway-setup.done
