/*
 * K4allLive against fake watches and a fake API: the poll fills in what the
 * watch missed, the interval follows the upgrade phase, the watches are
 * remounted after an error, when they stay behind, and when the cluster
 * answers again.
 */

import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { clusterUpgrade, clusterUpgradeInProgress } from '../model/fixtures';
import { ClusterUpgradeObject } from '../model/types';
import { useClusterUpgrade, useK4allData } from './hooks';
import { K4allLive, useLiveStatus } from './live';

type Kind = 'cc' | 'rm' | 'nc' | 'nodes' | 'cu';

const store = vi.hoisted(() => ({
  watch: {} as Record<string, { items: unknown[] | null; error: unknown }>,
  mounts: {} as Record<string, number>,
  listeners: new Set<() => void>(),
  poll: {} as Record<string, () => Promise<unknown>>,
  requests: [] as string[],
}));

/** A fake useList for one kind: counts mounts, re-renders when the test changes the store. */
const makeUseList = vi.hoisted(() => (R: typeof import('react'), kind: string) => () => {
  const [, force] = R.useReducer((x: number) => x + 1, 0);
  R.useEffect(() => {
    store.mounts[kind] = (store.mounts[kind] ?? 0) + 1;
    store.listeners.add(force);
    return () => {
      store.listeners.delete(force);
    };
  }, []);
  const w = store.watch[kind] ?? { items: null, error: null };
  // A new array on every render, like a hook that does not memoize.
  return [w.items?.map(jsonData => ({ jsonData })) ?? null, w.error];
});

vi.mock('@kinvolk/headlamp-plugin/lib', async () => {
  const R = await vi.importActual<typeof import('react')>('react');
  return {
    ApiProxy: {
      request: (path: string) => {
        store.requests.push(path);
        if (path === '/apis/k4all.magesgate.com/v1alpha1') {
          return Promise.resolve({
            resources: ['clusterconfigs', 'releasemanifests', 'nodeconfigs', 'clusterupgrades'].map(
              name => ({ name })
            ),
          });
        }
        const handler = Object.entries(store.poll).find(([suffix]) => path.endsWith(suffix));
        return handler ? handler[1]() : Promise.resolve({ metadata: {}, items: [] });
      },
    },
    K8s: { ResourceClasses: { Node: { useList: makeUseList(R, 'nodes') } } },
    Utils: { getCluster: () => 'main' },
  };
});

vi.mock('./resources', async () => {
  const R = await vi.importActual<typeof import('react')>('react');
  return {
    ClusterConfig: { useList: makeUseList(R, 'cc') },
    ReleaseManifest: { useList: makeUseList(R, 'rm') },
    NodeConfig: { useList: makeUseList(R, 'nc') },
    ClusterUpgrade: { useList: makeUseList(R, 'cu') },
  };
});

function setWatch(kind: Kind, items: unknown[] | null, error: unknown = null) {
  store.watch[kind] = { items, error };
  act(() => store.listeners.forEach(l => l()));
}

function pollReturns(path: string, body: unknown) {
  store.poll[path] = () => Promise.resolve(body);
}

function pollFails(path: string, status: number) {
  store.poll[path] = () => Promise.reject(Object.assign(new Error('Bad Gateway'), { status }));
}

function withRV(cu: ClusterUpgradeObject, rv: string): ClusterUpgradeObject {
  return { ...cu, metadata: { ...cu.metadata, resourceVersion: rv } };
}

function Probe() {
  const { cu } = useClusterUpgrade();
  const data = useK4allData();
  const status = useLiveStatus();
  return (
    <div>
      <span data-testid="phase">{cu?.status?.phase ?? 'none'}</span>
      <span data-testid="nodes">{data.nodes.length}</span>
      <span data-testid="down">{status.down ? 'down' : 'up'}</span>
      <span data-testid="interval">{status.intervalMs}</span>
      <button onClick={status.refresh}>refresh</button>
    </div>
  );
}

const pollsOf = (suffix: string) => store.requests.filter(p => p.endsWith(suffix)).length;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount() {
  render(
    <K4allLive>
      <Probe />
    </K4allLive>
  );
  await advance(0); // discovery
}

