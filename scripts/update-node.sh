#!/bin/bash
set -euo pipefail

# Check if the script was launched directly or with bash
if [[ "$0" != "/tmp/update-node.sh" ]]; then
    cp "$0" "/tmp/update-node.sh"
    bash "/tmp/update-node.sh"
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

# Cleanup function to remove container and image
cleanup() {
    echo "Cleaning up..."
    podman rm $CONTAINER_NAME 2>/dev/null || true
    podman rmi $CONTAINER_IMAGE 2>/dev/null || true
}

# Trap to perform cleanup at the end of the script
trap cleanup EXIT

# Create folder to save services
mkdir -p $UPDATE_TMP_DIR
mkdir -p $UPDATE_TMP_DIR_K4ALL
mkdir -p $DEST_FOLDER

podman pull $CONTAINER_IMAGE
# Delete existing container if present
if podman container exists $CONTAINER_NAME; then
    podman rm -f $CONTAINER_NAME
fi

# Create the container
podman create --name $CONTAINER_NAME --replace $CONTAINER_IMAGE
podman cp update-container:/src $UPDATE_TMP_DIR_K4ALL

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
            fi
        else
            echo "File $base_repo_file not found in $HOST_REPO_FOLDER."
        fi
    done
    echo "No differences found in repo files."
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

            mkdir -p $local_dest
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
            mkdir -p "$(dirname "$path")"  # Assicurati che le virgolette esterne siano corrette
            echo "$contents" > "$path"
            echo "Created from inline: $path"
        elif echo "$entry" | jq -e '.contents.local' > /dev/null; then
            # Local content
            local local_src=$(echo "$entry" | jq -r '.contents.local')
            local src_path="${UPDATE_TMP_DIR_K4ALL_SRC}/${local_src}"  # Usa {} per chiarezza
            if [ -f "$src_path" ]; then
                mkdir -p "$(dirname "$path")"  # Mantieni la consistenza delle virgolette
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

check_repos

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
        echo "Stopped, Diabled and Removed: $svc"
    fi
done

systemctl daemon-reload

# Installation of new services
echo "Installing new services..."
declare -a retry_services
for svc in "$DEST_FOLDER"/*.service; do
    if [ -f "$svc" ]; then
        cp -fp "$svc" /etc/systemd/system/
        systemctl enable "$(basename "$svc")"
        # if ! systemctl start "$(basename "$svc")"; then
        #     echo "Error starting $(basename "$svc"), will retry later"
        #     retry_services+=("$svc")
        # else
        #     echo "Installed and started: $(basename "$svc")"
        # fi
    fi
done

# # Attempt to resolve dependency issues iteratively
# echo "Attempting to start failed services..."
# for svc in "${retry_services[@]}"; do
#     echo "Retry for $(basename "$svc")..."
#     if systemctl start "$(basename "$svc")"; then
#         echo "$(basename "$svc") started successfully."
#     else
#         echo "Unable to start $(basename "$svc") after the second attempt."
#     fi
# done

/usr/local/bin/reinstall.sh --yes
