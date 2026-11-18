/*
 * Writes to the ClusterUpgrade "k4all", with the same machinery as the
 * settings: a JSON Patch guarded by metadata.generation, fieldManager
 * k4all-headlamp, strict field validation.
 *
 *   start / settings:  dry run --> review --apply--> saved
 *                                     |
 *                                     +-- conflict: re-read, rebuild the patch from the
 *                                         same intent, dry run again, review again
 *   pause / resume / stop: applied at once; a conflict is retried once on the newer object
 *   retry: the retry annotation (merge patch on that key)
 *
 * The patch is rebuilt from the user's intent ("target v2.7.0") instead of
 * rebasing a draft: the intent is what the user confirmed, and the review
 * shows again when the object changed underneath it.
 */

import { useSnackbar } from 'notistack';
import React from 'react';
import { getClusterUpgrade, patchClusterUpgrade, retryClusterUpgrade } from '../../api/k4allApi';
import { ChangeItem } from '../../model/changes';
import { ClassifiedError, classifyError } from '../../model/errors';
import { JsonPatchOp } from '../../model/patch';
import { ClusterUpgradeObject, ClusterUpgradeSpec } from '../../model/types';
import {
  describeUpgradeChanges,
  desiredSpec,
  intentOps,
  UpgradeIntent,
} from '../../model/upgrades';

export type ReviewIntent = Extract<UpgradeIntent, { kind: 'start' | 'settings' }>;
export type ActionIntent = Extract<UpgradeIntent, { kind: 'pause' | 'resume' | 'stop' }>;

export interface UpgradeReviewData {
  intent: ReviewIntent;
  base: ClusterUpgradeObject;
  desired: ClusterUpgradeSpec;
  ops: JsonPatchOp[];
  /** The object the API server would store (dry run). */
  result: ClusterUpgradeObject;
  items: ChangeItem[];
  /** The ClusterUpgrade changed after the user chose; the review was rebuilt on the newer one. */
  changedMeanwhile?: boolean;
}

export type UpgradeFlowPhase =
  | { kind: 'idle' }
  | { kind: 'dryRun'; intent: ReviewIntent }
  | { kind: 'review'; data: UpgradeReviewData }
  | { kind: 'applying'; data: UpgradeReviewData }
  | { kind: 'error'; intent: ReviewIntent; error: ClassifiedError; retry: () => void };

export interface UpgradeFlow {
  phase: UpgradeFlowPhase;
  /** Dry-runs a start or settings change and opens the review. */
  review: (intent: ReviewIntent) => void;
  apply: () => void;
  close: () => void;
  /** Pause, resume or stop. Resolves true when written. */
  act: (intent: ActionIntent) => Promise<boolean>;
  /** Sets the retry annotation. Resolves true when written. */
  retry: () => Promise<boolean>;
  /** The action in flight, to disable its button. */
  busy: ActionIntent['kind'] | 'retry' | null;
}

/** How many times a conflict is rebuilt on a newer object before giving up. */
const MAX_CONFLICT_REBUILDS = 2;

const ACTION_DONE: Record<ActionIntent['kind'], string> = {
  pause: 'Upgrade paused: no new node starts its hop.',
  resume: 'Upgrade resumed.',
  stop: 'Upgrade stopped: it ends after the node in progress.',
};

