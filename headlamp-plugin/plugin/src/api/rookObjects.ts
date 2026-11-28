/*
 * What the Storage page reads and writes outside the ClusterConfig for the
 * k4all v2.7.2 Rook settings: whether the cluster serves the Prometheus
 * Operator's API (before monitoring is turned on), whether the user may
 * patch the CephCluster, and the crash collector's day-2 edit on the
 * CephCluster itself (k4all seeds it once and never owns it, so the page
 * never writes it through the ClusterConfig, and a change made in Cairn
 * stays).
 */

import { ApiProxy, Utils } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { classifyError } from '../model/errors';
import { writeQuery } from '../model/patch';
import {
  crashCollectorPatch,
  PrometheusOperatorApis,
  prometheusOperatorApis,
} from '../model/rookSettings';
import { CephClusterLike } from '../model/types';
import { Polled, usePolled } from './clusterObjects';

export const MONITORING_API_PATH = '/apis/monitoring.coreos.com/v1';

const BARE_422 = /rejected our request due to an error in our request/i;

/** ServiceMonitor and PrometheusRule served or not; polled every minute while shown. */
export function usePrometheusOperatorApis(enabled: boolean): Polled<PrometheusOperatorApis> {
  return usePolled<PrometheusOperatorApis>(
    enabled ? 'prometheus-operator-apis' : null,
    async () =>
      prometheusOperatorApis(
        (await ApiProxy.request(MONITORING_API_PATH)) as { resources?: { name: string }[] }
      ),
    { serviceMonitors: false, prometheusRules: false },
    60000
  );
}

export function cephClusterPath(c: CephClusterLike): string {
  return `/apis/ceph.rook.io/v1/namespaces/${encodeURIComponent(
    c.metadata.namespace ?? 'rook-ceph'
  )}/cephclusters/${encodeURIComponent(c.metadata.name)}`;
}

/** SelfSubjectAccessReview: may the user patch this CephCluster? false on any error. */
export async function canPatchCephCluster(c: CephClusterLike): Promise<boolean> {
  try {
    const r = (await ApiProxy.request('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      method: 'POST',
      body: JSON.stringify({
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: {
          resourceAttributes: {
            group: 'ceph.rook.io',
            resource: 'cephclusters',
            verb: 'patch',
            namespace: c.metadata.namespace ?? 'rook-ceph',
            name: c.metadata.name,
          },
        },
      }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    })) as { status?: { allowed?: boolean } };
    return r?.status?.allowed === true;
  } catch {
    return false;
  }
}

/** Per CephCluster (namespace/name): may the user patch it; absent while asking. */
export function useCanPatchCephClusters(clusters: CephClusterLike[]): Record<string, boolean> {
  const cluster = Utils.getCluster() ?? '';
  const key = clusters.map(c => `${c.metadata.namespace}/${c.metadata.name}`).join(',');
  const [allowed, setAllowed] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    let cancelled = false;
    Promise.all(
      clusters.map(async c => [
        `${c.metadata.namespace}/${c.metadata.name}`,
        await canPatchCephCluster(c),
      ])
    ).then(entries => {
      if (!cancelled) {
        setAllowed(Object.fromEntries(entries));
      }
    });
    return () => {
      cancelled = true;
    };
    // the key names the clusters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cluster]);
  return allowed;
}

/**
 * Turns the crash collector of a CephCluster on or off: a JSON Patch of
 * spec.crashCollector.disable, guarded by a test of the value the page read,
 * sent with fieldManager=k4all-headlamp. A change made meanwhile (in Cairn)
 * fails the test: the error says so, and nothing is overwritten.
 */
export async function setCrashCollector(c: CephClusterLike, on: boolean): Promise<CephClusterLike> {
  try {
    return (await ApiProxy.request(`${cephClusterPath(c)}?${writeQuery({ dryRun: false })}`, {
      method: 'PATCH',
      body: JSON.stringify(crashCollectorPatch(c, on)),
      headers: { 'Content-Type': 'application/json-patch+json', Accept: 'application/json' },
    })) as CephClusterLike;
  } catch (err) {
    const e = err as { status?: number; message?: string };
    // A failed "test" on a custom resource can also come back as a bare 422
    // (schema errors name the field instead), as Cairn reads it.
    const bareTestFailure = e?.status === 422 && BARE_422.test(e?.message ?? '');
    if (classifyError(err).kind === 'conflict' || bareTestFailure) {
      const conflict = new Error(
        'The crash collector changed meanwhile (in Cairn?): the page shows the new value within 30 seconds; try again then.'
      ) as Error & { status?: number };
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}
