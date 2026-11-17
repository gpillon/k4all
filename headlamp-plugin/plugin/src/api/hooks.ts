/*
 * Data hooks: the k4all resources and the cluster Nodes, watched through
 * Headlamp's list hooks, API discovery, and the user's write permissions.
 */

import { ApiProxy, K8s, Utils } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  CLUSTER_UPGRADE_NAME,
  ClusterConfigObject,
  ClusterUpgradeObject,
  K4ALL_GROUP_VERSION,
  NodeConfigObject,
  NodeLike,
  ReleaseManifestObject,
} from '../model/types';
import { ClusterConfig, ClusterUpgrade, NodeConfig, ReleaseManifest } from './resources';

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

/**
 * Resources served in k4all.magesgate.com/v1alpha1, per cluster. Only
 * positive answers are kept; an answer without clusterupgrades is asked again
 * on the next mount, since the operator can add that CRD while the page is open.
 */
const groupResources = new Map<string, Set<string> | null>();

export interface K4allDiscovery {
  /** The API group is served; null while asking. */
  present: boolean | null;
  /** Resource names in the group; null when unknown (asking, or the request failed). */
  resources: Set<string> | null;
}

function discoveryFromCache(cluster: string): K4allDiscovery {
  if (!groupResources.has(cluster)) {
    return { present: null, resources: null };
  }
  return { present: true, resources: groupResources.get(cluster) ?? null };
}

/**
 * One discovery request on k4all.magesgate.com/v1alpha1. The list hooks retry
 * a 404 several times before reporting it, so without this a non-k4all
 * cluster (or an operator without ClusterUpgrade) would show a spinner for
 * seconds. Errors other than 404 count as present: the pages then show their
 * own error.
 */
export function useK4allDiscovery(): K4allDiscovery {
  const cluster = Utils.getCluster() ?? '';
  const [state, setState] = React.useState<K4allDiscovery>(() => discoveryFromCache(cluster));
  React.useEffect(() => {
    // Another cluster: forget the previous answer until this one is known.
    setState(discoveryFromCache(cluster));
    const cached = groupResources.get(cluster);
    if (cached && cached.has('clusterupgrades')) {
      setState({ present: true, resources: cached });
      return;
    }
    let cancelled = false;
    ApiProxy.request(`/apis/${K4ALL_GROUP_VERSION}`)
      .then(
        (list: { resources?: { name: string }[] }): K4allDiscovery => ({
          present: true,
          resources: new Set((list?.resources ?? []).map(r => r.name)),
        }),
        (err: { status?: number }): K4allDiscovery =>
          err?.status === 404
            ? { present: false, resources: null }
            : { present: true, resources: null }
      )
      .then(result => {
        if (result.present) {
          groupResources.set(cluster, result.resources);
        }
        if (!cancelled) {
          setState(result);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cluster]);
  return state;
}

/** Whether the cluster serves the k4all API group; null while asking. */
export function useK4allApiPresent(): boolean | null {
  return useK4allDiscovery().present;
}

/**
 * Whether the installed operator serves ClusterUpgrade (k4all-operator
 * v0.4.0+): true, false, or null while asking. An unknown resource list
 * counts as served, so a real error shows up on the page.
 */
export function useClusterUpgradeServed(): boolean | null {
  const { present, resources } = useK4allDiscovery();
  if (present === null) {
    return null;
  }
  if (!present) {
    return false;
  }
  return resources === null ? true : resources.has('clusterupgrades');
}

export interface ClusterUpgradeData {
  cu: ClusterUpgradeObject | null;
  loading: boolean;
  error: { status?: number; message?: string } | null;
}

/** The ClusterUpgrade "k4all", watched. Only call it where the resource is served. */
export function useClusterUpgrade(): ClusterUpgradeData {
  const [list, error] = ClusterUpgrade.useList();
  const items = (list ?? []).map(c => c.object);
  return {
    cu: items.find(c => c.metadata.name === CLUSTER_UPGRADE_NAME) ?? null,
    loading: list === null && !error,
    error: (error ?? null) as ClusterUpgradeData['error'],
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

export function useK4allData(): K4allData {
  const present = useK4allApiPresent();
  const [ccList, ccError] = ClusterConfig.useList();
  const [rmList, rmError] = ReleaseManifest.useList();
  const [ncList] = NodeConfig.useList();
  const [nodeList] = K8s.ResourceClasses.Node.useList();

  const ccs = byName((ccList ?? []).map(c => c.object));
  const rms = byName((rmList ?? []).map(r => r.object));
  const error = (ccError ?? rmError ?? null) as K4allData['error'];
  return {
    cc: ccs[0] ?? null,
    rm: rms.find(r => r.metadata.name === 'k4all') ?? rms[0] ?? null,
    extraClusterConfigs: ccs.slice(1).map(c => c.metadata.name),
    nodes: (nodeList ?? []).map(n => n.jsonData as unknown as NodeLike),
    nodeConfigs: (ncList ?? []).map(n => n.object),
    loading: present !== false && ((ccList === null && !ccError) || (rmList === null && !rmError)),
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
