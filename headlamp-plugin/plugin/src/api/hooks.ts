/*
 * Data hooks: the k4all resources and the cluster Nodes (kept live by
 * K4allLive, api/live.tsx), API discovery, and the user's write permissions.
 */

import { Utils } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  CLUSTER_UPGRADE_NAME,
  ClusterConfigObject,
  ClusterUpgradeObject,
  NodeConfigObject,
  NodeLike,
  ReleaseManifestObject,
} from '../model/types';
import { pickClusterUpgrade, useLiveData } from './live';
import { ClusterConfig, ClusterUpgrade, ReleaseManifest } from './resources';

export interface K4allData {
  cc: ClusterConfigObject | null;
  rm: ReleaseManifestObject | null;
  /** More than one ClusterConfig: the operator uses the first by name. */
  extraClusterConfigs: string[];
  nodes: NodeLike[];
  nodeConfigs: NodeConfigObject[];
  loading: boolean;
  /** The k4all CRDs are not installed (404 on the API group). */
  crdsMissing: boolean;
  error: { status?: number; message?: string } | null;
}

function byName<T extends { metadata: { name: string } }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export { useClusterUpgradeServed, useK4allApiPresent, useK4allDiscovery } from './discovery';
export type { K4allDiscovery } from './discovery';

export interface ClusterUpgradeData {
  cu: ClusterUpgradeObject | null;
  loading: boolean;
  error: { status?: number; message?: string } | null;
}

/** The ClusterUpgrade "k4all", watched. Only call it where the resource is served. */
/** The ClusterUpgrade "k4all", live (K4allLive). Only meaningful where the resource is served. */
export function useClusterUpgrade(): ClusterUpgradeData {
  const live = useLiveData();
  const items = live?.lists.cu ?? null;
  const error = live?.errors.cu ?? null;
  return {
    cu: pickClusterUpgrade(items),
    loading: items === null && !error,
    error,
  };
}

/** SelfSubjectAccessReview for patch on the ClusterUpgrade k4all; null while asking. */
export function useCanPatchClusterUpgrade(): boolean | null {
  const cluster = Utils.getCluster() ?? '';
  const [allowed, setAllowed] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    setAllowed(null);
    let cancelled = false;
    // Named: a role may grant patch on resourceNames [k4all] only.
    ClusterUpgrade.getAuthorization('patch', { name: CLUSTER_UPGRADE_NAME })
      .then((r: any) => r?.status?.allowed === true)
      .catch(() => false)
      .then((ok: boolean) => {
        if (!cancelled) {
          setAllowed(ok);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cluster]);
  return allowed;
}

/**
 * The k4all resources and the Nodes, live: watched and polled by K4allLive,
 * which every k4all route is wrapped in (index.tsx).
 */
export function useK4allData(): K4allData {
  const live = useLiveData();
  const present = live?.discovery.present ?? null;
  const lists = live?.lists;
  const errors = live?.errors;
  const ccList = lists?.cc ?? null;
  const rmList = lists?.rm ?? null;
  const ccError = errors?.cc ?? null;
  const rmError = errors?.rm ?? null;
  const ccs = byName((ccList ?? []) as ClusterConfigObject[]);
  const rms = byName((rmList ?? []) as ReleaseManifestObject[]);
  const error = ccError ?? rmError ?? null;
  return {
    cc: ccs[0] ?? null,
    rm: rms.find(r => r.metadata.name === 'k4all') ?? rms[0] ?? null,
    extraClusterConfigs: ccs.slice(1).map(c => c.metadata.name),
    nodes: (lists?.nodes ?? []) as unknown as NodeLike[],
    nodeConfigs: (lists?.nc ?? []) as unknown as NodeConfigObject[],
    loading:
      !live ||
      (present !== false && ((ccList === null && !ccError) || (rmList === null && !rmError))),
    crdsMissing: present === false || error?.status === 404,
    error,
  };
}

export interface Permissions {
  /** Still asking the API server. */
  checking: boolean;
  patchClusterConfig: boolean;
  patchReleaseManifest: boolean;
}

/** SelfSubjectAccessReviews for the two writes the plugin does. */
export function usePermissions(): Permissions {
  const [perms, setPerms] = React.useState<Permissions>({
    checking: true,
    patchClusterConfig: false,
    patchReleaseManifest: false,
  });
  React.useEffect(() => {
    let cancelled = false;
    const allowed = (p: Promise<any>) =>
      p.then(r => r?.status?.allowed === true).catch(() => false);
    Promise.all([
      allowed(ClusterConfig.getAuthorization('patch')),
      allowed(ReleaseManifest.getAuthorization('patch')),
    ]).then(([cc, rm]) => {
      if (!cancelled) {
        setPerms({ checking: false, patchClusterConfig: cc, patchReleaseManifest: rm });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return perms;
}

/** Re-renders every interval ms; for "x minutes ago" and staleness checks. */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
