# Each mandatory stop changes the OS or the cluster, not both

After the bridge release, the 2.x ladder has four minors: v2.3.0 (CRI-O
1.35), v2.4.0 (the first ReleaseManifest sync), v2.5.0 (Fedora 45) and
v2.6.0 (Kubernetes 1.36). Traefik first had a minor of its own, between
Fedora 45 and Kubernetes 1.36. It moved into v2.4.0, whose sync already
replaces components and cannot be undone, and one mandatory stop went away.
The ladder was not compacted further on purpose. v2.3.0 and v2.5.0 change
what the image carries and keep the Kubernetes minor and the components, so
`bootc rollback` undoes a failed hop. v2.4.0 and v2.6.0 change the cluster
(components and CRDs; the control plane's Kubernetes minor), which no
rollback undoes.

## Consequences

v2.4.0 carries everything that has to reach the cluster before Kubernetes
1.36: operator v0.5.0 with ClusterUpgrade, the Headlamp plugin, every
component pinned to a version that also runs on 1.36, Traefik instead of
ingress-nginx, and kube-vip handed to the host. ClusterUpgrade came this
early so that every later hop, Fedora 45 included, can run from the plugin.
