/*
 * State of a ClusterConfig edit session, as a reducer:
 *
 * - base   the object the draft started from (what the patch is computed against)
 * - latest the newest object seen from the watch
 * - draft  the user's spec
 *
 * While the draft is clean it follows the server. Once the user edits, server
 * updates only move `latest`; the save path then rebases (rebase.ts).
 */

import { clone, jsonEqual } from './objects';
import { Draft } from './settings';
import { ClusterConfigObject } from './types';

export interface EditorState {
  base: ClusterConfigObject | null;
  latest: ClusterConfigObject | null;
  draft: Draft;
}

export type EditorAction =
  | { type: 'server'; object: ClusterConfigObject | null }
  | { type: 'edit'; update: (draft: Draft) => Draft }
  | { type: 'reset' }
  | { type: 'saved'; object: ClusterConfigObject }
  | { type: 'rebased'; base: ClusterConfigObject; draft: Draft };

export const initialEditorState: EditorState = { base: null, latest: null, draft: {} };

export function isDirty(state: EditorState): boolean {
  return !!state.base && !jsonEqual(state.base.spec ?? {}, state.draft);
}

/** The server has a newer spec than the one the draft started from. */
export function isBaseStale(state: EditorState): boolean {
  const b = state.base?.metadata;
  const l = state.latest?.metadata;
  if (!b || !l) {
    return false;
  }
  if (b.generation !== undefined && l.generation !== undefined) {
    return l.generation > b.generation;
  }
  return !jsonEqual(state.base?.spec, state.latest?.spec);
}

function generationOf(obj: ClusterConfigObject | null): number {
  return obj?.metadata.generation ?? -1;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'server': {
      if (!action.object) {
        return { ...state, latest: null };
      }
      if (!state.base || !isDirty(state)) {
        return {
          base: action.object,
          latest: action.object,
          draft: clone(action.object.spec ?? {}),
        };
      }
      return { ...state, latest: action.object };
    }
    case 'edit':
      if (!state.base) {
        return state;
      }
      return { ...state, draft: action.update(state.draft) };
    case 'reset':
      if (!state.latest) {
        return state;
      }
      return { base: state.latest, latest: state.latest, draft: clone(state.latest.spec ?? {}) };
    case 'saved': {
      // A watch event may already have delivered something newer.
      const latest =
        generationOf(state.latest) > generationOf(action.object) ? state.latest : action.object;
      return { base: action.object, latest, draft: clone(action.object.spec ?? {}) };
    }
    case 'rebased':
      return { ...state, base: action.base, draft: action.draft };
  }
  return state;
}
