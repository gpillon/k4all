import { clusterUpgrade, clusterUpgradeInProgress } from './fixtures';
import {
  BEHIND_POLLS_BEFORE_REMOUNT,
  FAST_POLL_MS,
  initialLiveState,
  isNewer,
  LiveEvent,
  liveReducer,
  LiveState,
  mergeLists,
  MIN_REMOUNT_GAP_MS,
  pollIntervalMs,
  revision,
  SLOW_POLL_MS,
  upgradeIsActive,
} from './live';

const obj = (name: string, rv?: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name, resourceVersion: rv },
  ...extra,
});

describe('watch or poll: the newer resourceVersion wins', () => {
  it('compares resourceVersions as numbers', () => {
    expect(revision(obj('a', '1200'))).toBe(1200);
    expect(revision(obj('a', 'abc'))).toBeNull();
    expect(revision(obj('a'))).toBeNull();
    // numerically, not as strings ("900" > "1200" as text)
    expect(isNewer(obj('a', '1200'), 1, obj('a', '900'), 2)).toBe(true);
    expect(isNewer(obj('a', '900'), 2, obj('a', '1200'), 1)).toBe(false);
  });

  it('falls back to the copy received later when a version cannot be compared', () => {
    expect(isNewer(obj('a', 'x'), 20, obj('a', '5'), 10)).toBe(true);
    expect(isNewer(obj('a', 'x'), 10, obj('a', '5'), 10)).toBe(false); // tie: keep the watch
  });

  it('keeps the watch copy when it is newer, and flags nothing', () => {
    const watch = { items: [obj('k4all', '50', { phase: 'Progressing' })], at: 100 };
    const poll = {
      items: [obj('k4all', '40', { phase: 'Idle' })],
      at: 200,
      listRevision: 40,
    };
    const merged = mergeLists(watch, poll);
    expect(merged.items).toEqual([obj('k4all', '50', { phase: 'Progressing' })]);
    expect(merged.pollAhead).toEqual([]);
  });

  it('takes the poll copy when the watch fell behind, and says so', () => {
    const watch = { items: [obj('k4all', '50', { phase: 'Progressing' })], at: 100 };
    const poll = {
      items: [obj('k4all', '75', { phase: 'Succeeded' })],
      at: 200,
      listRevision: 80,
    };
    const merged = mergeLists(watch, poll);
    expect(merged.items[0]).toMatchObject({ phase: 'Succeeded' });
    expect(merged.pollAhead).toEqual(['k4all']);
  });

  it('follows the newer list for creations and deletions', () => {
    const watch = { items: [obj('cp-1', '10'), obj('w-old', '11')], at: 100 };
    const newerPoll = {
      items: [obj('cp-1', '10'), obj('w-new', '30')],
      at: 200,
      listRevision: 31,
    };
    const merged = mergeLists(watch, newerPoll);
    expect(merged.items.map(i => i.metadata.name)).toEqual(['cp-1', 'w-new']);
    expect(merged.pollAhead.sort()).toEqual(['w-new', 'w-old']);
    // an older poll does not resurrect or delete anything
    const olderPoll = { items: [obj('cp-1', '10')], at: 200, listRevision: 9 };
    expect(mergeLists(watch, olderPoll).items.map(i => i.metadata.name)).toEqual(['cp-1', 'w-old']);
  });

  it('uses whichever source exists', () => {
    const only = { items: [obj('a', '1')], at: 1 };
    expect(mergeLists(null, only).items).toEqual(only.items);
    expect(mergeLists(only, null).items).toEqual(only.items);
    expect(mergeLists(null, null).items).toEqual([]);
  });
});

