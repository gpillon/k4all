/*
 * Objects outside the k4all API that the v2.7.0 settings pages read: the
 * KubeVirt CR (gates, version), StorageClasses and CDI StorageProfiles (the
 * VM state picker), CephClusters (Rook), the node k4all-operator runs on (the
 * rollout order), Hangar's node agent inventories (the disks Ceph would take),
 * and what the kubevirt-manager removal kept.
 *
 * Plain list requests, polled every 30 s while a page shows them: none of
 * them changes often, and an API that is not served (no KubeVirt, no Rook)
 * is a normal answer (404 = "none"), not an error.
 */

import { ApiProxy, Utils } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { KubeletPrior, kubeletPriorFrom } from '../model/nodeSettings';
import { DiskInfo } from '../model/storage';
import {
  CephClusterLike,
  KubeVirtLike,
  StorageClassLike,
  StorageProfileLike,
} from '../model/types';

export const OPERATOR_NAMESPACE = 'k4all-operator-system';
export const HANGAR_AGENT_NAMESPACE = 'hangar-system';
const HANGAR_AGENT_PORT = 8095;

export const OBJECT_PATHS = {
  kubevirts: '/apis/kubevirt.io/v1/kubevirts',
  storageClasses: '/apis/storage.k8s.io/v1/storageclasses',
  storageProfiles: '/apis/cdi.kubevirt.io/v1beta1/storageprofiles',
  cephClusters: '/apis/ceph.rook.io/v1/cephclusters',
  operatorPods: `/api/v1/namespaces/${OPERATOR_NAMESPACE}/pods?labelSelector=${encodeURIComponent(
    'control-plane=controller-manager'
  )}`,
  agentPods: `/api/v1/namespaces/${HANGAR_AGENT_NAMESPACE}/pods?labelSelector=${encodeURIComponent(
    'app.kubernetes.io/name=hangar-node-agent'
  )}`,
};

export interface Polled<T> {
  /** null until the first answer. */
  value: T | null;
  /** The API is not served (404): the value is the empty answer. */
  missing: boolean;
  error: { status?: number; message?: string } | null;
}

/**
 * Runs fetcher now and every intervalMs while mounted (and again when key
 * changes). A 404 is an empty answer; other errors keep the last value.
 */
