#!/bin/bash
set -euxo pipefail

# Controlla se il file di stato esiste
if [ -f "/opt/k4all/setup-ph3.done" ]; then
  echo "Kubernetes setup phase 3 already done. Exiting."
  exit 0
fi

source /usr/local/bin/control-plane-utils

function setup_for_keepalived() {

    #get EP from the config file
    haEndpoint=$(jq -r '.node.ha.apiControlEndpoint' $CONFIG_FILE)
    apiControlEndpointSubnetSize=$(jq -r '.node.ha.apiControlEndpointSubnetSize' $CONFIG_FILE)
    interface=$(jq -r '.node.ha.interface' $CONFIG_FILE)

    if [ "$interface" == "auto" ]; then
      NET_DEV=$(ip route show default | awk '/default/ {print $5}')
      keepalived_interface=$NET_DEV
    else
      keepalived_interface=$interface
    fi

    # Set keepalived state based on /etc/node-type
    if [ "$(cat /etc/node-type)" == "bootstrap" ]; then
      keepalived_state="MASTER"
    else
      keepalived_state="BACKUP"
    fi
    
    # Ensure the ClusterConfiguration and apiServer.certSANs exists
    yq e -i "select(.kind == \"ClusterConfiguration\").apiServer.certSANs |= . // []" $K8S_CONFIG_FILE

    # Add the current and new LB IP to certSANs if they do not exist
    add_ip_if_not_exists "$CURRENT_IP"
    add_ip_if_not_exists "$haEndpoint"

    set_control_plane_endpoint "$haEndpoint"

    echo "
vrrp_instance VI_1 {
        state $keepalived_state
        interface $keepalived_interface
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
if jq -e '.node.ha.type' "$CONFIG_FILE" | grep -q "keepalived"; then
  setup_for_keepalived
fi

touch /opt/k4all/setup-ph3.done