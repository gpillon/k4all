#!/bin/bash
# K4All - dashboard routes. fck8s-update-routes.timer runs this on the
# bootstrap node: the Headlamp Ingress (headlamp/headlamp) gets a rule for
# dashboard.<FQDN> and one for dashboard.<ingress IP>.nip.io, and
# /etc/login_data lists both.
#
# Rules are found by host, never by index: from k4all-operator v0.4.2 (v0.5.0
# is pinned from k4all v2.4.0) the headlamp hook writes its own
# dashboard.<IP>.nip.io rule and leaves the others alone (older hooks rewrite
# the Ingress; this script adds its rules back at the next run). The class
# and the annotations change only once the image runs Traefik (v2.4.0) and
# the cluster has Traefik's IngressClass, as in the operator's hook.

set -euo pipefail

# K4ALL_ROOT: the tests run the script against a fake root.
ROOT="${K4ALL_ROOT:-}"

# shellcheck source=SCRIPTDIR/overrides/bootstrap-control/control-plane-utils
source "$ROOT/opt/k4all/bin/control-plane-utils"

LOGIN_DATA="$ROOT/etc/login_data"
RELEASE_MANIFEST="$ROOT/usr/local/share/k4all-release.yaml"
INGRESS_NAME=headlamp
INGRESS_NAMESPACE=headlamp
# The Middleware the traefik component ships (k4all-release.yaml,
# extraObjects): it replaces ingress-nginx's force-ssl-redirect.
REDIRECT_NAMESPACE=traefik
REDIRECT_NAME=redirect-https
REDIRECT_REF="${REDIRECT_NAMESPACE}-${REDIRECT_NAME}@kubernetescrd"

# Function to update the MOTD
update_motd() {
    local fqdn_host=$1
    local nip_host=$2

    truncate -s 0 "$LOGIN_DATA"
    echo " - FQDN Route: https://dashboard.$fqdn_host/" | tee -a "$LOGIN_DATA"
    echo " - nip.io Route: https://dashboard.$nip_host/" | tee -a "$LOGIN_DATA"
}

# The ingress controller is Traefik from v2.4.0, ingress-nginx before. Its
# settings are spec.ingress.traefik; a config written before v2.4.0 that
# k4all-migrate-config.sh has not moved yet only has spec.ingress.nginx,
# which Traefik then follows (same rule as the operator's Traefik hook), as
# ingress-nginx did.
if [ "$(yq e '.spec.ingress.traefik != null' "$K4ALL_CONFIG_FILE")" = "true" ]; then
    INGRESS_KEY=traefik
else
    INGRESS_KEY=nginx
fi
# With a dedicated IP, Traefik's Service is a LoadBalancer on it and nothing
# listens on the node's own address, whether Traefik is the default class
# or not.
INGRESS_IP=$(yq e ".spec.ingress.${INGRESS_KEY}.dedicatedIP // \"\"" "$K4ALL_CONFIG_FILE")
if [ -z "$INGRESS_IP" ] || [ "$INGRESS_IP" = "null" ]; then
    INGRESS_IP=$(get_cluster_ip)
fi

FQDN=$(get_fqdn)
NIP_HOST="$INGRESS_IP.nip.io"

update_motd "$FQDN" "$NIP_HOST"

