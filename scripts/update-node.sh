#!/bin/bash
set -euo pipefail

NODE_TYPE=$(cat /etc/node-type)

IMAGE_TAG=${1:-latest}
CONTAINER_IMAGE="ghcr.io/gpillon/k4all:$IMAGE_TAG"

UPDATE_TMP_DIR=/tmp/update
UPDATE_TMP_DIR_K4ALL=$UPDATE_TMP_DIR/k4all
DEST_FOLDER="$UPDATE_TMP_DIR/extracted_services"
CONTAINER_NAME="update-container"

# Funzione cleanup per rimuovere container e immagine
cleanup() {
    echo "Pulizia in corso..."
    podman rm $CONTAINER_NAME 2>/dev/null || true
    podman rmi $CONTAINER_IMAGE 2>/dev/null || true
}

# Trap per eseguire cleanup alla fine dello script
trap cleanup EXIT



# Crea la cartella per salvare i servizi
mkdir -p $UPDATE_TMP_DIR
mkdir -p $UPDATE_TMP_DIR_K4ALL
mkdir -p $DEST_FOLDER

podman pull $CONTAINER_IMAGE
# Elimina il container esistente se presente
if podman container exists $CONTAINER_NAME; then
    podman rm -f $CONTAINER_NAME
fi

# Crea il container
podman create --name $CONTAINER_NAME --replace $CONTAINER_IMAGE
#podman cp update-container:/app/k8s-base.bu $UPDATE_TMP_DIR_K4ALL/k8s-base.bu
#podman cp update-container:/app/k8s-$NODE_TYPE.bu $UPDATE_TMP_DIR_K4ALL/k8s-$NODE_TYPE.bu
podman cp update-container:/app $UPDATE_TMP_DIR_K4ALL

# podman rm update-container
# podman rmi $CONTAINER_IMAGE

# Funzione per estrarre i servizi da un file Butane, trasformarli in JSON e creare i file
extract_services() {
    local file=$1
    local dest_folder=$2

    # Usa yq per estrarre i servizi e convertirli in un array JSON
    yq -o=json '[(.systemd.units[] | select(.contents != null) | {"name": .name, "contents": .contents})]' "$file" |
    jq -c '.[]' | while IFS= read -r service; do
        # Estrai il nome e il contenuto dal JSON
        service_name=$(echo "$service" | jq -r '.name')
        service_contents=$(echo "$service" | jq -r '.contents')

        # Crea un file con il nome del servizio e inserisci il contenuto
        echo "$service_contents" > "${dest_folder}/${service_name}"
    done
}
# Funzione per estrarre i servizi e copiare file definiti in .storage.trees
extract_and_copy_files() {
    local file=$1
    local dest_folder=$2
    yq -o=json '[.storage.trees[]? | {"local": .local, "path": .path}]' "$file" | jq -c '.[]'
    # Estrazione e copia dei file definiti in .storage.trees
    yq -o=json '[.storage.trees[]? | {"local": .local, "path": .path}]' "$file" |
    jq -c '.[]' | while IFS= read -r entry; do
        echo "$entry" | jq -r '.local'
        echo "$entry" | jq -r '.path'
        local_src=$(echo "$entry" | jq -r '.local')
        local_dest=$(echo "$entry" | jq -r '.path')
        if [ -f "$UPDATE_TMP_DIR_K4ALL/$local_src" ]; then
            cp -r "$UPDATE_TMP_DIR_K4ALL/$local_src/*" "$local_dest"
            echo "Copiato: $local_src -> $local_dest"
        fi
    done
}

# Estrai i nomi e i contenuti dei servizi da entrambi i file
#extract_services "$UPDATE_TMP_DIR_K4ALL/k8s-base.bu" "$DEST_FOLDER"
#extract_services "$UPDATE_TMP_DIR_K4ALL/k8s-$NODE_TYPE.bu" "$DEST_FOLDER"

# Estrai i nomi e i contenuti dei servizi e copia i file necessari
extract_and_copy_files "$UPDATE_TMP_DIR_K4ALL/k8s-base.bu" "$DEST_FOLDER"
extract_and_copy_files "$UPDATE_TMP_DIR_K4ALL/k8s-$NODE_TYPE.bu" "$DEST_FOLDER"

exit 1

echo "Servizi estratti e salvati nella cartella $DEST_FOLDER"

# Rimozione dei servizi che iniziano con 'fck8s'
echo "Rimozione dei servizi esistenti che iniziano con 'fck8s'..."
for svc in /etc/systemd/system/fck8s*.service; do
    if [ -f "$svc" ]; then
        systemctl stop "$(basename "$svc")"
        systemctl disable "$(basename "$svc")"
        rm "$svc"
        echo "Rimosso: $svc"
    fi
done
systemctl daemon-reload

# Installazione dei nuovi servizi
echo "Installazione dei nuovi servizi..."
declare -a retry_services
for svc in "$DEST_FOLDER"/*.service; do
    if [ -f "$svc" ]; then
        cp "$svc" /etc/systemd/system/
        systemctl enable "$(basename "$svc")"
        if ! systemctl start "$(basename "$svc")"; then
            echo "Errore nell'avvio di $(basename "$svc"), verrà riprovato più tardi"
            retry_services+=("$svc")
        else
            echo "Installato e avviato: $(basename "$svc")"
        fi
    fi
done

# Tentativo di risolvere i problemi di dipendenza iterativamente
echo "Tentativi di avvio dei servizi falliti..."
for svc in "${retry_services[@]}"; do
    echo "Riprova per $(basename "$svc")..."
    if systemctl start "$(basename "$svc")"; then
        echo "$(basename "$svc") avviato con successo."
    else
        echo "Non è stato possibile avviare $(basename "$svc") dopo il secondo tentativo."
    fi
done

#/usr/local/bin/reinstall.sh
