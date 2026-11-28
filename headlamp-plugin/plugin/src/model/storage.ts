/*
 * Rook/Ceph (features.rook, k4all v2.7.0 / operator v0.6.0). k4all installs
 * the Rook operator and the RBD CSI driver, and creates once, with defaults,
 * the CephCluster rook-ceph, the pool vm-pool and the StorageClass ceph-rbd.
 * From then on they belong to the Cairn console: the ClusterConfig only holds
 * the creation inputs (storage.deviceFilter or, from operator v0.7.0,
 * storage.nodes; smallCluster). Turning Rook off
 * is refused while a CephCluster exists, and k4all never wipes disks (D24).
 */

import { ComponentNotice, componentNotice } from './components';
import { namedDeviceIssues, osdHosts, storageNodes } from './rookSettings';
import { CephClusterLike, ClusterConfigSpec, NodeLike, ReleaseManifestObject } from './types';
import type { Issue } from './validation';

/** The components of the rook feature, as the operator holds them together (#96). */
export const ROOK_COMPONENTS = ['rook-ceph', 'ceph-csi-drivers', 'cairn'];

export interface RookDefaults {
  mons: number;
  mgrs: number;
  poolSize: number;
  /** Below 3 nodes the cluster is only created with smallCluster Allow. */
  needsAllow: boolean;
}

/**
 * What the RookHook creates for a node count (spec §9.2, planRook): mons
 * and mgrs from the nodes, the pool size from the OSD hosts (every node, or
 * the nodes storage.nodes names: one replica per host, at most 3).
 */
export function rookDefaults(nodes: number, osdHosts: number = nodes): RookDefaults {
  const mons = nodes >= 5 ? 5 : nodes >= 3 ? 3 : 1;
  const mgrs = nodes >= 2 ? 2 : 1;
  const hosts = Math.max(osdHosts, 1);
  return { mons, mgrs, poolSize: Math.min(hosts, 3), needsAllow: hosts < 3 };
}

export interface RookView {
  enabled: boolean;
  /** A CephCluster exists: the creation inputs no longer do anything. */
  created: boolean;
  /** namespace/name of each CephCluster. */
  clusters: string[];
  /** Rook is turned off but a CephCluster exists: the operator keeps Rook installed. */
  offRefused: boolean;
  /** What to do before Rook can be turned off. */
  offSteps: string[];
  /** Refused uninstalls and waits of the Rook components. */
  notices: (ComponentNotice & { name: string })[];
  /** Below 3 nodes: what k4all does with the policy. */
  small?: { nodes: number; policy: 'Refuse' | 'Allow'; text: string };
}

function policyOf(spec: ClusterConfigSpec): 'Refuse' | 'Allow' {
  return spec.features?.rook?.smallCluster === 'Allow' ? 'Allow' : 'Refuse';
}

/** Nodes Ceph can place daemons on (not cordoned). */
export function schedulableNodes(nodes: NodeLike[]): number {
  return nodes.filter(n => !n.spec?.unschedulable).length;
}

export function rookView(input: {
  spec: ClusterConfigSpec;
  cephClusters: CephClusterLike[];
  rm: ReleaseManifestObject | null | undefined;
  nodes: NodeLike[];
}): RookView {
  const enabled = input.spec.features?.rook?.enabled === true;
  const clusters = input.cephClusters.map(
    c => `${c.metadata.namespace ?? 'rook-ceph'}/${c.metadata.name}`
  );
  const created = clusters.length > 0;
  const notices = ROOK_COMPONENTS.map(name => ({
    name,
    notice: componentNotice(input.rm?.status?.components?.[name]),
  }))
    .filter((e): e is { name: string; notice: ComponentNotice } => !!e.notice)
    .map(e => ({ name: e.name, ...e.notice }));
  const offSteps = input.cephClusters.map(c => {
    const ns = c.metadata.namespace ?? 'rook-ceph';
    return `Delete the CephCluster ${ns}/${c.metadata.name} (kubectl -n ${ns} delete cephcluster ${c.metadata.name}); set its cleanupPolicy first if Rook should erase the data.`;
  });
  if (created) {
    offSteps.unshift(
      'In Cairn, move or delete what lives on Ceph: the volumes of the ceph-rbd StorageClass and the pools.'
    );
    offSteps.push(
      'k4all-operator then uninstalls Rook by itself. It never wipes disks: before turning Rook on again, ' +
        'wipe /var/lib/rook on every node and the OSD disks by hand.'
    );
  }
  const count = schedulableNodes(input.nodes);
  const named = storageNodes(input.spec).length;
  const hosts = osdHosts(input.spec, count);
  const policy = policyOf(input.spec);
  let small: RookView['small'];
  if (hosts < 3) {
    const d = rookDefaults(count, hosts);
    const nodesText = named
      ? `${named} named node${named === 1 ? '' : 's'}`
      : `${count} node${count === 1 ? '' : 's'}`;
    small = {
      nodes: hosts,
      policy,
      text:
        policy === 'Refuse'
          ? named
            ? `With ${nodesText} and smallCluster Refuse, k4all creates no Ceph cluster: every replica needs its own OSD host, and Ceph needs 3.`
            : `With ${nodesText} and smallCluster Refuse, k4all creates no Ceph cluster: Ceph needs 3 nodes for redundancy.`
          : `No redundancy: ${d.mons} mon${d.mons === 1 ? '' : 's'} and a pool of size ${
              d.poolSize
            }. A failed disk or node loses the data on it.`,
    };
  }
  return {
    enabled,
    created,
    clusters,
    offRefused: !enabled && created,
    offSteps,
    notices,
    small,
  };
}

