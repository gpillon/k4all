#!/bin/bash
set -euxo pipefail

if [ -f "/opt/k4all/setup-ph3-reset-kube.done" ]; then
  echo "Kubernetes setup phase 3 reset Kube already done. Skipping."
else 
  kubeadm reset --force
  touch /opt/k4all/setup-ph3-reset-kube.done
  rm -rf /opt/k4all/setup-ph3.done
fi

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-ph3.done" ]; then
  echo "Kubernetes setup phase 3 already done. Exiting."
  exit 0
fi

source /usr/local/bin/control-plane-utils

function setup_k8s_for_vip()  {
  
  #get EP from the config file
  haEndpoint=$(get_ha_ep_ip)
  interface=$(jq -r '.node.ha.interface' $K4ALL_CONFIG_FILE)

  if [ "$interface" == "auto" ]; then
    NET_DEV=$(ip route show default | awk '/default/ {print $5}')
    vip_interface=$NET_DEV
  else
    vip_interface=$interface
  fi
  
  # Add the current and new LB IP to certSANs if they do not exist
  add_ip_if_not_exists "$CURRENT_IP"
  add_ip_if_not_exists "$haEndpoint"

  set_control_plane_endpoint "$haEndpoint"
}

function setup_for_kubevip() {
  setup_k8s_for_vip

  KVVERSION=$(curl -sL https://api.github.com/repos/kube-vip/kube-vip/releases | jq -r ".[0].name")

  echo "
apiVersion: v1
kind: Pod
metadata:
  creationTimestamp: null
  name: kube-vip
  namespace: kube-system
spec:
  containers:
  - args:
    - manager
    env:
    - name: vip_arp
      value: \"true\"
    - name: port
      value: \"6443\"
    - name: vip_nodename
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: vip_interface
      value: \"$vip_interface\"
    - name: vip_cidr
      value: \"32\"
    - name: dns_mode
      value: first
    - name: cp_enable
      value: \"true\"
    - name: cp_namespace
      value: kube-system
    - name: svc_enable
      value: \"true\"
    - name: svc_leasename
      value: plndr-svcs-lock
    - name: vip_leaderelection
      value: \"true\"
    - name: vip_leasename
      value: plndr-cp-lock
    - name: vip_leaseduration
      value: \"5\"
    - name: vip_renewdeadline
      value: \"3\"
    - name: vip_retryperiod
      value: \"1\"
    - name: address
      value: \"$haEndpoint\"
    - name: prometheus_server
      value: :2112
    - name: lb_class_only
      value: \"true\"
    image: ghcr.io/kube-vip/kube-vip:$KVVERSION
    imagePullPolicy: IfNotPresent
    name: kube-vip
    resources: {}
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
    volumeMounts:
    - mountPath: /etc/kubernetes/admin.conf
      name: kubeconfig
  hostAliases:
  - hostnames:
    - kubernetes
    ip: 127.0.0.1
  hostNetwork: true
  volumes:
  - hostPath:
      path: /etc/kubernetes/super-admin.conf
    name: kubeconfig
status: {}
" > /etc/kubernetes/manifests/kube-vip.yaml
}

function setup_for_keepalived() {
  setup_k8s_for_vip

  # Set keepalived state based on /etc/node-type
  if [ "$(cat /etc/node-type)" == "bootstrap" ]; then
    keepalived_state="MASTER"
  else
    keepalived_state="BACKUP"
  fi

  apiControlEndpointSubnetSize=$(jq -r '.node.ha.apiControlEndpointSubnetSize' $K4ALL_CONFIG_FILE)

  echo "vrrp_instance VI_1 {
  state $keepalived_state
  interface $vip_interface
  virtual_router_id 56
  priority 255
  advert_int 1
  authentication {
    auth_type PASS
    auth_pass k4all-ultra-secret
  }
  virtual_ipaddress {
    $haEndpoint/$apiControlEndpointSubnetSize
  }
}
" > /etc/keepalived/keepalived.conf

  systemctl enable --now keepalived
    
}

# Check if the configuration is static and edit the Ignition file accordingly
if jq -e '.node.ha.type' "$K4ALL_CONFIG_FILE" | grep -q "keepalived"; then
  setup_for_keepalived
fi

# Check if the configuration is static and edit the Ignition file accordingly
if jq -e '.node.ha.type' "$K4ALL_CONFIG_FILE" | grep -q "kubevip"; then
  setup_for_kubevip
fi

touch /opt/k4all/setup-ph3.done