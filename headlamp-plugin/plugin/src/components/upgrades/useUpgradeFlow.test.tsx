/*
 * The ClusterUpgrade write flow against a fake API server: dry run, review,
 * apply; a conflict rebuilt from the same intent; actions with one retry on
 * conflict; the retry annotation; late results after closing.
 */

import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import {
  addClusterUpgradeApproval,
  checkClusterUpgradeReadiness,
  getClusterUpgrade,
  patchClusterUpgrade,
  restoreRemediation,
  retryClusterUpgrade,
} from '../../api/k4allApi';
import {
  clusterUpgrade,
  clusterUpgradeBlocked,
  clusterUpgradeInProgress,
  clusterUpgradeWithReadiness,
  cnpgFinding,
} from '../../model/fixtures';
import { applyOps, JsonPatchOp } from '../../model/patch';
import { ClusterUpgradeObject } from '../../model/types';
import { useUpgradeFlow } from './useUpgradeFlow';

const snackbar = vi.fn();
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: snackbar }) }));
vi.mock('../../api/k4allApi', () => ({
  patchClusterUpgrade: vi.fn(),
  getClusterUpgrade: vi.fn(),
  retryClusterUpgrade: vi.fn(),
  checkClusterUpgradeReadiness: vi.fn(async () => ({})),
  restoreRemediation: vi.fn(async () => ({})),
  addClusterUpgradeApproval: vi.fn(async () => ({})),
}));

const patchMock = vi.mocked(patchClusterUpgrade);
const getMock = vi.mocked(getClusterUpgrade);
const retryMock = vi.mocked(retryClusterUpgrade);

function fakeServer(initial: ClusterUpgradeObject) {
  let stored = initial;
  patchMock.mockImplementation(async (ops: JsonPatchOp[], dryRun: boolean) => {
    let next: ClusterUpgradeObject;
    try {
      next = applyOps(stored, ops);
    } catch (err) {
      throw Object.assign(new Error(`Unprocessable Entity - ${(err as Error).message}`), {
        status: 422,
      });
    }
    next = {
      ...next,
      metadata: { ...next.metadata, generation: (stored.metadata.generation ?? 0) + 1 },
    };
    if (!dryRun) {
      stored = next;
    }
    return next;
  });
  getMock.mockImplementation(async () => stored);
  return {
    get: () => stored,
    set: (cu: ClusterUpgradeObject) => {
      stored = cu;
    },
  };
}

beforeEach(() => {
  patchMock.mockReset();
  getMock.mockReset();
  retryMock.mockReset();
  snackbar.mockReset();
});

