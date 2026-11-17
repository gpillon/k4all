/*
 * Keeping the pages live through API server and Headlamp restarts.
 *
 * Headlamp's list hooks watch through one multiplexed WebSocket. During an
 * upgrade the API server restarts (kubeadm upgrade, reboots) and, on a single
 * node, Headlamp's own pod is recreated; the watches then stop without an
 * error and the page freezes on an old state. The plugin therefore also polls
 * the lists it shows, keeps per object whichever copy is newer, and remounts
 * the watches when they fail, fall behind the poll, or the cluster comes back.
 * This file is the pure part of that: no React, no I/O.
 */

import { ClusterUpgradeObject } from './types';

/** Poll interval while an upgrade runs, or the cluster cannot be reached. */
export const FAST_POLL_MS = 10_000;
/** Poll interval otherwise. */
export const SLOW_POLL_MS = 60_000;
/** Never remount the watches more often than this. */
export const MIN_REMOUNT_GAP_MS = 10_000;
/** Polls in a row that must find the watch behind before it is remounted. */
export const BEHIND_POLLS_BEFORE_REMOUNT = 2;

export interface Versioned {
  metadata: { name: string; namespace?: string; resourceVersion?: string };
}

/** resourceVersion as a number when it is one (etcd revisions are), else null. */
export function revision(obj: Versioned | null | undefined): number | null {
  const rv = obj?.metadata.resourceVersion;
  if (!rv || !/^\d+$/.test(rv)) {
    return null;
  }
  const n = Number(rv);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Whether a is a newer copy of the object than b. resourceVersions are
 * compared as numbers; when one cannot be compared, the copy received later
 * (aAt, bAt) wins, and on a tie the watch copy (b) is kept.
 */
export function isNewer(a: Versioned, aAt: number, b: Versioned, bAt: number): boolean {
  const ra = revision(a);
  const rb = revision(b);
  if (ra !== null && rb !== null) {
    return ra > rb;
  }
  return aAt > bAt;
}

export interface ListSnapshot<T extends Versioned> {
  items: T[];
  /** When it was received (ms). */
  at: number;
  /** The list's own resourceVersion (polls), when known. */
  listRevision?: number | null;
}

export interface MergeResult<T extends Versioned> {
  items: T[];
  /** Names where the poll had a newer copy than the watch: the watch is behind. */
  pollAhead: string[];
}

/**
 * One list from the watch and the poll. Membership (creations, deletions)
 * comes from the newer of the two lists: the poll's list resourceVersion
 * against the newest object the watch has. Each object is then the newer of
 * its two copies.
 */
export function mergeLists<T extends Versioned>(
  watch: ListSnapshot<T> | null,
  poll: ListSnapshot<T> | null
): MergeResult<T> {
  if (!poll) {
    return { items: watch?.items ?? [], pollAhead: [] };
  }
  if (!watch) {
    return { items: poll.items, pollAhead: [] };
  }
  const watchByName = new Map(watch.items.map(i => [i.metadata.name, i]));
  const pollByName = new Map(poll.items.map(i => [i.metadata.name, i]));
  const watchTop = Math.max(-1, ...watch.items.map(i => revision(i) ?? -1));
  const pollTop = poll.listRevision ?? Math.max(-1, ...poll.items.map(i => revision(i) ?? -1));
  const pollDecides = watchTop >= 0 && pollTop >= 0 ? pollTop > watchTop : poll.at > watch.at;
  const names = pollDecides ? [...pollByName.keys()] : [...watchByName.keys()];
  const pollAhead: string[] = [];
  const items = names.map(name => {
    const w = watchByName.get(name);
    const p = pollByName.get(name);
    if (!w) {
      if (pollDecides) {
        pollAhead.push(name);
      }
      return p!;
    }
    if (!p) {
      return w;
    }
    if (isNewer(p, poll.at, w, watch.at)) {
      pollAhead.push(name);
      return p;
    }
    return w;
  });
  if (pollDecides) {
    // An object the watch still shows but the poll no longer lists was deleted.
    for (const name of watchByName.keys()) {
      if (!pollByName.has(name)) {
        pollAhead.push(name);
      }
    }
  }
  return { items, pollAhead };
}

/**
 * An upgrade is under way: Progressing or Paused, or a node that is neither
 * Done nor Pending (draining, upgrading, failed).
 */
export function upgradeIsActive(cu: ClusterUpgradeObject | null | undefined): boolean {
  const status = cu?.status;
  if (!status) {
    return false;
  }
  if (status.phase === 'Progressing' || status.phase === 'Paused') {
    return true;
  }
  return (status.nodes ?? []).some(n => n.phase !== 'Done' && n.phase !== 'Pending');
}

/** 10 s while an upgrade runs or the cluster is unreachable, 60 s otherwise. */
export function pollIntervalMs(cu: ClusterUpgradeObject | null | undefined, down: boolean): number {
  return down || upgradeIsActive(cu) ? FAST_POLL_MS : SLOW_POLL_MS;
}

// ------------------------------------------------------------- Watch health

export interface LiveState {
  /** Bumped to remount the watches (React key). */
  watchKey: number;
  lastRemount: number;
  /** The last poll failed because the cluster could not be reached. */
  down: boolean;
  /** When the cluster stopped answering. */
  downSince: number | null;
  /** Consecutive polls that found the watch behind. */
  behindPolls: number;
  /** A watch reported an error since the last remount. */
  watchFailed: boolean;
  /** Last time data arrived (poll success or watch update). */
  updatedAt: number | null;
}

export const initialLiveState: LiveState = {
  watchKey: 0,
  lastRemount: 0,
  down: false,
  downSince: null,
  behindPolls: 0,
  watchFailed: false,
  updatedAt: null,
};

export type LiveEvent =
  /** A watch delivered data (no error). */
  | { type: 'watchData'; now: number }
  /** A watch reported an error the cluster being unreachable explains (not 401/403/404). */
  | { type: 'watchError'; now: number }
  /** A poll succeeded; behind: the watch was behind on at least one object. */
  | { type: 'pollOk'; now: number; behind: boolean }
  /** A poll failed; unreachable: network, timeout, 5xx (not 401/403/404). */
  | { type: 'pollFailed'; now: number; unreachable: boolean }
  /** The user asked to refresh. */
  | { type: 'refresh'; now: number };

function remount(state: LiveState, now: number): LiveState {
  return {
    ...state,
    watchKey: state.watchKey + 1,
    lastRemount: now,
    behindPolls: 0,
    watchFailed: false,
  };
}

/**
 * What the watches and polls report, and when to remount the watches: after
 * a watch error (once the cluster answers), when the cluster answers again
 * after being unreachable,
 * when the poll found the watch behind BEHIND_POLLS_BEFORE_REMOUNT times in a
 * row, and on a manual refresh; never twice within MIN_REMOUNT_GAP_MS, except
 * for a manual refresh.
 */
export function liveReducer(state: LiveState, event: LiveEvent): LiveState {
  const canRemount = event.now - state.lastRemount >= MIN_REMOUNT_GAP_MS;
  switch (event.type) {
    case 'watchData':
      return { ...state, updatedAt: event.now };
    case 'watchError': {
      const next = { ...state, watchFailed: true };
      // While the cluster does not answer, a new watch would fail too: wait
      // for a poll to get through, which remounts.
      return canRemount && !state.down ? remount(next, event.now) : next;
    }
    case 'pollOk': {
      const recovered = state.down;
      const behindPolls = event.behind ? state.behindPolls + 1 : 0;
      const next: LiveState = {
        ...state,
        down: false,
        downSince: null,
        behindPolls,
        updatedAt: event.now,
      };
      const needed = recovered || state.watchFailed || behindPolls >= BEHIND_POLLS_BEFORE_REMOUNT;
      return needed && canRemount ? remount(next, event.now) : next;
    }
    case 'pollFailed':
      if (!event.unreachable) {
        return state;
      }
      return { ...state, down: true, downSince: state.downSince ?? event.now };
    case 'refresh':
      return remount(state, event.now);
  }
  return state;
}
