/*
 * K4allLive: the data every k4all page shows, kept live through API server
 * and Headlamp restarts (model/live.ts explains why).
 *
 * - Watches: Headlamp's list hooks, each in a small component keyed by
 *   watchKey, so bumping the key remounts them and they subscribe again (a
 *   new subscription also reopens Headlamp's multiplexed WebSocket).
 * - Polls: plain list requests every 10 s while an upgrade runs or the
 *   cluster does not answer, every 60 s otherwise.
 * - Per object, the copy with the newer resourceVersion wins.
 *
 * Pages read it through useK4allData(), useClusterUpgrade() and
 * useLiveStatus(); index.tsx wraps every k4all route in <K4allLive>.
 */

import { ApiProxy, K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { classifyError } from '../model/errors';
import {
  initialLiveState,
  ListSnapshot,
  liveReducer,
  LiveState,
  mergeLists,
  pollIntervalMs,
  Versioned,
} from '../model/live';
import { CLUSTER_UPGRADE_NAME, ClusterUpgradeObject, K4ALL_GROUP_VERSION } from '../model/types';
import { useK4allDiscovery } from './discovery';
import { ClusterConfig, ClusterUpgrade, NodeConfig, ReleaseManifest } from './resources';

export type LiveKey = 'cc' | 'rm' | 'nc' | 'nodes' | 'cu';

export const LIST_PATHS: Record<LiveKey, string> = {
  cc: `/apis/${K4ALL_GROUP_VERSION}/clusterconfigs`,
  rm: `/apis/${K4ALL_GROUP_VERSION}/releasemanifests`,
  nc: `/apis/${K4ALL_GROUP_VERSION}/nodeconfigs`,
  cu: `/apis/${K4ALL_GROUP_VERSION}/clusterupgrades`,
  nodes: '/api/v1/nodes',
};

export type ApiErrorLike = { status?: number; message?: string };

type Json = Versioned & Record<string, any>;

interface WatchState {
  snapshot: ListSnapshot<Json> | null;
  error: ApiErrorLike | null;
}

interface PollState {
  snapshot: ListSnapshot<Json> | null;
  error: ApiErrorLike | null;
}

export interface LiveData {
  /** Merged lists, null until either source delivered. */
  lists: Record<LiveKey, Json[] | null>;
  /** Per list: the error, when neither source has data. */
  errors: Record<LiveKey, ApiErrorLike | null>;
  discovery: ReturnType<typeof useK4allDiscovery>;
  /** ClusterUpgrade is served (operator v0.4.0+); null while asking. */
  cuServed: boolean | null;
  status: LiveStatus;
}

export interface LiveStatus {
  /** Last time data arrived from a watch or a poll (ms), null before any. */
  updatedAt: number | null;
  /** The cluster does not answer (API server or Headlamp restarting). */
  down: boolean;
  downSince: number | null;
  /** Current poll interval (ms). */
  intervalMs: number;
  /** Remounts the watches and polls now. */
  refresh: () => void;
}

const LiveContext = React.createContext<LiveData | null>(null);

export function useLiveData(): LiveData | null {
  return React.useContext(LiveContext);
}

const NO_STATUS: LiveStatus = {
  updatedAt: null,
  down: false,
  downSince: null,
  intervalMs: 0,
  refresh: () => undefined,
};

/** Freshness of the page data: last update, cluster reachability, refresh. */
export function useLiveStatus(): LiveStatus {
  return useLiveData()?.status ?? NO_STATUS;
}

interface Listable {
  useList: () => [any[] | null, ApiErrorLike | null];
}

/** Identity of a list: names and resourceVersions, so a re-render with equal data is no change. */
export function listSignature(items: Json[] | null): string {
  if (!items) {
    return 'null';
  }
  return items
    .map(
      i => `${i.metadata.namespace ?? ''}/${i.metadata.name}@${i.metadata.resourceVersion ?? ''}`
    )
    .join(',');
}

/**
 * One watch. Renders nothing; reports its list and error upwards, only when
 * they change (a hook may hand out a new array with the same objects on
 * every render).
 */
function ListWatch(props: {
  cls: Listable;
  onChange: (items: Json[] | null, error: ApiErrorLike | null) => void;
}) {
  const [list, error] = props.cls.useList();
  const items = list ? list.map(o => (o.jsonData ?? o) as Json) : null;
  const latest = React.useRef({ items, error: error ?? null });
  latest.current = { items, error: error ?? null };
  const sig = listSignature(items);
  const errSig = error ? `${error.status ?? ''}:${error.message ?? ''}` : '';
  const { onChange } = props;
  React.useEffect(() => {
    onChange(latest.current.items, latest.current.error);
  }, [sig, errSig, onChange]);
  return null;
}

function emptyRecord<T>(value: T): Record<LiveKey, T> {
  return { cc: value, rm: value, nc: value, nodes: value, cu: value };
}

function asListSnapshot(body: any, at: number): ListSnapshot<Json> {
  const rv = body?.metadata?.resourceVersion;
  return {
    items: (body?.items ?? []) as Json[],
    at,
    listRevision: rv && /^\d+$/.test(rv) ? Number(rv) : null,
  };
}

/** The ClusterUpgrade "k4all" from a merged list. */
export function pickClusterUpgrade(items: Json[] | null): ClusterUpgradeObject | null {
  return (
    ((items ?? []).find(i => i.metadata.name === CLUSTER_UPGRADE_NAME) as ClusterUpgradeObject) ??
    null
  );
}

export function K4allLive(props: { children: React.ReactNode; now?: () => number }) {
  const now = props.now ?? Date.now;
  const discovery = useK4allDiscovery();
  const present = discovery.present;
  const cuServed =
    present === null
      ? null
      : !present
      ? false
      : discovery.resources === null || discovery.resources.has('clusterupgrades');

  const [watch, setWatch] = React.useState<Record<LiveKey, WatchState>>(() =>
    emptyRecord<WatchState>({ snapshot: null, error: null })
  );
  const [poll, setPoll] = React.useState<Record<LiveKey, PollState>>(() =>
    emptyRecord<PollState>({ snapshot: null, error: null })
  );
  const [live, dispatch] = React.useReducer(liveReducer, initialLiveState);
  const [pollNow, setPollNow] = React.useState(0);
  const watchRef = React.useRef(watch);
  watchRef.current = watch;

  // One stable callback per list, so the watch components do not re-run their effect.
  const onWatch = React.useMemo(() => {
    const make = (key: LiveKey) => (items: Json[] | null, error: ApiErrorLike | null) => {
      const at = now();
      setWatch(prev => {
        const old = prev[key];
        // Loading (a fresh mount) or failing without data: keep the last good list.
        const snapshot = items ? { items, at } : old.snapshot;
        return { ...prev, [key]: { snapshot, error } };
      });
      if (error) {
        // Only failures a new watch can fix: not 401/403/404.
        if (classifyError(error).kind === 'unavailable') {
          dispatch({ type: 'watchError', now: at });
        }
      } else if (items) {
        dispatch({ type: 'watchData', now: at });
      }
    };
    return {
      cc: make('cc'),
      rm: make('rm'),
      nc: make('nc'),
      nodes: make('nodes'),
      cu: make('cu'),
    };
    // now is a test seam and stable in practice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const merged = React.useMemo(() => {
    const lists = emptyRecord<Json[] | null>(null);
    const errors = emptyRecord<ApiErrorLike | null>(null);
    for (const key of Object.keys(lists) as LiveKey[]) {
      const w = watch[key];
      const p = poll[key];
      if (!w.snapshot && !p.snapshot) {
        errors[key] = w.error ?? p.error;
        continue;
      }
      lists[key] = mergeLists(w.snapshot, p.snapshot).items;
    }
    return { lists, errors };
  }, [watch, poll]);

  const cu = pickClusterUpgrade(merged.lists.cu);
  const intervalMs = pollIntervalMs(cu, live.down);

  // The lists to poll: the k4all ones only where the group is served.
  const keys = React.useMemo<LiveKey[]>(() => {
    const out: LiveKey[] = ['nodes'];
    if (present) {
      out.push('cc', 'rm', 'nc');
    }
    if (cuServed) {
      out.push('cu');
    }
    return out;
  }, [present, cuServed]);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const results = await Promise.allSettled(keys.map(k => ApiProxy.request(LIST_PATHS[k])));
      if (cancelled) {
        return;
      }
      const at = now();
      let unreachable = false;
      let failed = false;
      let behind = false;
      const next: Partial<Record<LiveKey, PollState>> = {};
      results.forEach((r, i) => {
        const key = keys[i];
        if (r.status === 'fulfilled') {
          const snapshot = asListSnapshot(r.value, at);
          next[key] = { snapshot, error: null };
          if (mergeLists(watchRef.current[key].snapshot, snapshot).pollAhead.length > 0) {
            behind = true;
          }
        } else {
          failed = true;
          const err = r.reason as ApiErrorLike;
          if (classifyError(err).kind === 'unavailable') {
            unreachable = true;
          }
          next[key] = { snapshot: null, error: { status: err?.status, message: err?.message } };
        }
      });
      setPoll(prev => {
        const out = { ...prev };
        for (const [key, value] of Object.entries(next) as [LiveKey, PollState][]) {
          // A failed poll keeps the last good copy; it only records the error.
          out[key] = value.snapshot ? value : { ...prev[key], error: value.error };
        }
        return out;
      });
      dispatch(
        failed ? { type: 'pollFailed', now: at, unreachable } : { type: 'pollOk', now: at, behind }
      );
      timer = setTimeout(run, intervalMs);
    };
    // Right away after a manual refresh, else after one interval: the watches
    // load the page themselves.
    timer = setTimeout(run, pollNow > 0 ? 0 : intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // now is a test seam and stable in practice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, intervalMs, pollNow]);

  const refresh = React.useCallback(() => {
    dispatch({ type: 'refresh', now: now() });
    setPollNow(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: LiveData = {
    lists: merged.lists,
    errors: merged.errors,
    discovery,
    cuServed,
    status: {
      updatedAt: live.updatedAt,
      down: live.down,
      downSince: live.downSince,
      intervalMs,
      refresh,
    },
  };

  const k = live.watchKey;
  return (
    <LiveContext.Provider value={value}>
      <ListWatch
        key={`nodes-${k}`}
        cls={K8s.ResourceClasses.Node as Listable}
        onChange={onWatch.nodes}
      />
      {present && (
        <>
          <ListWatch key={`cc-${k}`} cls={ClusterConfig as Listable} onChange={onWatch.cc} />
          <ListWatch key={`rm-${k}`} cls={ReleaseManifest as Listable} onChange={onWatch.rm} />
          <ListWatch key={`nc-${k}`} cls={NodeConfig as Listable} onChange={onWatch.nc} />
        </>
      )}
      {cuServed && (
        <ListWatch key={`cu-${k}`} cls={ClusterUpgrade as Listable} onChange={onWatch.cu} />
      )}
      {props.children}
    </LiveContext.Provider>
  );
}

/** For tests and debugging: the reducer state is not exposed otherwise. */
export type { LiveState };