describe('useUpgradeFlow', () => {
  it('dry-runs a target, reviews it and applies it', async () => {
    const server = fakeServer(clusterUpgrade());
    const hook = renderHook(() => useUpgradeFlow(server.get()));
    await act(async () => hook.result.current.review({ kind: 'start', target: 'v2.7.0' }));
    const phase = hook.result.current.phase;
    expect(phase.kind).toBe('review');
    if (phase.kind !== 'review') {
      return;
    }
    expect(patchMock).toHaveBeenLastCalledWith(expect.any(Array), true);
    expect(phase.data.result.spec?.targetRelease).toBe('v2.7.0');
    expect(phase.data.items[0]).toMatchObject({ key: 'spec.targetRelease', to: 'v2.7.0' });
    expect(server.get().spec?.targetRelease).toBeUndefined(); // dry run only

    await act(async () => hook.result.current.apply());
    expect(hook.result.current.phase.kind).toBe('idle');
    expect(server.get().spec?.targetRelease).toBe('v2.7.0');
    expect(snackbar).toHaveBeenLastCalledWith(
      expect.stringMatching(/Upgrade to v2.7.0 requested/),
      {
        variant: 'success',
      }
    );
  });

  it('rebuilds the review on the newer object when someone changed it meanwhile', async () => {
    const server = fakeServer(clusterUpgrade());
    const hook = renderHook(() => useUpgradeFlow(server.get()));
    await act(async () => hook.result.current.review({ kind: 'start', target: 'v2.7.0' }));
    // Someone else changes the drain timeout before Apply.
    server.set({
      ...server.get(),
      metadata: { ...server.get().metadata, generation: 5 },
      spec: { drain: { timeoutMinutes: 60 } },
    });
    await act(async () => hook.result.current.apply());
    const phase = hook.result.current.phase;
    expect(phase.kind).toBe('review');
    if (phase.kind === 'review') {
      expect(phase.data.changedMeanwhile).toBe(true);
      expect(phase.data.base.metadata.generation).toBe(5);
      expect(phase.data.result.spec).toEqual({
        targetRelease: 'v2.7.0',
        drain: { timeoutMinutes: 60 },
      });
    }
    expect(server.get().spec?.targetRelease).toBeUndefined();
  });

  it('says so when there is nothing to change', async () => {
    const cu = clusterUpgradeInProgress();
    const server = fakeServer(cu);
    const hook = renderHook(() => useUpgradeFlow(server.get()));
    await act(async () => hook.result.current.review({ kind: 'start', target: 'v2.6.0' }));
    expect(hook.result.current.phase.kind).toBe('idle');
    expect(patchMock).not.toHaveBeenCalled();
    expect(snackbar).toHaveBeenCalledWith('Nothing to change.', { variant: 'info' });
  });

  it('shows API errors with a way to try again', async () => {
    fakeServer(clusterUpgrade());
    patchMock.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    const hook = renderHook(() => useUpgradeFlow(clusterUpgrade()));
    await act(async () => hook.result.current.review({ kind: 'start', target: 'v2.5.0' }));
    const phase = hook.result.current.phase;
    expect(phase.kind).toBe('error');
    if (phase.kind === 'error') {
      expect(phase.error.kind).toBe('forbidden');
    }
  });

  it('drops a dry-run result that arrives after the dialog was closed', async () => {
    const server = fakeServer(clusterUpgrade());
    let release: () => void = () => undefined;
    patchMock.mockImplementationOnce(
      (ops: JsonPatchOp[]) =>
        new Promise(resolve => {
          release = () => resolve(applyOps(server.get(), ops));
        })
    );
    const hook = renderHook(() => useUpgradeFlow(server.get()));
    act(() => hook.result.current.review({ kind: 'start', target: 'v2.5.0' }));
    expect(hook.result.current.phase.kind).toBe('dryRun');
    act(() => hook.result.current.close());
    await act(async () => release());
    expect(hook.result.current.phase.kind).toBe('idle');
  });

  it('pauses at once and retries once on a conflict', async () => {
    const server = fakeServer(clusterUpgradeInProgress());
    const stale = server.get();
    // The operator's watch is behind: someone already bumped the generation.
    server.set({ ...stale, metadata: { ...stale.metadata, generation: 7 } });
    const hook = renderHook(() => useUpgradeFlow(stale));
    let ok = false;
    await act(async () => {
      ok = await hook.result.current.act({ kind: 'pause' });
    });
    expect(ok).toBe(true);
    expect(patchMock).toHaveBeenCalledTimes(2);
    expect(server.get().spec?.paused).toBe(true);
    expect(hook.result.current.busy).toBeNull();
  });

  it('stops by clearing the target', async () => {
    const server = fakeServer(clusterUpgradeInProgress());
    const hook = renderHook(() => useUpgradeFlow(server.get()));
    await act(async () => {
      await hook.result.current.act({ kind: 'stop' });
    });
    expect(server.get().spec).toEqual({ drain: { timeoutMinutes: 30 } });
  });

  it('asks for a retry through the annotation', async () => {
    retryMock.mockResolvedValue(clusterUpgrade());
    const hook = renderHook(() => useUpgradeFlow(clusterUpgrade()));
    await act(async () => {
      await hook.result.current.retry();
    });
    expect(retryMock).toHaveBeenCalled();
    expect(snackbar).toHaveBeenLastCalledWith(expect.stringMatching(/Retry requested/), {
      variant: 'success',
    });
  });

  it('Apply fix adds one approval for the target release', async () => {
    const approve = vi.mocked(addClusterUpgradeApproval);
    approve.mockClear();
    const hook = renderHook(() => useUpgradeFlow(clusterUpgradeBlocked()));
    const f = cnpgFinding();
    await act(async () => {
      await hook.result.current.approve({
        remediation: 'cnpg-disable-pdb',
        target: f.object,
        decision: 'Apply',
      });
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith({
      remediation: 'cnpg-disable-pdb',
      target: f.object,
      decision: 'Apply',
      release: 'v2.6.0',
    });
    expect(snackbar).toHaveBeenLastCalledWith(expect.stringMatching(/^Approved: /), {
      variant: 'success',
    });
  });

  it('writes no approval without a running upgrade', async () => {
    const approve = vi.mocked(addClusterUpgradeApproval);
    approve.mockClear();
    const hook = renderHook(() => useUpgradeFlow(clusterUpgradeWithReadiness()));
    await act(async () => {
      await hook.result.current.approve({
        remediation: 'cnpg-disable-pdb',
        target: cnpgFinding().object,
        decision: 'Apply',
      });
    });
    expect(approve).not.toHaveBeenCalled();
  });

  it('shows checking from Check again until the report changes', async () => {
    const check = vi.mocked(checkClusterUpgradeReadiness);
    let cu = clusterUpgradeWithReadiness();
    const hook = renderHook(() => useUpgradeFlow(cu));
    expect(hook.result.current.checking).toBe(false);
    await act(async () => {
      await hook.result.current.checkReadiness();
    });
    expect(check).toHaveBeenCalled();
    expect(hook.result.current.checking).toBe(true);
    // the watch brings the object with the annotation, then the new report
    cu = {
      ...cu,
      metadata: {
        ...cu.metadata,
        annotations: { 'k4all.magesgate.com/check-readiness': 'now' },
      },
    };
    hook.rerender();
    expect(hook.result.current.checking).toBe(true);
    cu = clusterUpgradeWithReadiness();
    cu.status!.readiness!.checkedAt = '2026-11-17T09:05:00Z';
    hook.rerender();
    expect(hook.result.current.checking).toBe(false);
  });

  it('puts a record back with its id', async () => {
    const restore = vi.mocked(restoreRemediation);
    const hook = renderHook(() => useUpgradeFlow(clusterUpgradeBlocked()));
    await act(async () => {
      await hook.result.current.restore('rm-4c1f9a');
    });
    expect(restore).toHaveBeenCalledWith('rm-4c1f9a');
  });
});
