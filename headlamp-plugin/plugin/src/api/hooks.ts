/*
 * Data hooks: the k4all resources and the cluster Nodes, watched through
 * Headlamp's list hooks, plus the user's write permissions.
 */

import { ApiProxy, K8s, Utils } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  ClusterConfigObject,
  K4ALL_GROUP_VERSION,
  NodeConfigObject,
  NodeLike,
  ReleaseManifestObject,
} from '../model/types';
import { ClusterConfig, NodeConfig, ReleaseManifest } from './resources';

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

/** Positive answers per cluster; a missing group is asked again on the next mount. */
const groupPresent = new Set<string>();

/**
 * Whether the cluster serves k4all.magesgate.com/v1alpha1, from one discovery
 * request. The list hooks retry a 404 several times before reporting it, so
 * without this a non-k4all cluster would show a spinner for seconds. Errors
 * other than 404 count as present: the pages then show their own error.
 */
export function useK4allApiPresent(): boolean | null {
  const cluster = Utils.getCluster() ?? '';
  const [present, setPresent] = React.useState<boolean | null>(() =>
    groupPresent.has(cluster) ? true : null
  );
  React.useEffect(() => {
    if (groupPresent.has(cluster)) {
      setPresent(true);
      return;
    }
    let cancelled = false;
    ApiProxy.request(`/apis/${K4ALL_GROUP_VERSION}`)
      .then(
        () => true,
        (err: { status?: number }) => err?.status !== 404
      )
      .then(ok => {
        if (ok) {
          groupPresent.add(cluster);
        }
        if (!cancelled) {
          setPresent(ok);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cluster]);
  return present;
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
