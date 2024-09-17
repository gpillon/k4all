#!/bin/bash
set -euo pipefail

TMP_SCRIPT_PATH="/tmp/update-node.sh"
TMP_UPDATED_SCRIPT_PATH="/tmp/updated-update-node.sh"

# Check if the script was launched directly or with bash
if [[ "$0" != $TMP_SCRIPT_PATH || "$0" != $TMP_UPDATED_SCRIPT_PATH ]]; then
    cp "$0" $TMP_SCRIPT_PATH
    sudo bash $TMP_SCRIPT_PATH
    exit 0
fi

NODE_TYPE=$(cat /etc/node-type)

IMAGE_TAG=${1:-latest}
CONTAINER_IMAGE="ghcr.io/gpillon/k4all:$IMAGE_TAG"

UPDATE_TMP_DIR=/tmp/update
UPDATE_TMP_DIR_K4ALL=$UPDATE_TMP_DIR/k4all
UPDATE_TMP_DIR_K4ALL_SRC=$UPDATE_TMP_DIR_K4ALL/src
DEST_FOLDER="$UPDATE_TMP_DIR/extracted_services"
CONTAINER_NAME="update-container"

version_le() {
    # Return 0 (true) if $1 < $2, else return 1 (false)
    [ "$1" = "$2" ] && return 1

    local IFS=.
    local i ver1=($1) ver2=($2)
    # Fill empty fields in ver1 with zeros
    for ((i=${#ver1[@]}; i<${#ver2[@]}; i++)); do
        ver1[i]=0
    done
    # Fill empty fields in ver2 with zeros
    for ((i=${#ver2[@]}; i<${#ver1[@]}; i++)); do
        ver2[i]=0
    done
    for ((i=0; i<${#ver1[@]}; i++)); do
        if ((10#${ver1[i]} < 10#${ver2[i]})); then
            return 0
        elif ((10#${ver1[i]} > 10#${ver2[i]})); then
            return 1
        fi
    done
    return 1
}

# Function to migrate configuration
migrate_config() {
    local old_version="$1"
    local new_version="$2"
    local config="$3"

    echo "Migrating config from version $old_version to $new_version" >&2

    # Examples of migration steps
    if [ "$old_version" = "0.0.0" ]; then
        echo "Performing migration steps from version 0.0.0" >&2
        # For example, set some default fields
        # config=$(echo "$config" | jq '.initialSetup = true')
    fi

    if [ "$old_version" = "1.0.0" ]; then
        echo "Performing migration steps from version 1.0.0" >&2
        # For example, modify a field
        # config=$(echo "$config" | jq '.existingField |= "updatedValue"')
    fi

    if [ "$new_version" = "2.0.0" ]; then
        echo "Performing migration steps to version 2.0.0" >&2
        # For example, remove a deprecated field
        # config=$(echo "$config" | jq 'del(.deprecatedField)')
    fi

    # Return the modified config
    echo "$config"
}

check_repos() {

    # Checking for differences in repo files
    REPO_SRC="$UPDATE_TMP_DIR_K4ALL_SRC/repo"
    HOST_REPO_FOLDER="/etc/yum.repos.d/"
    echo "Checking for differences in repo files..."
    for repo_file in "$REPO_SRC"/*; do
        base_repo_file=$(basename "$repo_file")
        if [ -f "$HOST_REPO_FOLDER/$base_repo_file" ]; then
            if ! diff "$repo_file" "$HOST_REPO_FOLDER/$base_repo_file" > /dev/null; then
                echo "Differences found in $base_repo_file. Exiting script. You probably need to update the cluster to a newer version. Use the --force flag if you want to update anyway."
                diff "$repo_file" "$HOST_REPO_FOLDER/$base_repo_file"
                exit 1
            else
                echo "No differences found in $base_repo_file."
            fi
        else
            echo "File $base_repo_file not found in $HOST_REPO_FOLDER."
        fi
    done
}

# Function to extract services from a Butane file, transform them into JSON, and create files
extract_services() {
    local file=$1
    local dest_folder=$2

    # Use yq to extract services and convert them to a JSON array
    yq -o=json '[(.systemd.units[] | select(.contents != null) | {"name": .name, "contents": .contents})]' "$file" |
    jq -c '.[]' | while IFS= read -r service; do
        # Extract name and content from JSON
        service_name=$(echo "$service" | jq -r '.name')
        service_contents=$(echo "$service" | jq -r '.contents')

        # Create a file with the service name and insert content
        echo "$service_contents" > "${dest_folder}/${service_name}"
    done
}

# Function to extract services and copy files defined in .storage.trees
extract_and_copy_trees() {
    local file=$1

    # Extraction and copying of files defined in .storage.trees
    yq -o=json '[.storage.trees[]? | {"local": .local, "path": .path}]' "$file" |
    jq -c '.[]' | while IFS= read -r entry; do
        local_src=$(echo "$entry" | jq -r '.local')
        local_dest=$(echo "$entry" | jq -r '.path')
        if [ -d "$UPDATE_TMP_DIR_K4ALL_SRC/$local_src" ]; then

            mkdir -p "$local_dest"
            cp -rpf "$UPDATE_TMP_DIR_K4ALL_SRC/$local_src/." "$local_dest"

            echo "Copied: $local_src -> $local_dest"
        fi
    done
}

extract_and_copy_files() {
    local file=$1

    # Extraction and analysis of files defined in .storage.files
    yq -o=json '[.storage.files[]?]' "$file" |
    jq -c '.[]' | while IFS= read -r entry; do
        local path=$(echo "$entry" | jq -r '.path')

        # Check if the content is specified inline or as a local file
        if echo "$entry" | jq -e '.contents.inline' > /dev/null; then
            # Inline content
            local contents=$(echo "$entry" | jq -r '.contents.inline')
            mkdir -p "$(dirname "$path")"
            echo "$contents" > "$path"
            echo "Created from inline: $path"
        elif echo "$entry" | jq -e '.contents.local' > /dev/null; then
            # Local content
            local local_src=$(echo "$entry" | jq -r '.contents.local')
            local src_path="${UPDATE_TMP_DIR_K4ALL_SRC}/${local_src}"
            if [ -f "$src_path" ]; then
                mkdir -p "$(dirname "$path")"
                cp -fp "$src_path" "$path"
                echo "Copied from local: $src_path -> $path"
            else
                echo "Local file not found: $src_path"
            fi
        else
            echo "No valid content found for $path"
        fi
    done
}

# Function to handle creation and chmod of directories
handle_directories() {
    local file=$1

    # Extraction of directory information
    yq -o=json '[.storage.directories[]?]' "$file" |
    jq -c '.[]' | while IFS= read -r directory; do
        local path=$(echo "$directory" | jq -r '.path')
        local user=$(echo "$directory" | jq -r '.user.name // .user.id // empty')
        local group=$(echo "$directory" | jq -r '.group.name // .group.id // empty')
        mkdir -p "$path"
        echo "Created directory: $path"
        
        # If user and group are specified, apply chown
        if [[ -n "$user" ]] && [[ -n "$group" ]]; then
            chown "$user":"$group" "$path"
            echo "Applied permissions to: $path for $user:$group"
        fi
    done
}

# Cleanup function to remove container and image
cleanup() {
    echo "Cleaning up..."
    podman rm $CONTAINER_NAME 2>/dev/null || true
    podman rmi $CONTAINER_IMAGE 2>/dev/null || true
}

update_config() {
    # Begin version check and config migration
    echo "Checking configuration versions..."

    # Paths to configuration files
    local default_config_file="$UPDATE_TMP_DIR_K4ALL_SRC/data/default-cluster-config.json"
    local stripped_default_config_file="/tmp/stripped-default-cluster-config.json"
    local current_config_file="/etc/k4all-config.json"
    local stripped_current_config_file="/tmp/stripped-k4all-config.json"

    # Backing up the current config file
    if [ -f "$current_config_file" ]; then
        cp "$current_config_file" "$current_config_file.$(date +%s).bck"
    fi

    # Clean comments from default-cluster-config.json
    sed '/^\s*\/\//d' "$default_config_file" > "$stripped_default_config_file"

    # Check if /etc/k4all-config.json exists and clean comments
    if [ -f "$current_config_file" ]; then
        sed '/^\s*\/\//d' "$current_config_file" > "$stripped_current_config_file"
    else
        # If file doesn't exist, create empty JSON
        echo '{}' > "$stripped_current_config_file"
    fi

    # Get versions from configuration files
    local current_version=$(jq -r '.version // "0.0.0"' "$stripped_current_config_file")
    local default_version=$(jq -r '.version' "$stripped_default_config_file")

    # Compare versions
    if version_le "$current_version" "$default_version"; then
        echo "Current version ($current_version) is less than or equal to default version ($default_version)."

        # Merge configurations, adding missing fields from default config
        local merged_config=$(jq -s '
        def deepmerge(a; b):
            if (a | type) == "object" and (b | type) == "object" then
                reduce (b | to_entries[]) as $item
                (a;
                    if .[$item.key] == null then .[$item.key] = $item.value
                    else .[$item.key] = deepmerge(.[$item.key]; $item.value) end)
            else a end;
        deepmerge(.[0]; .[1])' "$stripped_current_config_file" "$stripped_default_config_file")

        # Call migrate_config function
        merged_config=$(migrate_config "$current_version" "$default_version" "$merged_config")

        # Update version in merged_config
        merged_config=$(echo "$merged_config" | jq --arg new_version "$default_version" '.version = $new_version')

        # Write merged_config back to /etc/k4all-config.json
        echo "$merged_config" > "$current_config_file"

        echo "Updated /etc/k4all-config.json with new version $default_version."
    else
        echo "Current version ($current_version) is greater than default version ($default_version). No update needed."
    fi
}

# Trap to perform cleanup at the end of the script
trap cleanup EXIT

# Create folder to save services
mkdir -p "$UPDATE_TMP_DIR"
mkdir -p "$UPDATE_TMP_DIR_K4ALL"
mkdir -p "$DEST_FOLDER"

podman pull "$CONTAINER_IMAGE"
# Delete existing container if present
if podman container exists "$CONTAINER_NAME"; then
    podman rm -f "$CONTAINER_NAME"
fi

# Create the container
podman create --name "$CONTAINER_NAME" --replace "$CONTAINER_IMAGE"
podman cp "$CONTAINER_NAME:/src" "$UPDATE_TMP_DIR_K4ALL"

check_repos
update_config

# Add call to handle_directories function for both Butane files
handle_directories "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-base.bu"
handle_directories "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-$NODE_TYPE.bu"

# Extract names and contents of services and copy necessary files
extract_and_copy_trees "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-base.bu"
extract_and_copy_trees "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-$NODE_TYPE.bu"

chmod +x /usr/local/bin/*

# Extract and copy files
extract_and_copy_files "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-base.bu"
extract_and_copy_files "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-$NODE_TYPE.bu"

chmod +x /usr/local/bin/*

# Extract names and contents of services from both files
extract_services "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-base.bu" "$DEST_FOLDER"
extract_services "$UPDATE_TMP_DIR_K4ALL_SRC/k8s-$NODE_TYPE.bu" "$DEST_FOLDER"

#echo "Services extracted and saved in folder $DEST_FOLDER"

# Removal of services starting with 'fck8s'
echo "Removing existing services starting with 'fck8s'..."
for svc in /etc/systemd/system/fck8s*.service; do
    if [ -f "$svc" ]; then
        systemctl stop "$(basename "$svc")" &> /dev/null
        systemctl disable "$(basename "$svc")" &> /dev/null
        rm "$svc"
        echo "Stopped, Disabled and Removed: $svc"
    fi
done

systemctl daemon-reload

# Installation of new services
echo "Installing new services..."
for svc in "$DEST_FOLDER"/*.service; do
    if [ -f "$svc" ]; then
        cp -fp "$svc" /etc/systemd/system/
        systemctl enable "$(basename "$svc")"
        # Uncomment the following if you want to start the services immediately
        # if ! systemctl start "$(basename "$svc")"; then
        #     echo "Error starting $(basename "$svc"), will retry later"
        # else
        #     echo "Installed and started: $(basename "$svc")"
        # fi
    fi
done

# Uncomment if you have a reinstall script to run
/usr/local/bin/reinstall.sh --yes