# The Ingress moves to Traefik when the image runs Traefik and the cluster
# has an IngressClass of Traefik's controller (traefik_ingress_class), the
# rule of the operator's headlamp hook (k4all-operator#65). A cluster
# restored from 1.x lists Traefik in its release while its 1.x ingress-nginx
# still serves, with no such class: there the Ingress keeps its class, as a
# traefik class would be served by nobody (k4all#156). When the
# IngressClasses cannot be read (API down, early boot), nothing is patched on
# a guess: the next run of the timer tries again.
TRAEFIK=false
TRAEFIK_CLASS=""
MIDDLEWARE=false
if traefik_is_active "$RELEASE_MANIFEST"; then
    class_rc=0
    TRAEFIK_CLASS=$(traefik_ingress_class) || class_rc=$?
    case $class_rc in
        0)
            TRAEFIK=true
            # A route that names a missing Middleware is not served at all.
            if kubectl --kubeconfig="$KUBECONFIG" get middlewares.traefik.io \
                    "$REDIRECT_NAME" -n "$REDIRECT_NAMESPACE" -o name >/dev/null 2>&1; then
                MIDDLEWARE=true
            fi
            ;;
        1)
            echo "No IngressClass of $TRAEFIK_CONTROLLER: Ingress" \
                 "$INGRESS_NAMESPACE/$INGRESS_NAME keeps its class"
            ;;
        *)
            echo "Cannot list the IngressClasses: Ingress $INGRESS_NAMESPACE/$INGRESS_NAME" \
                 "not patched, the next run tries again" >&2
            exit 1
            ;;
    esac
fi

# JSON patch for the Ingress on stdin: the missing rules, and with Traefik
# its IngressClass ($class) and the redirect Middleware instead of the
# nginx.ingress.kubernetes.io annotations. [] when nothing changes. The test
# of resourceVersion makes a concurrent write (the operator's hook) fail the
# patch instead of being overwritten.
read -r -d '' ROUTES_PATCH <<'JQ' || true
(.metadata.annotations // {}) as $have
| ($have
   | if $traefik then
       with_entries(select(.key | startswith("nginx.ingress.kubernetes.io/") | not))
       | if $middleware then .["traefik.ingress.kubernetes.io/router.middlewares"] = $ref
         else del(.["traefik.ingress.kubernetes.io/router.middlewares"]) end
     else . end) as $want
| ([.spec.rules[]?.host]) as $hosts
| (.spec.rules[0].http // {paths: [{path: "/", pathType: "Prefix",
     backend: {service: {name: "headlamp", port: {number: 4466}}}}]}) as $http
| [ (if .spec.rules == null then {op: "add", path: "/spec/rules", value: []}
     else empty end),
    ($wanted[] | select(. as $h | $hosts | any(.[]; . == $h) | not)
     | {op: "add", path: "/spec/rules/-", value: {host: ., http: $http}}),
    (if $traefik and .spec.ingressClassName != $class
     then {op: "add", path: "/spec/ingressClassName", value: $class}
     else empty end),
    (if $want != $have
     then {op: "add", path: "/metadata/annotations", value: $want}
     else empty end) ] as $ops
| if $ops == [] then []
  else [{op: "test", path: "/metadata/resourceVersion",
         value: .metadata.resourceVersion}] + $ops end
JQ

ingress=$(kubectl --kubeconfig="$KUBECONFIG" get ingress "$INGRESS_NAME" \
    -n "$INGRESS_NAMESPACE" --ignore-not-found -o json)
if [ -z "$ingress" ]; then
    echo "Ingress $INGRESS_NAMESPACE/$INGRESS_NAME does not exist yet (the operator creates it with Headlamp)"
    exit 0
fi

ops=$(jq -c --argjson traefik "$TRAEFIK" --arg class "$TRAEFIK_CLASS" \
    --argjson middleware "$MIDDLEWARE" --arg ref "$REDIRECT_REF" \
    --argjson wanted "$(jq -cn --arg a "dashboard.$FQDN" --arg b "dashboard.$NIP_HOST" '[$a, $b]')" \
    "$ROUTES_PATCH" <<< "$ingress")

if [ "$ops" = "[]" ]; then
    echo "Ingress $INGRESS_NAMESPACE/$INGRESS_NAME is up to date"
    exit 0
fi

kubectl --kubeconfig="$KUBECONFIG" patch ingress "$INGRESS_NAME" \
    -n "$INGRESS_NAMESPACE" --type=json -p "$ops"