beforeEach(() => {
  vi.useFakeTimers();
  store.watch = {};
  store.mounts = {};
  store.poll = {};
  store.requests = [];
  store.listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('K4allLive', () => {
  it('shows the poll copy when the watch missed an update', async () => {
    await mount();
    setWatch('cu', [withRV(clusterUpgradeInProgress(), '50')]);
    expect(screen.getByTestId('phase').textContent).toBe('Progressing');
    expect(screen.getByTestId('interval').textContent).toBe('10000');
    const done = withRV(clusterUpgrade(), '75');
    done.status!.phase = 'Succeeded';
    pollReturns('/clusterupgrades', { metadata: { resourceVersion: '80' }, items: [done] });
    await advance(10_000);
    expect(screen.getByTestId('phase').textContent).toBe('Succeeded');
  });

  it('keeps the watch copy when the poll is older', async () => {
    await mount();
    setWatch('cu', [withRV(clusterUpgradeInProgress(), '90')]);
    pollReturns('/clusterupgrades', {
      metadata: { resourceVersion: '60' },
      items: [withRV(clusterUpgrade(), '60')],
    });
    await advance(10_000);
    expect(screen.getByTestId('phase').textContent).toBe('Progressing');
  });

  it('polls every 60 s when no upgrade runs, every 10 s while one does', async () => {
    await mount();
    setWatch('cu', [withRV(clusterUpgrade(), '10')]);
    await advance(10_000);
    expect(pollsOf('/clusterupgrades')).toBe(0);
    await advance(50_000);
    expect(pollsOf('/clusterupgrades')).toBe(1);
    expect(pollsOf('/api/v1/nodes')).toBe(1);
    setWatch('cu', [withRV(clusterUpgradeInProgress(), '11')]);
    await advance(10_000);
    expect(pollsOf('/clusterupgrades')).toBe(2);
    await advance(10_000);
    expect(pollsOf('/clusterupgrades')).toBe(3);
  });

  it('remounts the watches after a watch error', async () => {
    await mount();
    setWatch('cu', [withRV(clusterUpgrade(), '10')]);
    expect(store.mounts.cu).toBe(1);
    setWatch('cu', null, { status: 503, message: 'Service Unavailable' });
    expect(store.mounts.cu).toBe(2);
    expect(store.mounts.nodes).toBe(2);
    // the last good copy stays on screen meanwhile
    expect(screen.getByTestId('phase').textContent).toBe('Idle');
  });

  it('does not remount for an error a new watch cannot fix', async () => {
    await mount();
    setWatch('cu', null, { status: 403, message: 'Forbidden' });
    expect(store.mounts.cu).toBe(1);
  });

  it('remounts a watch that stays behind the poll', async () => {
    await mount();
    setWatch('cu', [withRV(clusterUpgradeInProgress(), '50')]);
    pollReturns('/clusterupgrades', {
      metadata: { resourceVersion: '70' },
      items: [withRV(clusterUpgradeInProgress(), '70')],
    });
    await advance(10_000);
    expect(store.mounts.cu).toBe(1);
    await advance(10_000);
    expect(store.mounts.cu).toBe(2);
  });

  it('says when the cluster does not answer, and remounts when it answers again', async () => {
    await mount();
    setWatch('cu', [withRV(clusterUpgradeInProgress(), '50')]);
    pollFails('/clusterupgrades', 502);
    await advance(10_000);
    expect(screen.getByTestId('down').textContent).toBe('down');
    expect(screen.getByTestId('phase').textContent).toBe('Progressing'); // last known state
    pollReturns('/clusterupgrades', {
      metadata: { resourceVersion: '50' },
      items: [withRV(clusterUpgradeInProgress(), '50')],
    });
    await advance(10_000);
    expect(screen.getByTestId('down').textContent).toBe('up');
    expect(store.mounts.cu).toBe(2);
  });

  it('refreshes on demand: remount and an immediate poll', async () => {
    await mount();
    setWatch('cu', [withRV(clusterUpgrade(), '10')]);
    await act(async () => {
      screen.getByText('refresh').click();
    });
    await advance(0);
    expect(store.mounts.cu).toBe(2);
    expect(pollsOf('/clusterupgrades')).toBe(1);
  });

  it('fills the k4all data from the poll when no watch delivered', async () => {
    await mount();
    pollReturns('/api/v1/nodes', {
      metadata: { resourceVersion: '5' },
      items: [{ metadata: { name: 'cp-1', resourceVersion: '5' } }],
    });
    await advance(60_000);
    expect(screen.getByTestId('nodes').textContent).toBe('1');
  });
});
