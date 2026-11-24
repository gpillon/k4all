/*
 * Rook/Ceph (features.rook, k4all v2.7.0 / operator v0.6.0). k4all installs
 * the Rook operator and the RBD CSI driver, and creates once, with defaults,
 * the CephCluster rook-ceph, the pool vm-pool and the StorageClass ceph-rbd.
 * From then on they belong to the Cairn console: the ClusterConfig only holds
 * the creation inputs (storage.deviceFilter, smallCluster). Turning Rook off
 * is refused while a CephCluster exists, and k4all never wipes disks (D24).
 */

import { ComponentNotice, componentNotice } from './components';
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

/** What the RookHook creates for a node count (spec §9.2). */
export function rookDefaults(nodes: number): RookDefaults {
  if (nodes <= 1) {
    return { mons: 1, mgrs: 1, poolSize: 1, needsAllow: true };
  }
  if (nodes === 2) {
    return { mons: 1, mgrs: 2, poolSize: 2, needsAllow: true };
  }
  return { mons: nodes >= 5 ? 5 : 3, mgrs: 2, poolSize: 3, needsAllow: false };
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
  const policy = policyOf(input.spec);
  let small: RookView['small'];
  if (count < 3) {
    const d = rookDefaults(count);
    const nodesText = `${count} node${count === 1 ? '' : 's'}`;
    small = {
      nodes: count,
      policy,
      text:
        policy === 'Refuse'
          ? `With ${nodesText} and smallCluster Refuse, k4all creates no Ceph cluster: Ceph needs 3 nodes for redundancy.`
          : `No redundancy: ${d.mons} mon and a pool of size ${d.poolSize}. A failed disk or node loses the data on it.`,
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
}

export interface DiskCandidate extends DiskInfo {
  /** No partition, filesystem, LVM or other signature, not held or mounted. */
  blank: boolean;
  /** The device name matches the deviceFilter (or there is none). */
  matches: boolean;
  /** Rook makes it an OSD. */
  osd: boolean;
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

/** Which disks Rook would take: blank ones whose name matches the filter. */
export function diskCandidates(disks: DiskInfo[], filter: string | undefined): DiskCandidate[] {
  const re = filterRegExp(filter);
  return disks.map(d => {
    const blank =
      d.partitions.length === 0 &&
      d.signatures.length === 0 &&
      d.holders.length === 0 &&
      d.mounts.length === 0;
    const matches = filter ? !!re && re.test(d.name) : true;
    return { ...d, blank, matches, osd: blank && matches };
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
  const issues = deviceFilterIssues(rook.storage?.deviceFilter);
  const count = schedulableNodes(ctx.nodes);
  if (rook.enabled && policyOf(spec) === 'Allow' && count < 3) {
    const d = rookDefaults(count);
    issues.push({
      field: 'rookSmallCluster',
      severity: 'warning',
      message: `Ceph on ${count} node${count === 1 ? '' : 's'} has no redundancy (pool size ${
        d.poolSize
      }): a failed disk or node loses data.`,
    });
  }
  return issues;
}
