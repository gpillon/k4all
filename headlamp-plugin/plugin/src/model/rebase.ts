/*
 * Three-way rebase of a settings draft after a write conflict.
 *
 * base   - the spec the user started editing from
 * mine   - the user's draft
 * theirs - the spec now stored on the server (someone else saved meanwhile)
 *
 * Every path the user changed is checked: if the server still has the base
 * value there (or already the user's value), the user's change is replayed on
 * top of theirs. Otherwise both sides changed it, and it is a conflict the user
 * must resolve.
 */

import { dottedPath, getIn, jsonEqual, JsonObject, setIn } from './objects';
import { touchedPaths } from './patch';

export interface Conflict {
  path: string[];
  label: string;
  base: unknown;
  theirs: unknown;
  mine: unknown;
}

export interface RebaseResult {
  /** theirs with every non-conflicting change of mine applied. */
  merged: JsonObject;
  conflicts: Conflict[];
}

export function rebase(base: JsonObject, mine: JsonObject, theirs: JsonObject): RebaseResult {
  let merged: JsonObject = theirs;
  const conflicts: Conflict[] = [];
  for (const path of touchedPaths(base, mine)) {
    const b = getIn(base, path);
    const m = getIn(mine, path);
    const t = getIn(theirs, path);
    if (jsonEqual(t, m)) {
      continue; // same change on both sides
    }
    if (jsonEqual(t, b)) {
      merged = setIn(merged, path, m);
      continue;
    }
    conflicts.push({ path, label: dottedPath(path), base: b, theirs: t, mine: m });
  }
  return { merged, conflicts };
}

/** Settles the conflicts of a rebase: keep the user's value, or the server's. */
export function resolveConflicts(result: RebaseResult, keep: 'mine' | 'theirs'): JsonObject {
  if (keep === 'theirs') {
    return result.merged;
  }
  return result.conflicts.reduce<JsonObject>(
    (doc, conflict) => setIn(doc, conflict.path, conflict.mine),
    result.merged
  );
}
