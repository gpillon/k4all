/*
 * API discovery of the k4all group: is it served, and with which resources.
 */

import { ApiProxy, Utils } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { K4ALL_GROUP_VERSION } from '../model/types';

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
