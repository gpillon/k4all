#!/bin/bash

# Function to handle CIDR with Python
extract_ips_from_cidr() {
    local cidr=$1
    python -c "import ipaddress; [print(ip) for ip in ipaddress.ip_network('$cidr', strict=False)]"
}

# Function to handle IP ranges
extract_ips_from_range() {
    IFS='-' read -r start end <<< "$1"
    start_ip=$(echo $start | awk -F '.' '{ print $1*256*256*256 + $2*256*256 + $3*256 + $4 }')
    end_ip=$(echo $end | awk -F '.' '{ print $1*256*256*256 + $2*256*256 + $3*256 + $4 }')

    for ip in $(seq $start_ip $end_ip); do
        echo $(echo -n $(($ip>>24)) ; echo -n .$(($ip>>16&255)) ; echo -n .$(($ip>>8&255)) ; echo .$(($ip&255)))
    done
}

# Flag to track availability of at least one IP
any_ip_available=0

# Fetch all IP address pools from the MetalLB CRD
ip_pools=$(kubectl get ipaddresspools.metallb.io -o json -n metallb-system | jq -r '.items[].spec.addresses[]')

# Check each IP in the pools
echo "Checking IPs for usage..."
for range in $ip_pools; do
    if [[ "$range" == *"/"* ]]; then
        # CIDR notation
        ips_in_range=$(extract_ips_from_cidr "$range")
    else
        # IP range
        ips_in_range=$(extract_ips_from_range "$range")
    fi
    for ip in $ips_in_range; do
        # Check if the IP is used by any service
        if ! kubectl get svc --all-namespaces -o json | jq -e --arg IP "$ip" '.items[] | select(.spec.type == "LoadBalancer") | .status.loadBalancer.ingress[].ip == $IP' > /dev/null; then
            echo "IP $ip is available"
            any_ip_available=1
        else
            echo "IP $ip is already in use"
        fi
    done
done

# Exit with status based on availability of IPs
if [ "$any_ip_available" -eq 1 ]; then
    echo "At least one IP is available."
    exit 0
else
    echo "No IPs are available."
    exit 1
fi
