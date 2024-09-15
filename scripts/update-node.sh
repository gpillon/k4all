#!/bin/bash
set -euxo pipefail

NODE_TYPE=$(cat /etc/node-type)

URL1="https://raw.githubusercontent.com/gpillon/k4all/v1.4.0/k8s-base.bu"
URL2="https://raw.githubusercontent.com/gpillon/k4all/v1.4.0/k8s-${NODE_TYPE}.bu"

# Verifica che le variabili d'ambiente URL1 e URL2 siano state impostate
if [ -z "$URL1" ] || [ -z "$URL2" ]; then
    echo "Imposta le variabili d'ambiente URL1 e URL2 prima di eseguire lo script."
    exit 1
fi

DEST_FOLDER="./extracted_services"

# Crea la cartella per salvare i servizi
mkdir -p "$DEST_FOLDER"

# Funzione per estrarre i servizi da un file Butane, trasformarli in JSON e creare i file
extract_services() {
    local file=$1
    local dest_folder=$2

    # Usa yq per estrarre i servizi e convertirli in un array JSON
    yq -o=json '[(.systemd.units[] | select(.enabled == true and .contents != null) | {"name": .name, "contents": .contents})]' "$file" |
    jq -c '.[]' | while IFS= read -r service; do
        # Estrai il nome e il contenuto dal JSON
        service_name=$(echo "$service" | jq -r '.name')
        service_contents=$(echo "$service" | jq -r '.contents')

        # Crea un file con il nome del servizio e inserisci il contenuto
        echo "$service_contents" > "${dest_folder}/${service_name}"
    done
}

# Scarica i file Butane dai due URL
curl -o file1.bu "$URL1"
curl -o file2.bu "$URL2"

# Estrai i nomi e i contenuti dei servizi da entrambi i file
extract_services "file1.bu" "$DEST_FOLDER"
extract_services "file2.bu" "$DEST_FOLDER"

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

/usr/local/bin/reinstall.sh