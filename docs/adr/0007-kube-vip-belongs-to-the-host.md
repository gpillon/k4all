# kube-vip belongs to the host, and shares Service IPs with MetalLB by class

On HA clusters with `ha.type: kubevip` the host writes kube-vip's static-pod
manifest on every control plane, with `k4all-upgrade kube-vip-manifest`: at
install, after a control plane joins, and after every hop. The
ReleaseManifest lists kube-vip as `management: Unmanaged`, with the pinned
version the host reads. The operator's `static-pod` type wrote a Pod with
the image alone, without args, env or volumes, so kube-vip exited and the
API VIP went away. Operators v0.1.x to v0.4.x did that whenever they applied
the component, and with `version: latest` that meant at every new kube-vip
release ([#41](https://github.com/gpillon/k4all/issues/41)). The host
already had to write the manifest at install, before `kubeadm init` and
before any operator runs. Now it is the only writer.

kube-vip runs with `cp_enable`, `svc_enable` and `lb_class_only`. It holds
the API VIP and announces only the LoadBalancer Services of class
`kube-vip.io/kube-vip-class`, such as the ingress's dedicated IP on these
clusters. MetalLB takes the Services without a class. Without
`lb_class_only`, kube-vip also announced the ingress IP that MetalLB already
announced.

## Consequences

- Clusters from before v2.4.0 get Unmanaged from the bridge, which patches
  the ReleaseManifest on the bootstrap node. Every operator, v0.1.0
  included, skips an Unmanaged component. The manifest sync keeps it, and
  sets it again before its first step.
- From v0.5.0 the operator never overwrites a static-pod manifest it did not
  write, and the `static-pod` type is deprecated.
- The kube-vip class goes only with a dedicated IP, never with a node's own
  IP: with kube-vip on every control plane, the Services' leader may be
  another node.
- The release manifests of v2.2.4 and v2.3.0 say kube-vip `latest`. During a
  hop the generator then writes nothing, until v2.4.0 pins a version.
