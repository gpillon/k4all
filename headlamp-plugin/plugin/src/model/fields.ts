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

import { Path } from './objects';

export type ApplyMode = 'live' | 'install' | 'node';

export type FieldGroup = 'features' | 'ingress' | 'networking' | 'cluster' | 'proxy';

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
    help: 'KubeVirt, CDI, kubevirt-manager and virtctl, to run virtual machines next to containers.',
  },
  virtEmulation: {
    path: ['features', 'virt', 'emulation'],
    label: 'Software emulation',
    group: 'features',
    mode: 'live',
    help: 'auto uses hardware virtualization (/dev/kvm) when the node has it, and emulation otherwise.',
    fallback: 'auto',
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
    help:
      'A LoadBalancer address for Traefik. Leave empty to serve on the node address ' +
      '(host ports 80/443).',
    fallback: 'node address',
  },
  traefikDefault: {
    path: ['ingress', 'traefik', 'isDefault'],
    label: 'Default IngressClass',
    group: 'ingress',
    mode: 'live',
    help: 'Ingresses without an ingressClassName are served by Traefik.',
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

export const READ_ONLY_FIELDS: FieldId[] = (Object.keys(FIELDS) as FieldId[]).filter(
  id => FIELDS[id].mode !== 'live'
);
