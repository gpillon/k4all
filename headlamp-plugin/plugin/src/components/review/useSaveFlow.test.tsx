/*
 * The save flow against a fake API: dry run, apply, conflict rebase, and
 * results that arrive after the user closed the dialog.
 */

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { getClusterConfig, patchClusterConfig } from '../../api/k4allApi';
import { editorReducer, initialEditorState } from '../../model/editor';
import { defaultClusterConfig, releaseManifest } from '../../model/fixtures';
import { setIn } from '../../model/objects';
import { applyOps, JsonPatchOp } from '../../model/patch';
import { ClusterConfigObject } from '../../model/types';
import { useSaveFlow } from './useSaveFlow';

vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
vi.mock('../../api/k4allApi', () => ({ patchClusterConfig: vi.fn(), getClusterConfig: vi.fn() }));

const patchMock = vi.mocked(patchClusterConfig);
const getMock = vi.mocked(getClusterConfig);

/** A fake API server holding one ClusterConfig, applying patches like the real one. */
function fakeServer(initial: ClusterConfigObject) {
  let stored = initial;
  patchMock.mockImplementation(async (_name: string, ops: JsonPatchOp[], dryRun: boolean) => {
    let next: ClusterConfigObject;
    try {
      next = applyOps(stored, ops);
    } catch (err) {
      throw Object.assign(
        new Error(`Unprocessable Entity - ${(err as Error).message}: test failed`),
        {
          status: 422,
        }
      );
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
    set: (obj: ClusterConfigObject) => {
      stored = obj;
    },
  };
}

function useHarness() {
  const [state, dispatch] = React.useReducer(editorReducer, initialEditorState);
  const flow = useSaveFlow(state, dispatch, releaseManifest().spec!.components!);
  return { state, dispatch, flow };
}

function setup(cc = defaultClusterConfig()) {
  const hook = renderHook(() => useHarness());
  act(() => hook.result.current.dispatch({ type: 'server', object: cc }));
  return hook;
}

beforeEach(() => {
  patchMock.mockReset();
  getMock.mockReset();
});

describe('useSaveFlow', () => {
  it('dry-runs, reviews and applies a change', async () => {
    const server = fakeServer(defaultClusterConfig());
    const hook = setup();
    act(() =>
      hook.result.current.dispatch({
        type: 'edit',
        update: d => setIn(d, ['features', 'argocd', 'enabled'], true),
      })
    );
    await act(async () => hook.result.current.flow.review());
    const phase = hook.result.current.flow.phase;
    expect(phase.kind).toBe('review');
    expect(patchMock).toHaveBeenLastCalledWith('k4all-cluster-config', expect.any(Array), true);
    expect(server.get().spec?.features?.argocd?.enabled).toBe(false); // dry run only

    await act(async () => hook.result.current.flow.apply());
    expect(hook.result.current.flow.phase.kind).toBe('idle');
    expect(server.get().spec?.features?.argocd?.enabled).toBe(true);
    expect(hook.result.current.state.base?.metadata.generation).toBe(4);
  });

  it('replays the draft on a newer version when the changes do not overlap', async () => {
    const server = fakeServer(defaultClusterConfig());
    const hook = setup();
    act(() =>
      hook.result.current.dispatch({
        type: 'edit',
        update: d => setIn(d, ['features', 'argocd', 'enabled'], true),
      })
    );
    // Someone else saves another field meanwhile.
    const theirs = defaultClusterConfig();
    theirs.metadata.generation = 9;
    theirs.spec = setIn(theirs.spec!, ['ingress', 'cilium', 'dedicatedIP'], '192.168.1.50');
    server.set(theirs);

    await act(async () => hook.result.current.flow.review());
    const phase = hook.result.current.flow.phase;
    expect(phase.kind).toBe('review');
    if (phase.kind === 'review') {
      expect(phase.data.rebasedFrom).toBe(3);
      expect(phase.data.base.metadata.generation).toBe(9);
      expect(phase.data.result.spec?.ingress?.cilium?.dedicatedIP).toBe('192.168.1.50');
      expect(phase.data.result.spec?.features?.argocd?.enabled).toBe(true);
    }
  });

  it('asks the user when both sides changed the same field, then keeps their choice', async () => {
    const server = fakeServer(defaultClusterConfig());
    const hook = setup();
    act(() =>
      hook.result.current.dispatch({
        type: 'edit',
        update: d => setIn(d, ['features', 'virt', 'emulation'], 'false'),
      })
    );
    const theirs = defaultClusterConfig();
    theirs.metadata.generation = 12;
    theirs.spec = setIn(theirs.spec!, ['features', 'virt', 'emulation'], 'true');
    server.set(theirs);

    await act(async () => hook.result.current.flow.review());
    const phase = hook.result.current.flow.phase;
    expect(phase.kind).toBe('conflict');
    if (phase.kind === 'conflict') {
      expect(phase.result.conflicts).toEqual([
        expect.objectContaining({
          label: 'features.virt.emulation',
          base: 'auto',
          theirs: 'true',
          mine: 'false',
        }),
      ]);
    }

    await act(async () => hook.result.current.flow.resolve('mine'));
    const resolved = hook.result.current.flow.phase;
    expect(resolved.kind).toBe('review');
    if (resolved.kind === 'review') {
      expect(resolved.data.ops[0]).toEqual({ op: 'test', path: '/metadata/generation', value: 12 });
      expect(resolved.data.result.spec?.features?.virt?.emulation).toBe('false');
    }
  });

  it('drops a dry-run result that arrives after the dialog was closed', async () => {
    fakeServer(defaultClusterConfig());
    let release: (v: ClusterConfigObject) => void = () => undefined;
    patchMock.mockImplementationOnce(() => new Promise<ClusterConfigObject>(r => (release = r)));
    const hook = setup();
    act(() =>
      hook.result.current.dispatch({
        type: 'edit',
        update: d => setIn(d, ['features', 'argocd', 'enabled'], true),
      })
    );
    act(() => hook.result.current.flow.review());
    expect(hook.result.current.flow.phase.kind).toBe('dryRun');
    act(() => hook.result.current.flow.close());
    await act(async () => release(defaultClusterConfig()));
    expect(hook.result.current.flow.phase.kind).toBe('idle');
  });

  it('shows API errors with a retry', async () => {
    patchMock.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const hook = setup();
    act(() =>
      hook.result.current.dispatch({
        type: 'edit',
        update: d => setIn(d, ['features', 'argocd', 'enabled'], true),
      })
    );
    await act(async () => hook.result.current.flow.review());
    const phase = hook.result.current.flow.phase;
    expect(phase.kind).toBe('error');
    if (phase.kind === 'error') {
      expect(phase.error.kind).toBe('forbidden');
    }
  });
});
