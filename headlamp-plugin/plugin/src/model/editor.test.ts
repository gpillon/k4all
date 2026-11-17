import { editorReducer, EditorState, initialEditorState, isBaseStale, isDirty } from './editor';
import { defaultClusterConfig } from './fixtures';
import { setIn } from './objects';
import { setTraefik } from './settings';
import { ClusterConfigObject } from './types';

function withGeneration(
  obj: ClusterConfigObject,
  generation: number,
  spec = obj.spec
): ClusterConfigObject {
  return { ...obj, metadata: { ...obj.metadata, generation }, spec };
}

function loaded(): EditorState {
  return editorReducer(initialEditorState, { type: 'server', object: defaultClusterConfig() });
}

describe('editorReducer', () => {
  it('starts clean from the first server object', () => {
    const state = loaded();
    expect(isDirty(state)).toBe(false);
    expect(state.draft).toEqual(defaultClusterConfig().spec);
  });

  it('ignores edits before anything is loaded', () => {
    const state = editorReducer(initialEditorState, {
      type: 'edit',
      update: d => setTraefik(d, { isDefault: false }),
    });
    expect(state).toBe(initialEditorState);
  });

  it('becomes dirty on edit and clean again when the edit is undone', () => {
    let state = editorReducer(loaded(), {
      type: 'edit',
      update: d => setIn(d, ['features', 'argocd', 'enabled'], true),
    });
    expect(isDirty(state)).toBe(true);
    state = editorReducer(state, {
      type: 'edit',
      update: d => setIn(d, ['features', 'argocd', 'enabled'], false),
    });
    expect(isDirty(state)).toBe(false);
  });

  it('follows the server while clean', () => {
    const newer = withGeneration(
      defaultClusterConfig(),
      4,
      setIn(defaultClusterConfig().spec!, ['proxy', 'noProxy'], '.lan')
    );
    const state = editorReducer(loaded(), { type: 'server', object: newer });
    expect(state.base).toBe(newer);
    expect(state.draft.proxy?.noProxy).toBe('.lan');
    expect(isBaseStale(state)).toBe(false);
  });

  it('keeps the draft and its base when the server changes during an edit', () => {
    let state = editorReducer(loaded(), {
      type: 'edit',
      update: d => setIn(d, ['features', 'virt', 'enabled'], true),
    });
    const newer = withGeneration(defaultClusterConfig(), 4);
    state = editorReducer(state, { type: 'server', object: newer });
    expect(state.draft.features?.virt?.enabled).toBe(true);
    expect(state.base?.metadata.generation).toBe(3);
    expect(state.latest).toBe(newer);
    expect(isBaseStale(state)).toBe(true);
  });

  it('does not treat status-only updates as a newer spec', () => {
    let state = editorReducer(loaded(), {
      type: 'edit',
      update: d => setIn(d, ['features', 'virt', 'enabled'], true),
    });
    const statusOnly = {
      ...defaultClusterConfig(),
      status: { observedGeneration: 3, lastReconcileTime: '2026-11-17T10:05:00Z' },
    };
    state = editorReducer(state, { type: 'server', object: statusOnly });
    expect(isBaseStale(state)).toBe(false);
  });

  it('discards the draft on reset, adopting the latest object', () => {
    let state = editorReducer(loaded(), {
      type: 'edit',
      update: d => setIn(d, ['features', 'virt', 'enabled'], true),
    });
    state = editorReducer(state, {
      type: 'server',
      object: withGeneration(defaultClusterConfig(), 5),
    });
    state = editorReducer(state, { type: 'reset' });
    expect(isDirty(state)).toBe(false);
    expect(state.base?.metadata.generation).toBe(5);
  });

  it('adopts the saved object, unless the watch already delivered a newer one', () => {
    let state = editorReducer(loaded(), {
      type: 'edit',
      update: d => setIn(d, ['features', 'virt', 'enabled'], true),
    });
    const saved = withGeneration(defaultClusterConfig(), 4, state.draft);
    state = editorReducer(state, {
      type: 'server',
      object: withGeneration(defaultClusterConfig(), 5),
    });
    state = editorReducer(state, { type: 'saved', object: saved });
    expect(state.base).toBe(saved);
    expect(state.latest?.metadata.generation).toBe(5);
    expect(isDirty(state)).toBe(false);
  });

  it('moves the base forward after a rebase', () => {
    const theirs = withGeneration(defaultClusterConfig(), 6);
    const draft = setIn(theirs.spec!, ['features', 'virt', 'enabled'], true);
    const state = editorReducer(loaded(), { type: 'rebased', base: theirs, draft });
    expect(state.base).toBe(theirs);
    expect(isDirty(state)).toBe(true);
  });
});