export function useUpgradeFlow(cu: ClusterUpgradeObject | null): UpgradeFlow {
  const [phase, setPhaseState] = React.useState<UpgradeFlowPhase>({ kind: 'idle' });
  const [busy, setBusy] = React.useState<UpgradeFlow['busy']>(null);
  const { enqueueSnackbar } = useSnackbar();
  // Like the settings flow: close() moves the session on, so late results are dropped.
  const session = React.useRef(0);
  // The newest watched object, for a "Try again" started from an older render.
  const latestCu = React.useRef(cu);
  latestCu.current = cu;
  const setPhase = (id: number, next: UpgradeFlowPhase) => {
    if (id === session.current) {
      setPhaseState(next);
    }
  };

  const dryRun = async (
    id: number,
    base: ClusterUpgradeObject,
    intent: ReviewIntent,
    conflicts = 0
  ): Promise<void> => {
    setPhase(id, { kind: 'dryRun', intent });
    const ops = intentOps(base, intent);
    if (ops.length === 0) {
      setPhase(id, { kind: 'idle' });
      enqueueSnackbar('Nothing to change.', { variant: 'info' });
      return;
    }
    try {
      const result = await patchClusterUpgrade(ops, true);
      const desired = desiredSpec(base, intent);
      setPhase(id, {
        kind: 'review',
        data: {
          intent,
          base,
          desired,
          ops,
          result,
          items: describeUpgradeChanges(base.spec ?? {}, desired),
          changedMeanwhile: conflicts > 0,
        },
      });
    } catch (err) {
      await onError(id, err, intent, conflicts);
    }
  };

  const onError = async (
    id: number,
    err: unknown,
    intent: ReviewIntent,
    conflicts = 0
  ): Promise<void> => {
    const classified = classifyError(err);
    const restart = () => start(intent);
    // A conflict is rebuilt on the newest object; one that keeps coming back
    // (someone writing in a loop) ends as an error instead of a loop.
    if (classified.kind !== 'conflict' || conflicts >= MAX_CONFLICT_REBUILDS) {
      setPhase(id, { kind: 'error', intent, error: classified, retry: restart });
      return;
    }
    let latest: ClusterUpgradeObject;
    try {
      latest = await getClusterUpgrade();
    } catch (fetchErr) {
      setPhase(id, { kind: 'error', intent, error: classifyError(fetchErr), retry: restart });
      return;
    }
    if (id === session.current) {
      await dryRun(id, latest, intent, conflicts + 1);
    }
  };

  const start = (intent: ReviewIntent) => {
    const base = latestCu.current;
    if (!base) {
      return;
    }
    session.current += 1;
    dryRun(session.current, base, intent);
  };

  const review = (intent: ReviewIntent) => start(intent);

  const apply = async () => {
    if (phase.kind !== 'review') {
      return;
    }
    const id = session.current;
    const data = phase.data;
    setPhase(id, { kind: 'applying', data });
    try {
      await patchClusterUpgrade(data.ops, false);
      setPhase(id, { kind: 'idle' });
      enqueueSnackbar(
        data.intent.kind === 'start'
          ? `Upgrade to ${data.desired.targetRelease} requested. k4all-operator takes it from here.`
          : 'Upgrade settings saved.',
        { variant: 'success' }
      );
    } catch (err) {
      await onError(id, err, data.intent);
    }
  };

  const close = () => {
    session.current += 1;
    setPhaseState({ kind: 'idle' });
  };

  const act = async (intent: ActionIntent): Promise<boolean> => {
    if (!latestCu.current) {
      return false;
    }
    setBusy(intent.kind);
    try {
      let base = latestCu.current;
      for (let attempt = 0; ; attempt++) {
        const ops = intentOps(base, intent);
        if (ops.length === 0) {
          return true;
        }
        try {
          await patchClusterUpgrade(ops, false);
          enqueueSnackbar(ACTION_DONE[intent.kind], { variant: 'success' });
          return true;
        } catch (err) {
          const classified = classifyError(err);
          if (classified.kind === 'conflict' && attempt === 0) {
            base = await getClusterUpgrade();
            continue;
          }
          enqueueSnackbar(`${classified.hint} ${classified.message}`, { variant: 'error' });
          return false;
        }
      }
    } catch (err) {
      const classified = classifyError(err);
      enqueueSnackbar(`${classified.hint} ${classified.message}`, { variant: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const retry = async (): Promise<boolean> => {
    setBusy('retry');
    try {
      await retryClusterUpgrade();
      enqueueSnackbar('Retry requested: k4all-operator tries the failed nodes again.', {
        variant: 'success',
      });
      return true;
    } catch (err) {
      const classified = classifyError(err);
      enqueueSnackbar(`${classified.hint} ${classified.message}`, { variant: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { phase, review, apply, close, act, retry, busy };
}
