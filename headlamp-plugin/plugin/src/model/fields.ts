/*
 * Catalog of the ClusterConfig fields the plugin shows, with how each one
 * reaches the cluster. It is the single source for labels, help texts and
 * the "why can't I change this" explanations.
 *
 *   live    - k4all-operator applies a change on its next reconcile.
 *   install - consumed once, at installation (kubeadm, installer, first boot).
 *   node    - read by node scripts from /etc/k4all-config.yaml, not from the
 *             cluster resource: an edit here does not reach the nodes.
 */

import { Capabilities, CapabilityId } from './capabilities';
import { Path } from './objects';

export type ApplyMode = 'live' | 'install' | 'node';

export type FieldGroup =
  | 'features'
  | 'ingress'
  | 'networking'
  | 'cluster'
  | 'proxy'
  | 'virt'
  | 'nodes'
  | 'storage';

export interface FieldInfo {
  path: Path;
  label: string;
  group: FieldGroup;
  mode: ApplyMode;
  help: string;
  /** For install/node fields: why it is read-only here. */
  why?: string;
  /** How the value is shown when it is missing from the resource. */
  fallback?: string;
  /**
   * For install fields that a newer k4all-operator can change on a running
   * cluster: the capability (capabilities.ts) that makes the field live.
   */
  liveWith?: CapabilityId;
}

const INSTALL_WHY = 'Set at installation by kubeadm. Changing it means reinstalling the cluster.';
const PROXY_WHY =
  'Configured once on each node during installation, from /etc/k4all-config.yaml. Changing the ' +
  'cluster resource does not reach the nodes.';

