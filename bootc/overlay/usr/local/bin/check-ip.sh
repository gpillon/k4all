#!/bin/bash

source /usr/local/bin/k4all-utils

extract_ips_from_cidr() {
    local cidr=$1
    python -c "import ipaddress; [print(ip) for ip in ipaddress.ip_network('$cidr', strict=False)]"
}

extract_ips_from_range() {
    IFS='-' read -r start end <<< "$1"
    start_ip=$(echo $start | awk -F '.' '{ print $1*256*256*256 + $2*256*256 + $3*256 + $4 }')
    end_ip=$(echo $end | awk -F '.' '{ print $1*256*256*256 + $2*256*256 + $3*256 + $4 }')
    for ip in $(seq $start_ip $end_ip); do
        echo $(echo -n $(($ip>>24)) ; echo -n .$(($ip>>16&255)) ; echo -n .$(($ip>>8&255)) ; echo .$(($ip&255)))
    done
}

any_ip_available=0

CNI_TYPE=$(jq -r '.networking.cni.type // "calico"' "$K4ALL_CONFIG_FILE")
CILIUM_L2=$(jq -r '.cni.cilium.l2announcements // "false"' "$K4ALL_CONFIG_FILE")

if [ "$CNI_TYPE" = "cilium" ] && [ "$CILIUM_L2" = "true" ]; then
    echo "Cilium L2 announcements active — checking CiliumLoadBalancerIPPool..."
    ip_pools=$(kubectl get ciliumloadbalancerippools.cilium.io -o json 2>/dev/null | jq -r '.items[].spec.blocks[].cidr // empty' 2>/dev/null || echo "")
else
    echo "Checking MetalLB IPAddressPools..."
    ip_pools=$(kubectl get ipaddresspools.metallb.io -o json -n metallb-system 2>/dev/null | jq -r '.items[].spec.addresses[]' 2>/dev/null || echo "")
fi

if [ -z "$ip_pools" ]; then
    echo "No IP pools found."
    exit 1
fi

echo "Checking IPs for usage..."
for range in $ip_pools; do
    if [[ "$range" == *"/"* ]]; then
        ips_in_range=$(extract_ips_from_cidr "$range")
    else
        ips_in_range=$(extract_ips_from_range "$range")
    fi
    for ip in $ips_in_range; do
        if ! kubectl get svc --all-namespaces -o json | jq -e --arg IP "$ip" '.items[] | select(.spec.type == "LoadBalancer") | .status.loadBalancer.ingress[].ip == $IP' > /dev/null 2>&1; then
            echo "IP $ip is available"
            any_ip_available=1
        else
            echo "IP $ip is already in use"
        fi
    done
done

if [ "$any_ip_available" -eq 1 ]; then
    echo "At least one IP is available."
    exit 0
else
    echo "No IPs are available."
    exit 1
fi