/** The part of a disk of Hangar's node agent inventory that Rook's choice depends on. */
export interface DiskInfo {
  name: string;
  sizeBytes: number | null;
  partitions: string[];
  signatures: string[];
  holders: string[];
  mounts: string[];
  /** Its /dev/disk/by-id names (without the directory); absent from older agents. */
  byId?: string[];
}

export interface DiskCandidate extends DiskInfo {
  /** No partition, filesystem, LVM or other signature, not held or mounted. */
  blank: boolean;
  /** The device name matches the deviceFilter (or there is none). */
  matches: boolean;
  /** Rook makes it an OSD. */
  osd: boolean;
  /**
   * It holds LVM (an LVM signature, or device-mapper volumes on it or its
   * partitions): Rook never takes it whole, but a logical volume of its
   * volume group can be named (features.rook.storage.nodes).
   */
  lvm: boolean;
  /** With named devices: storage.nodes names this disk for its node. */
  named: boolean;
}

function filterRegExp(filter: string | undefined): RegExp | null {
  if (!filter) {
    return null;
  }
  try {
    return new RegExp(filter);
  } catch {
    return null;
  }
}

/** The paths a disk is known by: /dev/<name> and /dev/disk/by-id/<id>. */
export function diskPaths(d: DiskInfo): string[] {
  return [`/dev/${d.name}`, ...(d.byId ?? []).map(id => `/dev/disk/by-id/${id}`)];
}

/**
 * Which disks Rook would take: blank ones whose name matches the filter;
 * with named devices (the node's paths in storage.nodes), the blank ones
 * named.
 */
export function diskCandidates(
  disks: DiskInfo[],
  filter: string | undefined,
  named?: string[]
): DiskCandidate[] {
  const re = filterRegExp(filter);
  return disks.map(d => {
    const blank =
      d.partitions.length === 0 &&
      d.signatures.length === 0 &&
      d.holders.length === 0 &&
      d.mounts.length === 0;
    const lvm =
      d.signatures.includes('lvm') ||
      (d.holders.some(h => h.startsWith('dm-')) &&
        !d.signatures.some(s => s === 'luks' || s === 'ceph'));
    if (named) {
      const isNamed = diskPaths(d).some(p => named.includes(p));
      return { ...d, blank, lvm, matches: isNamed, named: isNamed, osd: blank && isNamed };
    }
    const matches = filter ? !!re && re.test(d.name) : true;
    return { ...d, blank, lvm, matches, named: false, osd: blank && matches };
  });
}

export function deviceFilterIssues(filter: string | undefined): Issue[] {
  if (!filter || filterRegExp(filter)) {
    return [];
  }
  return [
    {
      field: 'rookDeviceFilter',
      severity: 'error',
      message: `"${filter}" is not a valid regular expression.`,
    },
  ];
}

/** Checks of features.rook; the creation inputs only while no CephCluster exists. */
export function rookIssues(
  spec: ClusterConfigSpec,
  ctx: { nodes: NodeLike[]; created: boolean }
): Issue[] {
  const rook = spec.features?.rook;
  if (!rook || ctx.created) {
    return [];
  }
  const issues = [
    ...deviceFilterIssues(rook.storage?.deviceFilter),
    ...namedDeviceIssues(spec, ctx.nodes),
  ];
  const count = schedulableNodes(ctx.nodes);
  const hosts = osdHosts(spec, count);
  if (rook.enabled && policyOf(spec) === 'Allow' && hosts < 3) {
    const d = rookDefaults(count, hosts);
    const where =
      storageNodes(spec).length > 0
        ? `${hosts} named node${hosts === 1 ? '' : 's'}`
        : `${count} node${count === 1 ? '' : 's'}`;
    issues.push({
      field: 'rookSmallCluster',
      severity: 'warning',
      message: `Ceph on ${where} has no redundancy (pool size ${d.poolSize}): a failed disk or node loses data.`,
    });
  }
  return issues;
}