export const FIELDS = {
  virtEnabled: {
    path: ['features', 'virt', 'enabled'],
    label: 'Virtualization',
    group: 'features',
    mode: 'live',
    help: 'KubeVirt, CDI, virtctl and Hangar, the virtual machine console in this dashboard, to run virtual machines next to containers.',
  },
  virtEmulation: {
    path: ['features', 'virt', 'emulation'],
    label: 'Software emulation',
    group: 'features',
    mode: 'live',
    help: 'auto uses hardware virtualization (/dev/kvm) when the node has it, and emulation otherwise.',
    fallback: 'auto',
  },
  // k4all v2.7.0 (operator v0.6.0): absent means "not owned by k4all".
  vmStateStorageClass: {
    path: ['features', 'virt', 'kubevirt', 'vmStateStorageClass'],
    label: 'VM state StorageClass',
    group: 'virt',
    mode: 'live',
    help:
      'Where KubeVirt keeps the persistent EFI variables and TPM of the VMs that ask for them. ' +
      'Not set: the value in the KubeVirt CR (Hangar) applies, else the default StorageClass.',
    fallback: 'not set by k4all',
  },
  hangarNodeAgent: {
    path: ['features', 'virt', 'hangar', 'nodeAgent'],
    label: 'Hangar node agent',
    group: 'virt',
    mode: 'live',
    help:
      "Hangar's privileged agent on every node (namespace hangar-system): the host inventory of " +
      "Hangar's Hardware tab, and the vfio-pci binding of PCI devices given to VMs.",
    fallback: 'release default (installed)',
  },
  metadataEnabled: {
    path: ['features', 'virt', 'metadata', 'enabled'],
    label: 'Metadata service',
    group: 'virt',
    mode: 'live',
    help:
      'An OpenStack and EC2 compatible metadata server on 169.254.169.254 inside each VM pod: ' +
      'cloud-init reads the SSH keys and user-data from it, without a cloud-init disk.',
  },
  metadataScope: {
    path: ['features', 'virt', 'metadata', 'scope'],
    label: 'Metadata service: which VMs',
    group: 'virt',
    mode: 'live',
    help: 'Labelled: VMs whose template has the opt-in label. All: every VM where PodSecurity allows it.',
    fallback: 'Labelled',
  },
  metadataAudiences: {
    path: ['features', 'virt', 'metadata', 'tokens', 'audiences'],
    label: 'Metadata service: token audiences',
    group: 'virt',
    mode: 'live',
    help: 'Audiences of the workload-identity tokens a VM can ask for. Never the API server.',
    fallback: "operator's default",
  },
  metadataExpiration: {
    path: ['features', 'virt', 'metadata', 'tokens', 'expirationSeconds'],
    label: 'Metadata service: token lifetime (s)',
    group: 'virt',
    mode: 'live',
    help: 'Lifetime of those tokens, at least 600 seconds; kubelet renews them.',
    fallback: "operator's default",
  },
  metadataVendorData: {
    path: ['features', 'virt', 'metadata', 'vendorDataConfigMap'],
    label: 'Metadata service: vendor-data ConfigMap',
    group: 'virt',
    mode: 'live',
    help: "A ConfigMap in each VM's namespace with cloud-init vendor-data; a namespace without it serves none.",
    fallback: 'none',
  },
  rookEnabled: {
    path: ['features', 'rook', 'enabled'],
    label: 'Rook/Ceph storage',
    group: 'storage',
    mode: 'live',
    help:
      'Ceph on the blank disks of the nodes, with a replicated ReadWriteMany block StorageClass ' +
      '(ceph-rbd) for live migration, managed in the Cairn console.',
  },
  rookDeviceFilter: {
    path: ['features', 'rook', 'storage', 'deviceFilter'],
    label: 'Disks for Ceph',
    group: 'storage',
    mode: 'live',
    help:
      'A regular expression on device names (^sdb$, ^nvme[01]n1$). Not set: every blank disk of ' +
      'every node; a disk with a partition table, a filesystem or LVM is never taken.',
    fallback: 'every blank disk',
  },
  rookSmallCluster: {
    path: ['features', 'rook', 'smallCluster'],
    label: 'Below 3 nodes',
    group: 'storage',
    mode: 'live',
    help: 'Refuse: create nothing until there are 3 nodes. Allow: one mon, pool size the node count, no redundancy.',
    fallback: 'Refuse',
  },
  nodesMaxPods: {
    path: ['nodes', 'kubelet', 'maxPods'],
    label: 'Max pods per node',
    group: 'nodes',
    mode: 'live',
    help: 'Pods kubelet runs at most on a node (10 to 1000; at most 250 with Cilium, which gives each node a /24).',
    fallback: 'not set by k4all',
  },
  nodesCpuManager: {
    path: ['nodes', 'kubelet', 'cpuManagerPolicy'],
    label: 'CPU manager',
    group: 'nodes',
    mode: 'live',
    help:
      'static gives Guaranteed pods (and VMs with dedicated CPUs) with whole-CPU requests CPUs of ' +
      "their own; it needs reserved CPUs. VMs with dedicated CPUs also need KubeVirt's CPUManager " +
      'gate (Virtualization page).',
    fallback: 'not set by k4all',
  },
  nodesReservedCPUs: {
    path: ['nodes', 'kubelet', 'reservedSystemCPUs'],
    label: 'Reserved CPUs',
    group: 'nodes',
    mode: 'live',
    help: 'CPUs kept for the system and kubelet (0-1, 0,2): no pod gets them. Every node must have them.',
    fallback: 'not set by k4all',
  },
  nodesTopologyPolicy: {
    path: ['nodes', 'kubelet', 'topologyManagerPolicy'],
    label: 'Topology manager',
    group: 'nodes',
    mode: 'live',
    help: 'How CPU, memory and device allocations are aligned on NUMA nodes.',
    fallback: 'not set by k4all',
  },
  nodesTopologyScope: {
    path: ['nodes', 'kubelet', 'topologyManagerScope'],
    label: 'Topology manager scope',
    group: 'nodes',
    mode: 'live',
    help: 'Align each container, or the whole pod.',
    fallback: 'not set by k4all',
  },
  nodesHugepages1Gi: {
    path: ['nodes', 'hugepages', '1Gi'],
    label: '1 GiB hugepages per node',
    group: 'nodes',
    mode: 'live',
    help: 'Reserved at boot (kernel argument), for VMs and pods that ask for hugepages-1Gi.',
    fallback: 'not set by k4all',
  },
  nodesHugepages2Mi: {
    path: ['nodes', 'hugepages', '2Mi'],
    label: '2 MiB hugepages per node',
    group: 'nodes',
    mode: 'live',
    help: 'Reserved at boot (kernel argument), for VMs and pods that ask for hugepages-2Mi.',
    fallback: 'not set by k4all',
  },
  nodesIommu: {
    path: ['nodes', 'iommu'],
    label: 'IOMMU',
    group: 'nodes',
    mode: 'live',
    help:
      'intel_iommu=on or amd_iommu=on with iommu=pt, for PCI passthrough to VMs. Off removes only ' +
      'the kernel arguments k4all added, never ones set by hand.',
    fallback: 'not set by k4all',
  },
  nodesRolloutPaused: {
    path: ['nodes', 'rollout', 'paused'],
    label: 'Node settings rollout paused',
    group: 'nodes',
    mode: 'live',
    help: 'Stops the rollout before the next node; the node in progress finishes.',
  },
  argocdEnabled: {
    path: ['features', 'argocd', 'enabled'],
    label: 'Argo CD',
    group: 'features',
    mode: 'live',
    help: 'GitOps continuous delivery with Argo CD.',
  },
  ovsCniEnabled: {
    path: ['features', 'ovsCni', 'enabled'],
    label: 'OVS secondary networks',
    group: 'features',
    mode: 'live',
    help: 'Multus and OVS-CNI, to attach pods and VMs to Open vSwitch networks.',
  },
  ovsBridgeEnabled: {
    path: ['features', 'ovsBridge', 'enabled'],
    label: 'OVS bridge on every node',
    group: 'features',
    mode: 'install',
    help: "The node's primary interface is enslaved to the ovs-bridge Open vSwitch bridge.",
    why:
      'It moves the node address to a new bridge. k4all-operator creates the bridge on new ' +
      'nodes but never removes it, so turning it off has no effect and turning it on moves ' +
      'live node addresses.',
    liveWith: 'ovsBridgeToggle',
  },
  cniType: {
    path: ['networking', 'cni', 'type'],
    label: 'CNI',
    group: 'networking',
    mode: 'install',
    help: 'The pod network plugin.',
    why:
      'Switching the CNI re-creates the pod network: every pod loses connectivity until it ' +
      'is restarted. Not supported on a running cluster.',
    liveWith: 'cniSwitch',
  },
  ciliumL2: {
    path: ['networking', 'cni', 'cilium', 'l2announcements'],
    label: 'L2 announcements',
    group: 'networking',
    mode: 'live',
    help:
      'Cilium answers ARP for LoadBalancer addresses on the local network. Announcement ' +
      'policies and IP pools (CiliumL2AnnouncementPolicy, CiliumLoadBalancerIPPool) are yours to create.',
  },
  ciliumHubble: {
    path: ['networking', 'cni', 'cilium', 'hubble'],
    label: 'Hubble',
    group: 'networking',
    mode: 'live',
    help: 'Hubble Relay and the Hubble UI, for network flow observability.',
  },
  ciliumGatewayAPI: {
    path: ['networking', 'cni', 'cilium', 'gatewayAPI'],
    label: 'Gateway API',
    group: 'networking',
    mode: 'live',
    help: "Cilium's Gateway API implementation (GatewayClass cilium).",
  },
  ciliumDevices: {
    path: ['networking', 'cni', 'cilium', 'additionalDevices'],
    label: 'Additional devices',
    group: 'networking',
    mode: 'live',
    help:
      'Interfaces Cilium attaches to. Setting any turns off auto-detection; ovs-bridge is ' +
      'added automatically when the OVS bridge is on.',
  },
  firewalld: {
    path: ['networking', 'firewalld', 'enabled'],
    label: 'firewalld',
    group: 'networking',
    mode: 'node',
    help: 'Host firewall on the nodes.',
    why: 'Configured on each node during installation, from /etc/k4all-config.yaml.',
  },
  traefikIP: {
    path: ['ingress', 'traefik', 'dedicatedIP'],
    label: 'Dedicated IP',
    group: 'ingress',
    mode: 'live',
    help: 'Leave empty to serve on the node address (host ports 80/443).',
    fallback: 'node address',
  },
  traefikDefault: {
    path: ['ingress', 'traefik', 'isDefault'],
    label: 'Default IngressClass',
    group: 'ingress',
    mode: 'live',
    help: 'Ingresses without an ingressClassName are served by the ingress controller.',
  },
  ciliumIngressIP: {
    path: ['ingress', 'cilium', 'dedicatedIP'],
    label: 'Cilium ingress IP',
    group: 'ingress',
    mode: 'live',
    help: 'Added to the MetalLB address pool for a Cilium ingress or gateway LoadBalancer.',
  },
  podNetwork: {
    path: ['cluster', 'podNetwork'],
    label: 'Pod network',
    group: 'cluster',
    mode: 'install',
    help: 'CIDR the pod addresses come from.',
    why: INSTALL_WHY,
    fallback: '10.100.0.1/18',
  },
  serviceNetwork: {
    path: ['cluster', 'serviceNetwork'],
    label: 'Service network',
    group: 'cluster',
    mode: 'install',
    help: 'CIDR the Service ClusterIPs come from.',
    why: INSTALL_WHY,
    fallback: '10.96.0.0/16',
  },
  apiHostname: {
    path: ['cluster', 'apiEndPointUseHostName'],
    label: 'API endpoint uses the hostname',
    group: 'cluster',
    mode: 'install',
    help: 'The control plane endpoint is the node hostname instead of its IP.',
    why: 'Written into the API server certificates and every kubeconfig at installation.',
  },
  customApiEndpoint: {
    path: ['cluster', 'customApiEndPoint'],
    label: 'Custom API endpoint',
    group: 'cluster',
    mode: 'install',
    help: 'Hostname clients use to reach the API server.',
    why: 'Written into the API server certificates and every kubeconfig at installation.',
    fallback: 'none',
  },
  haType: {
    path: ['cluster', 'ha', 'type'],
    label: 'Control plane HA',
    group: 'cluster',
    mode: 'install',
    help: 'How the control plane virtual IP is held: kube-vip, keepalived, or none.',
    why: 'The virtual IP is the control plane endpoint, fixed when the cluster was created.',
    fallback: 'none',
  },
  haVIP: {
    path: ['cluster', 'ha', 'apiControlEndpoint'],
    label: 'Control plane virtual IP',
    group: 'cluster',
    mode: 'install',
    help: 'Virtual IP of the API server.',
    why: 'The virtual IP is the control plane endpoint, fixed when the cluster was created.',
    fallback: 'none',
  },
  haSubnet: {
    path: ['cluster', 'ha', 'apiControlEndpointSubnetSize'],
    label: 'Virtual IP prefix length',
    group: 'cluster',
    mode: 'install',
    help: 'Prefix length of the virtual IP (e.g. 24).',
    why: 'Configured on the control plane nodes at installation.',
    fallback: 'none',
  },
  haInterface: {
    path: ['cluster', 'ha', 'interface'],
    label: 'Virtual IP interface',
    group: 'cluster',
    mode: 'install',
    help: 'Interface the virtual IP is bound to.',
    why: 'Configured on the control plane nodes at installation.',
    fallback: 'auto',
  },
  httpProxy: {
    path: ['proxy', 'httpProxy'],
    label: 'HTTP proxy',
    group: 'proxy',
    mode: 'node',
    help: 'Proxy for HTTP traffic of CRI-O, kubelet and node tools.',
    why: PROXY_WHY,
    fallback: 'none',
  },
  httpsProxy: {
    path: ['proxy', 'httpsProxy'],
    label: 'HTTPS proxy',
    group: 'proxy',
    mode: 'node',
    help: 'Proxy for HTTPS traffic of CRI-O, kubelet and node tools.',
    why: PROXY_WHY,
    fallback: 'none',
  },
  noProxy: {
    path: ['proxy', 'noProxy'],
    label: 'No proxy',
    group: 'proxy',
    mode: 'node',
    help: 'Destinations reached without the proxy.',
    why: PROXY_WHY,
    fallback: 'none',
  },
} satisfies Record<string, FieldInfo>;

export type FieldId = keyof typeof FIELDS;

export function fieldInfo(id: FieldId): FieldInfo {
  return FIELDS[id];
}

/** The catalog entry whose path is a prefix of (or equal to) path, if any. */
export function fieldForPath(path: Path): FieldInfo | undefined {
  let best: FieldInfo | undefined;
  for (const info of Object.values(FIELDS) as FieldInfo[]) {
    const p = info.path;
    if (p.length <= path.length && p.every((seg, i) => String(seg) === String(path[i]))) {
      if (!best || p.length > best.path.length) {
        best = info;
      }
    }
  }
  return best;
}

/** The apply mode with the installed operator: liveWith fields turn live with their capability. */
export function applyModeOf(info: FieldInfo, caps: Capabilities): ApplyMode {
  return info.liveWith && caps[info.liveWith] ? 'live' : info.mode;
}

export const READ_ONLY_FIELDS: FieldId[] = (Object.keys(FIELDS) as FieldId[]).filter(
  id => FIELDS[id].mode !== 'live'
);
