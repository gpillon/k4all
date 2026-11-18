# Traefik replaces ingress-nginx, and serves nginx-class Ingresses meanwhile

The ingress-nginx repository is archived, and its last release, 4.15.1, is
tested only up to Kubernetes 1.35, so it could not follow v2.6.0 to 1.36.
In v2.4.0 the operator uninstalls ingress-nginx (`management: Removed`, left
at 4.14.3 and never upgraded), then installs Traefik on the same
LoadBalancer IP or host ports. Traefik runs with its Ingress-NGINX provider,
which serves users' Ingresses of class `nginx` with their
`nginx.ingress.kubernetes.io/*` annotations, ssl-passthrough included, so
the switch needs no change to them. k4all's own routes (Headlamp, Argo CD)
move to the `traefik` class.

## Consequences

- The `nginx` IngressClass stays, created by Traefik's chart with the
  ingress-nginx controller name, and never as the default class: the
  provider follows only Ingresses of such a class. Users move to `traefik`
  when they want to.
- The operator handles Removed components before the active ones. Removing
  ingress-nginx frees the IP and the host ports, and its uninstall deletes
  the `nginx` class that Traefik's chart then creates again. Routes are down
  in between, for minutes during the v2.4.0 sync.
- `spec.ingress.nginx` moves to `spec.ingress.traefik`: in the ClusterConfig
  through an operator migration during the v2.4.0 sync, and in each node's
  file at the first boot of v2.4.0.
- From v2.6.0 the release manifest no longer lists ingress-nginx. The
  cluster's ReleaseManifest keeps its Removed entry, because the sync never
  deletes entries.