export function usePolled<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  empty: T,
  intervalMs = 30000
): Polled<T> {
  const cluster = Utils.getCluster() ?? '';
  const [state, setState] = React.useState<Polled<T>>({ value: null, missing: false, error: null });
  const fetchRef = React.useRef(fetcher);
  fetchRef.current = fetcher;
  React.useEffect(() => {
    if (key === null) {
      setState({ value: null, missing: false, error: null });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const value = await fetchRef.current();
        if (!cancelled) {
          setState({ value, missing: false, error: null });
        }
      } catch (err) {
        const e = err as { status?: number; message?: string };
        if (!cancelled) {
          setState(prev =>
            e?.status === 404
              ? { value: empty, missing: true, error: null }
              : { ...prev, error: { status: e?.status, message: e?.message } }
          );
        }
      }
      if (!cancelled) {
        timer = setTimeout(run, intervalMs);
      }
    };
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // empty is a constant per call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cluster, intervalMs]);
  return state;
}

async function listItems<T>(path: string): Promise<T[]> {
  const body = (await ApiProxy.request(path)) as { items?: T[] };
  return body?.items ?? [];
}

/** A cluster list, polled; `enabled` false skips the request (e.g. virt off). */
export function useObjectList<T>(path: string, enabled = true): Polled<T[]> {
  return usePolled<T[]>(enabled ? path : null, () => listItems<T>(path), []);
}

/** The KubeVirt CR (kubevirt/kubevirt on k4all), or null when there is none. */
export function useKubeVirt(
  enabled = true
): Polled<KubeVirtLike | null> & { cr: KubeVirtLike | null } {
  const list = useObjectList<KubeVirtLike>(OBJECT_PATHS.kubevirts, enabled);
  const items = list.value ?? [];
  const cr = items.find(k => k.metadata.name === 'kubevirt') ?? items[0] ?? null;
  return { value: list.value === null ? null : cr, missing: list.missing, error: list.error, cr };
}

export function useStorageClasses(): Polled<StorageClassLike[]> {
  return useObjectList<StorageClassLike>(OBJECT_PATHS.storageClasses);
}

export function useStorageProfiles(enabled = true): Polled<StorageProfileLike[]> {
  return useObjectList<StorageProfileLike>(OBJECT_PATHS.storageProfiles, enabled);
}

export function useCephClusters(): Polled<CephClusterLike[]> {
  return useObjectList<CephClusterLike>(OBJECT_PATHS.cephClusters);
}

interface PodLike {
  metadata: { name: string; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: { phase?: string };
}

/** The node k4all-operator's pod runs on, when the user may list its pods. */
export function useOperatorNode(): string | undefined {
  const pods = useObjectList<PodLike>(OBJECT_PATHS.operatorPods);
  return (pods.value ?? []).find(p => p.status?.phase === 'Running')?.spec?.nodeName;
}

/**
 * What each kubelet field k4all owns had before k4all wrote it, from the
 * record on kube-system/kubelet-config; null when unknown (no record, or
 * the user may not read ConfigMaps in kube-system).
 */
export function useKubeletPrior(): KubeletPrior | null {
  const cm = usePolled<{ metadata: { annotations?: Record<string, string> } } | null>(
    'kubelet-config',
    () =>
      ApiProxy.request('/api/v1/namespaces/kube-system/configmaps/kubelet-config') as Promise<{
        metadata: { annotations?: Record<string, string> };
      }>,
    null
  );
  return kubeletPriorFrom(cm.value);
}

export interface NodeDisks {
  node: string;
  disks: DiskInfo[] | null;
  error?: string;
}

export interface AgentInventories {
  /** Per node with a running agent pod. */
  nodes: NodeDisks[];
  /** No agent pod (hangar-node-agent not installed, or still starting). */
  missing: boolean;
  /** The user may not read them (pods or pods/proxy in hangar-system). */
  denied: boolean;
}

async function readInventories(): Promise<AgentInventories> {
  let pods: PodLike[];
  try {
    pods = (await listItems<PodLike>(OBJECT_PATHS.agentPods)).filter(
      p => p.status?.phase === 'Running' && !p.metadata.deletionTimestamp
    );
  } catch (err) {
    const status = (err as { status?: number })?.status;
    return { nodes: [], missing: status === 404, denied: status === 403 };
  }
  let denied = false;
  const nodes = await Promise.all(
    pods.map(async (p): Promise<NodeDisks> => {
      const node = p.spec?.nodeName ?? p.metadata.name;
      try {
        const inv = (await ApiProxy.request(
          `/api/v1/namespaces/${HANGAR_AGENT_NAMESPACE}/pods/${encodeURIComponent(
            p.metadata.name
          )}:${HANGAR_AGENT_PORT}/proxy/inventory.json`
        )) as { disks?: Partial<DiskInfo>[] };
        const arr = (x: unknown) => (Array.isArray(x) ? (x as string[]) : []);
        return {
          node,
          disks: (inv?.disks ?? []).map(d => ({
            name: String(d.name ?? ''),
            sizeBytes: typeof d.sizeBytes === 'number' ? d.sizeBytes : null,
            partitions: arr(d.partitions),
            signatures: arr(d.signatures),
            holders: arr(d.holders),
            mounts: arr(d.mounts),
          })),
        };
      } catch (err) {
        const e = err as { status?: number; message?: string };
        if (e?.status === 403) {
          denied = true;
        }
        return { node, disks: null, error: e?.message ?? 'no answer' };
      }
    })
  );
  return {
    nodes: nodes.sort((a, b) => a.node.localeCompare(b.node)),
    missing: pods.length === 0,
    denied,
  };
}

/** The disks Hangar's node agent reports per node (its inventory.json), polled. */
export function useAgentInventories(enabled: boolean): Polled<AgentInventories> {
  return usePolled<AgentInventories>(
    enabled ? 'inventories' : null,
    readInventories,
    { nodes: [], missing: true, denied: false },
    60000
  );
}

/** What the kubevirt-manager removal keeps while in use (spec §10.3). */
export const KUBEVIRT_MANAGER_KEPT = [
  {
    what: 'PriorityClass vm-standard',
    path: '/apis/scheduling.k8s.io/v1/priorityclasses/vm-standard',
    why: 'kept while a VM, VMI or pod names it (kubevirt-manager wrote it into the VMs it made)',
  },
  {
    what: 'PriorityClass vm-preemptible',
    path: '/apis/scheduling.k8s.io/v1/priorityclasses/vm-preemptible',
    why: 'kept while a VM, VMI or pod names it',
  },
  {
    what: 'CRD images.kubevirt-manager.io',
    path: '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/images.kubevirt-manager.io',
    why: 'kept while its image catalog holds images',
  },
  {
    what: 'Namespace kubevirt-manager',
    path: '/api/v1/namespaces/kubevirt-manager',
    why: 'kept while your objects are in it',
  },
];

export type KeptState = 'kept' | 'gone' | 'unknown';

/** Which of the objects the removal may keep still exist. */
export function useKubevirtManagerKept(enabled: boolean): Polled<KeptState[]> {
  return usePolled<KeptState[]>(
    enabled ? 'kubevirt-manager-kept' : null,
    () =>
      Promise.all(
        KUBEVIRT_MANAGER_KEPT.map(k =>
          ApiProxy.request(k.path).then(
            () => 'kept' as KeptState,
            (err: { status?: number }) => (err?.status === 404 ? 'gone' : 'unknown') as KeptState
          )
        )
      ),
    KUBEVIRT_MANAGER_KEPT.map(() => 'unknown' as KeptState),
    60000
  );
}
