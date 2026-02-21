#!/bin/bash

set -euxo pipefail

# Run the IP availability check script
check-ip.sh
generate-kubelet-config.sh

# Check the exit status of the IP check script
if [ $? -eq 0 ]; then
    echo "At least one IP is available. Proceeding with LoadBalancer Service and ConfigMap update..."

    source /usr/local/bin/control-plane-utils

    # Check if the service already exists
    if ! kubectl get svc kube-api-server-lb -n kube-system > /dev/null 2>&1; then
        echo "Service kube-api-server-lb does not exist. Creating service..."
        # Create the LoadBalancer service in kube-system namespace
        kubectl apply -f - << EOF
apiVersion: v1
kind: Service
metadata:
  name: kube-api-server-lb
  namespace: kube-system
spec:
  type: LoadBalancer
  ports:
    - protocol: TCP
      port: 6443
      targetPort: 6443
  selector:
    component: kube-apiserver
    tier: control-plane
EOF
        # Wait for the IP address to be assigned to the service
        echo "Waiting for IP assignment to kube-api-server-lb service..."
        while true; do
            LB_IP=$(kubectl get svc kube-api-server-lb -n kube-system --template="{{range .status.loadBalancer.ingress}}{{.ip}}{{end}}")
            if [[ ! -z "$LB_IP" ]]; then
                echo "Assigned IP is $LB_IP"
                break
            fi
            echo "Waiting for load balancer IP..."
            sleep 10
        done
    else
        echo "Service kube-api-server-lb already exists. Fetching assigned IP..."
        # Fetch the assigned LoadBalancer IP if the service already exists
        LB_IP=$(kubectl get svc kube-api-server-lb -n kube-system --template="{{range .status.loadBalancer.ingress}}{{.ip}}{{end}}")
        echo "Assigned IP is $LB_IP"
    fi

    CONTROL_PLANE_ENDPOINT="$LB_IP:6443"

    # Fetch the current configuration from the ConfigMap
    cluster_config=$(kubectl get configmap kubeadm-config -n kube-system -o json | jq -r '.data.ClusterConfiguration')

    # Update the controlPlaneEndpoint using yq
    updated_config=$(echo "$cluster_config" | yq e ".controlPlaneEndpoint = \"$CONTROL_PLANE_ENDPOINT\"" - | jq -aRs .)

    # Apply the updated configuration back to the ConfigMap
    kubectl patch configmap kubeadm-config -n kube-system --type merge -p "{\"data\":{\"ClusterConfiguration\": $updated_config}}"
    echo "ConfigMap kubeadm-config updated with Load Balancer IP and Port"

    echo "ConfigMap kubeadm-config updated with Load Balancer IP and Port"

    # Ensure the ClusterConfiguration and apiServer.certSANs exists
    yq e -i "select(.kind == \"ClusterConfiguration\").apiServer.certSANs |= . // []" $CONFIG_FILE

    # Add the current and new LB IP to certSANs if they do not exist
    add_ip_if_not_exists "$CURRENT_IP"
    add_ip_if_not_exists "$LB_IP"

    echo "Updated k8s-config.yaml with the current IP ($CURRENT_IP) and new LB_IP ($LB_IP) in certSANs."

    mkdir -p /root/cert-backup
    mv /etc/kubernetes/pki/apiserver.* /root/cert-backup/


    kubeadm init phase certs apiserver --config /etc/k8s-config.yaml

    systemctl restart kubelet

else
    echo "No available IPs found. Exiting..."
    exit 1
fi
