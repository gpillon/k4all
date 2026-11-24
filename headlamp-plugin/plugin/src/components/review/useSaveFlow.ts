/*
 * The save flow shared by the settings page and the component overrides:
 *
 *   draft --dry run--> review --apply--> saved
 *              |                  |
 *              +---- conflict ----+--> rebase: clean -> review again
 *                                      overlapping -> user picks a side -> review again
 */

import { useSnackbar } from 'notistack';
import React from 'react';
import { getClusterConfig, patchClusterConfig } from '../../api/k4allApi';
import { Capabilities } from '../../model/capabilities';
import {
  Adjustment,
  ChangeContext,
  ChangeItem,
  describeChanges,
  reappliedComponents,
  serverAdjustments,
} from '../../model/changes';
import { EditorAction, EditorState } from '../../model/editor';
import { ClassifiedError, classifyError } from '../../model/errors';
import { JsonObject } from '../../model/objects';
import { buildSpecPatch, JsonPatchOp } from '../../model/patch';
import { rebase, RebaseResult, resolveConflicts } from '../../model/rebase';
import { Draft } from '../../model/settings';
import { ClusterConfigObject, ComponentSpec } from '../../model/types';

export interface ReviewData {
  base: ClusterConfigObject;
  draft: Draft;
  ops: JsonPatchOp[];
  result: ClusterConfigObject;
  items: ChangeItem[];
  adjustments: Adjustment[];
  /** Installed components the operator applies again because of this change. */
  reapplied: string[];
  /** Set when the draft was replayed on a newer server version. */
  rebasedFrom?: number;
}

export type SavePhase =
  | { kind: 'idle' }
  | { kind: 'dryRun' }
  | { kind: 'review'; data: ReviewData }
  | { kind: 'applying'; data: ReviewData }
  | {
      kind: 'conflict';
      result: RebaseResult;
      theirs: ClusterConfigObject;
      draft: Draft;
      fromGeneration?: number;
    }
  | { kind: 'error'; error: ClassifiedError; retry: () => void };

export interface SaveFlow {
  phase: SavePhase;
  /** Dry-runs the current draft and opens the review. */
  review: (draft?: Draft) => void;
  apply: () => void;
  resolve: (keep: 'mine' | 'theirs') => void;
  close: () => void;
}

export function useSaveFlow(
  state: EditorState,
  dispatch: React.Dispatch<EditorAction>,
  components: Record<string, ComponentSpec>,
  /** What the installed k4all-operator can do, for what the changes do. */
  caps?: Capabilities,
  /** Cluster state for the change texts (what cleared kubelet fields go back to). */
  changeCtx?: ChangeContext
): SaveFlow {
  const [phase, setPhaseState] = React.useState<SavePhase>({ kind: 'idle' });
  const { enqueueSnackbar } = useSnackbar();
  // Each review attempt gets a number; close() moves it on, so results that
  // arrive after the user dismissed the dialog are dropped.
  const session = React.useRef(0);
  const live = (id: number) => id === session.current;
  const setPhase = (id: number, next: SavePhase) => {
    if (live(id)) {
      setPhaseState(next);
    }
  };

  const dryRun = async (
    id: number,
    base: ClusterConfigObject,
    draft: Draft,
    rebasedFrom?: number
  ): Promise<void> => {
    setPhase(id, { kind: 'dryRun' });
    const ops = buildSpecPatch(base, draft);
    if (ops.length === 0) {
      setPhase(id, { kind: 'idle' });
      enqueueSnackbar('Nothing to save: the settings are unchanged.', { variant: 'info' });
      return;
    }
    try {
      const result = await patchClusterConfig(base.metadata.name, ops, true);
      setPhase(id, {
        kind: 'review',
        data: {
          base,
          draft,
          ops,
          result,
          items: describeChanges(base.spec ?? {}, draft, components, caps, changeCtx),
          adjustments: serverAdjustments(draft, result.spec),
          reapplied: reappliedComponents(base.spec ?? {}, draft, components),
          rebasedFrom,
        },
      });
    } catch (err) {
      await onError(id, err, base, draft);
    }
  };

  const start = (base: ClusterConfigObject, draft: Draft, rebasedFrom?: number) => {
    session.current += 1;
    return dryRun(session.current, base, draft, rebasedFrom);
  };

  const onError = async (
    id: number,
    err: unknown,
    base: ClusterConfigObject,
    draft: Draft
  ): Promise<void> => {
    const classified = classifyError(err);
    if (classified.kind !== 'conflict') {
      setPhase(id, { kind: 'error', error: classified, retry: () => start(base, draft) });
      return;
    }
    let theirs: ClusterConfigObject;
    try {
      theirs = await getClusterConfig(base.metadata.name);
    } catch (fetchErr) {
      setPhase(id, {
        kind: 'error',
        error: classifyError(fetchErr),
        retry: () => start(base, draft),
      });
      return;
    }
    if (!live(id)) {
      return;
    }
    const result = rebase(
      (base.spec ?? {}) as JsonObject,
      draft as JsonObject,
      (theirs.spec ?? {}) as JsonObject
    );
    if (result.conflicts.length === 0) {
      dispatch({ type: 'rebased', base: theirs, draft: result.merged as Draft });
      await dryRun(id, theirs, result.merged as Draft, base.metadata.generation);
      return;
    }
    setPhase(id, {
      kind: 'conflict',
      result,
      theirs,
      draft,
      fromGeneration: base.metadata.generation,
    });
  };

  const review = (draft?: Draft) => {
    if (state.base) {
      start(state.base, draft ?? state.draft);
    }
  };

  const apply = async () => {
    if (phase.kind !== 'review') {
      return;
    }
    const id = session.current;
    const data = phase.data;
    setPhase(id, { kind: 'applying', data });
    try {
      const saved = await patchClusterConfig(data.base.metadata.name, data.ops, false);
      // The write happened: record it even if the dialog is gone.
      dispatch({ type: 'saved', object: saved });
      setPhase(id, { kind: 'idle' });
      enqueueSnackbar('Settings saved. k4all-operator is applying them.', { variant: 'success' });
    } catch (err) {
      await onError(id, err, data.base, data.draft);
    }
  };

  const resolve = (keep: 'mine' | 'theirs') => {
    if (phase.kind !== 'conflict') {
      return;
    }
    const draft = resolveConflicts(phase.result, keep) as Draft;
    dispatch({ type: 'rebased', base: phase.theirs, draft });
    start(phase.theirs, draft, phase.fromGeneration);
  };

  const close = () => {
    session.current += 1;
    setPhaseState({ kind: 'idle' });
  };

  return { phase, review, apply, resolve, close };
}
