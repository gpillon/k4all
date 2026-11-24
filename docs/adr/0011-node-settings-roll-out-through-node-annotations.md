# Node settings roll out through Node annotations, applied by each node's own agent

The ClusterConfig's node settings are kubelet fields, hugepages and IOMMU
(#60). The operator rolls them out one node at a time with the protocol of
upgrades ([ADR-0006](0006-operator-and-nodes-talk-through-node-annotations.md)).
It writes the kubelet fields into kubeadm's `kube-system/kubelet-config`,
drains the node, and writes `node-settings-target`. The node's
`k4all-upgrade agent` pulls the kubelet config with kubeadm, sets the kernel
arguments with `rpm-ostree kargs`, restarts kubelet or reboots, and answers
with `node-settings-applied` (or `node-settings-message`). The kernel
arguments travel in an annotation of `kubelet-config`, which every node may
read with its own kubelet credentials. The node does the work because only the
host can rewrite `/var/lib/kubelet`, remove the CPU manager's state with
kubelet stopped, edit the kernel arguments of its deployment and reboot. It
already does all of that for a hop, and it does it with the credentials every
node has.

## Considered options

- A privileged DaemonSet from the operator, as OpenShift's Machine Config
  Operator or tuned do. Rejected. It would need host PID, `spc_t` under
  SELinux, write access to `/var/lib/kubelet` and to the ostree deployments,
  and a way to reboot its own node and come back. That is a second host agent
  next to `k4all-upgrade`, and the two would have to coordinate their
  reboots.
- A kubelet drop-in per node (`/etc/kubernetes/kubelet.conf.d/`) instead of
  `kubelet-config`. Kept for per-node groups later. With one cluster-wide value
  the ConfigMap is what joining nodes and `kubeadm upgrade` already use.
- The kernel arguments in a Node annotation the operator writes with the
  target. Rejected for the ConfigMap annotation. There they sit next to the
  kubelet fields of the same hash, and the agent applies a target only when
  that hash matches, so it never mixes two sets of settings.

## Consequences

- The annotation names and the `kubelet-config` annotation's JSON (`hash`,
  `hugepages`, `iommu`) are a protocol. Every agent from v2.7.0 keeps speaking
  the one it shipped with ([ADR-0004](0004-one-upgrade-tool-in-every-release.md)).
  Nodes on an older release have no agent for it, and are skipped until their
  upgrade.
- k4all removes only the kernel arguments it added. Each node keeps their list
  in `/etc/k4all/node-settings.json`. Being in `/etc`, the list travels with
  the ostree deployment, like the kernel arguments themselves.
- A ClusterUpgrade and the rollout never change two nodes at once. The rollout
  starts no node during a ClusterUpgrade, and does not write `kubelet-config`
  then.
- A Kubernetes hop's kubeadm also writes `config.yaml` from `kubelet-config`.
  A node the rollout has not reached can thus get new CPU manager settings, so
  a hop removes the CPU manager's state before its reboot when those settings
  changed.
