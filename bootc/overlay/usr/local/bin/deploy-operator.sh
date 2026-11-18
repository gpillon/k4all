#!/bin/bash
# K4All - Deploy Operator
# Applies the ClusterConfig CR, creates the ReleaseManifest CR,
# and deploys the k4all-operator from a GitHub release.
set -euo pipefail

source /usr/local/bin/k4all-utils

DONE_FILE="/opt/k4all/operator-deployed.done"
# shellcheck disable=SC2034 # unused, kept
DEFAULT_CONFIG="/usr/local/share/k4all-config.yaml.default"

if [ -f "$DONE_FILE" ]; then
    echo "Operator already deployed. Exiting."
    exit 0
fi

RELEASE_MANIFEST="/etc/k4all-release.yaml"
CONFIG_YAML="/etc/k4all-config.yaml"
OPERATOR_INSTALL_YAML="/tmp/k4all-operator-install.yaml"
KUBECONFIG="/var/roothome/.kube/config"
export KUBECONFIG

MAX_WAIT=300
INTERVAL=5

# =========================================================================
# Wait for the API server to become ready
# =========================================================================
wait_for_api_server() {
    echo "Waiting for Kubernetes API server..."
    local elapsed=0
    while ! kubectl get --raw="/readyz" &>/dev/null; do
        sleep "$INTERVAL"
        elapsed=$((elapsed + INTERVAL))
        if [ "$elapsed" -ge "$MAX_WAIT" ]; then
            echo "ERROR: API server not ready after ${MAX_WAIT}s"
            exit 1
        fi
    done
    echo "API server is ready."
}

# =========================================================================
# Apply the ClusterConfig CR directly from /etc/k4all-config.yaml
# =========================================================================
apply_cluster_config() {
    echo "Applying ClusterConfig CR from $CONFIG_YAML ..."
    if [ ! -f "$CONFIG_YAML" ]; then
        echo "ERROR: $CONFIG_YAML not found"
        exit 1
    fi
    kubectl apply --validate=ignore -f "$CONFIG_YAML"
    echo "ClusterConfig CR applied."
}

# =========================================================================
# Create the ReleaseManifest CR from /etc/k4all-release.yaml
# =========================================================================
create_release_manifest_cr() {
    echo "Creating ReleaseManifest CR ..."
    if [ ! -f "$RELEASE_MANIFEST" ]; then
        echo "ERROR: $RELEASE_MANIFEST not found"
        exit 1
    fi
    kubectl apply -f "$RELEASE_MANIFEST"
    echo "ReleaseManifest CR applied."
}

# =========================================================================
# Deploy the k4all-operator from the release manifest
# =========================================================================
deploy_operator() {
    echo "Deploying k4all-operator..."

    # Read the operator source URL template from the release manifest
    local source_template version version_url
    source_template=$(yq e '.spec.components.k4all-operator.source' "$RELEASE_MANIFEST")
    version=$(yq e '.spec.components.k4all-operator.version' "$RELEASE_MANIFEST")

    if [ -z "$source_template" ] || [ "$source_template" = "null" ]; then
        echo "WARNING: k4all-operator source not found in release manifest"
        echo "Attempting to apply baked-in operator manifests..."
        if [ -f /usr/local/share/k4all-operator-install.yaml ]; then
            kubectl apply -f /usr/local/share/k4all-operator-install.yaml
            echo "Baked-in operator manifests applied."
            return
        fi
        echo "ERROR: No operator manifests available"
        exit 1
    fi

    # Resolve "latest" version from GitHub API
    if [ "$version" = "latest" ]; then
        version_url=$(yq e '.spec.components.k4all-operator.versionUrl' "$RELEASE_MANIFEST")
        if [ -n "$version_url" ] && [ "$version_url" != "null" ]; then
            echo "Resolving latest version from $version_url ..."
            # Same rule as the operator's resolver: newest stable release
            version=$(curl -sL "$version_url" \
                | jq -r '[.[] | select(.prerelease == false and .draft == false)][0].tag_name // empty')
            if [ -z "$version" ] || [ "$version" = "null" ]; then
                echo "WARNING: Could not resolve latest version, using 'latest' tag"
                version="latest"
            else
                echo "Resolved version: $version"
            fi
        fi
    fi

    # Replace {{ version }} placeholder in source URL
    local source_url="${source_template//\{\{ version \}\}/$version}"
    source_url="${source_url//\{\{version\}\}/$version}"

    echo "Downloading operator manifest from: $source_url"
    if curl -sfL "$source_url" -o "$OPERATOR_INSTALL_YAML"; then
        kubectl apply -f "$OPERATOR_INSTALL_YAML"
        rm -f "$OPERATOR_INSTALL_YAML"
        echo "k4all-operator deployed successfully."
    else
        echo "WARNING: Failed to download operator manifest from release"
        echo "Attempting to apply baked-in operator manifests..."
        if [ -f /usr/local/share/k4all-operator-install.yaml ]; then
            kubectl apply -f /usr/local/share/k4all-operator-install.yaml
            echo "Baked-in operator manifests applied as fallback."
        else
            echo "ERROR: No operator manifests available"
            exit 1
        fi
    fi
}

# =========================================================================
# Main
# =========================================================================
echo "=== K4All Operator Deployment ==="

wait_for_api_server

# Apply CRDs first (needed before the CRs can be created)
deploy_operator

# Now apply the CRs
apply_cluster_config
create_release_manifest_cr

echo "=== K4All Operator Deployment Complete ==="
touch "$DONE_FILE"

# Pods that started on CRI-O's bridge, lent to this node until the operator
# installs the cluster's CNI, hold addresses no other node can route
# (coredns among them). Once the CNI is there, start them again on it and
# drop the bridge. In the background: this unit must not wait for Calico.
if [ -e "$K4ALL_CNI_MARKER" ]; then
    # Restart: pods that cannot be listed or deleted now are tried again.
    systemd-run --unit k4all-crio-bridge-handover --collect --quiet \
        --property=Restart=on-failure --property=RestartSec=60 \
        --setenv=KUBECONFIG=/etc/kubernetes/admin.conf \
        bash -c 'source /usr/local/bin/k4all-utils; handover_crio_bridge 1800' \
        || echo "WARNING: could not start the CNI handover; generate_join.sh does it"
fi