describe('poll interval by upgrade phase', () => {
  it('polls every 10 s while an upgrade runs, 60 s otherwise', () => {
    expect(pollIntervalMs(clusterUpgradeInProgress(), false)).toBe(FAST_POLL_MS);
    expect(pollIntervalMs(clusterUpgrade(), false)).toBe(SLOW_POLL_MS);
    expect(pollIntervalMs(null, false)).toBe(SLOW_POLL_MS);
    expect(FAST_POLL_MS).toBe(10_000);
    expect(SLOW_POLL_MS).toBe(60_000);
  });

  it('counts Paused, and a node outside Done/Pending, as active', () => {
    const paused = clusterUpgrade();
    paused.status!.phase = 'Paused';
    expect(upgradeIsActive(paused)).toBe(true);
    const failedNode = clusterUpgrade();
    failedNode.status!.phase = 'Failed';
    failedNode.status!.nodes![1].phase = 'Failed';
    expect(upgradeIsActive(failedNode)).toBe(true);
    const failedPlan = clusterUpgrade();
    failedPlan.status!.phase = 'Failed'; // no node moving: nothing to follow closely
    expect(upgradeIsActive(failedPlan)).toBe(false);
    const succeeded = clusterUpgrade();
    succeeded.status!.phase = 'Succeeded';
    expect(upgradeIsActive(succeeded)).toBe(false);
  });

  it('polls fast while the cluster does not answer', () => {
    expect(pollIntervalMs(clusterUpgrade(), true)).toBe(FAST_POLL_MS);
  });
});

describe('liveReducer: when the watches are remounted', () => {
  const run = (events: LiveEvent[], from: LiveState = initialLiveState) =>
    events.reduce(liveReducer, from);
  const t0 = 100_000;

  it('remounts after a watch error', () => {
    const s = run([{ type: 'watchError', now: t0 }]);
    expect(s.watchKey).toBe(1);
    expect(s.watchFailed).toBe(false);
  });

  it('does not remount twice within the minimum gap, and catches up on the next poll', () => {
    let s = run([
      { type: 'watchError', now: t0 },
      { type: 'watchError', now: t0 + 1000 },
    ]);
    expect(s.watchKey).toBe(1);
    expect(s.watchFailed).toBe(true);
    s = run([{ type: 'pollOk', now: t0 + MIN_REMOUNT_GAP_MS, behind: false }], s);
    expect(s.watchKey).toBe(2);
  });

  it('waits for the cluster while it does not answer, then remounts when it answers again', () => {
    let s = run([
      { type: 'pollFailed', now: t0, unreachable: true },
      { type: 'watchError', now: t0 + 1000 },
      { type: 'pollFailed', now: t0 + 11_000, unreachable: true },
    ]);
    expect(s).toMatchObject({ down: true, downSince: t0, watchKey: 0 });
    s = run([{ type: 'pollOk', now: t0 + 21_000, behind: false }], s);
    expect(s).toMatchObject({ down: false, downSince: null, watchKey: 1, updatedAt: t0 + 21_000 });
  });

  it('remounts a watch that stays behind the poll', () => {
    let s: LiveState = initialLiveState;
    for (let i = 1; i < BEHIND_POLLS_BEFORE_REMOUNT; i++) {
      s = liveReducer(s, { type: 'pollOk', now: t0 + i * 10_000, behind: true });
      expect(s.watchKey).toBe(0);
    }
    s = liveReducer(s, { type: 'pollOk', now: t0 + 60_000, behind: true });
    expect(s.watchKey).toBe(1);
    // a poll that agrees with the watch resets the count
    s = run(
      [
        { type: 'pollOk', now: t0 + 80_000, behind: true },
        { type: 'pollOk', now: t0 + 90_000, behind: false },
        { type: 'pollOk', now: t0 + 100_000, behind: true },
      ],
      s
    );
    expect(s.watchKey).toBe(1);
  });

  it('ignores failures a remount cannot fix, and always remounts on refresh', () => {
    let s = run([{ type: 'pollFailed', now: t0, unreachable: false }]);
    expect(s).toEqual(initialLiveState);
    s = run(
      [
        { type: 'refresh', now: t0 },
        { type: 'refresh', now: t0 + 1 },
      ],
      s
    );
    expect(s.watchKey).toBe(2);
  });

  it('records when data last arrived', () => {
    expect(run([{ type: 'watchData', now: t0 }]).updatedAt).toBe(t0);
  });
});
