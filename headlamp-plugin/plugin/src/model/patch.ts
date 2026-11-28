/*
 * JSON Patch (RFC 6902) generation for k4all custom resources.
 *
 * Why JSON Patch and not a merge patch: componentOverrides values are Helm
 * values, where an explicit null is meaningful (it deletes a chart default).
 * A JSON merge patch cannot set a null, a JSON Patch can. JSON Patch also
 * carries a precondition: the first operation tests metadata.generation, so
 * the patch only applies when nobody changed the spec since it was loaded.
 * Status writes by the operator (every reconcile) do not bump generation, so
 * they never cause a false conflict.
 */

import {
  clone,
  deleteIn,
  fromPointer,
  getIn,
  isPlainObject,
  jsonEqual,
  JsonObject,
  Path,
  setIn,
  toPointer,
} from './objects';
import { FIELD_MANAGER } from './types';

export type JsonPatchOp =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string };

/**
 * The operations that turn base into desired below path. Objects are
 * compared key by key; arrays and scalars are replaced as a whole.
 */
export function diffToOps(base: unknown, desired: unknown, path: Path = []): JsonPatchOp[] {
  if (jsonEqual(base, desired)) {
    return [];
  }
  if (isPlainObject(base) && isPlainObject(desired)) {
    const ops: JsonPatchOp[] = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(desired)]);
    for (const key of [...keys].sort()) {
      const b = base[key];
      const d = desired[key];
      const childPath = [...path, key];
      if (d === undefined && b !== undefined) {
        ops.push({ op: 'remove', path: toPointer(childPath) });
      } else if (b === undefined && d !== undefined) {
        ops.push({ op: 'add', path: toPointer(childPath), value: clone(d) });
      } else {
        ops.push(...diffToOps(b, d, childPath));
      }
    }
    return ops;
  }
  if (desired === undefined) {
    return [{ op: 'remove', path: toPointer(path) }];
  }
  if (base === undefined) {
    return [{ op: 'add', path: toPointer(path), value: clone(desired) }];
  }
  return [{ op: 'replace', path: toPointer(path), value: clone(desired) }];
}

export interface Versioned {
  metadata: { generation?: number; resourceVersion?: string };
}

/**
 * A patch that changes `.spec` of obj to desiredSpec, guarded by a test on
 * metadata.generation (or, for objects without one, resourceVersion).
 * Returns an empty list when nothing changes.
 */
export function buildSpecPatch(
  obj: Versioned & { spec?: unknown },
  desiredSpec: unknown
): JsonPatchOp[] {
  const changes =
    obj.spec === undefined
      ? desiredSpec === undefined
        ? []
        : [{ op: 'add' as const, path: '/spec', value: clone(desiredSpec) }]
      : diffToOps(obj.spec, desiredSpec, ['spec']);
  if (changes.length === 0) {
    return [];
  }
  return [precondition(obj), ...changes];
}

export function precondition(obj: Versioned): JsonPatchOp {
  if (typeof obj.metadata.generation === 'number') {
    return { op: 'test', path: '/metadata/generation', value: obj.metadata.generation };
  }
  return { op: 'test', path: '/metadata/resourceVersion', value: obj.metadata.resourceVersion };
}

/** The non-test operations of a patch. */
export function changeOps(ops: JsonPatchOp[]): JsonPatchOp[] {
  return ops.filter(op => op.op !== 'test');
}

export class PatchTestFailed extends Error {
  constructor(public readonly path: string) {
    super(`testing value ${path} failed`);
  }
}

/**
 * Applies ops to doc like the API server does (add, remove, replace, test),
 * returning a new document. Used for local previews and in tests.
 */
export function applyOps<T>(doc: T, ops: JsonPatchOp[]): T {
  let cur: unknown = clone(doc);
  for (const op of ops) {
    const path = fromPointer(op.path);
    const parent = getIn(cur, path.slice(0, -1));
    const exists = getIn(cur, path) !== undefined;
    switch (op.op) {
      case 'test':
        if (!jsonEqual(getIn(cur, path), op.value)) {
          throw new PatchTestFailed(op.path);
        }
        break;
      case 'add':
        if (path.length > 0 && !isPlainObject(parent) && !Array.isArray(parent)) {
          throw new Error(`add ${op.path}: parent does not exist`);
        }
        if (Array.isArray(parent) && path[path.length - 1] === '-') {
          // RFC 6902: "-" appends to the array
          cur = setIn(cur, path.slice(0, -1), [...parent, clone(op.value)]);
          break;
        }
        cur = setIn(cur, path, clone(op.value));
        break;
      case 'replace':
        if (!exists) {
          throw new Error(`replace ${op.path}: path does not exist`);
        }
        cur = setIn(cur, path, clone(op.value));
        break;
      case 'remove':
        if (!exists) {
          throw new Error(`remove ${op.path}: path does not exist`);
        }
        cur = deleteIn(cur, path);
        break;
    }
  }
  return cur as T;
}

/** Query string for a write: field manager, strict field validation, optional dry run. */
export function writeQuery(opts: { dryRun?: boolean }): string {
  const params = new URLSearchParams();
  params.set('fieldManager', FIELD_MANAGER);
  params.set('fieldValidation', 'Strict');
  if (opts.dryRun) {
    params.set('dryRun', 'All');
  }
  return params.toString();
}

/**
 * A JSON merge patch that sets one annotation (null removes it). A merge
 * patch only touches that key, so annotations added meanwhile by others are
 * kept; a JSON Patch "add /metadata/annotations" would replace the whole map.
 */
export function annotationMergePatch(key: string, value: string | null): JsonObject {
  return { metadata: { annotations: { [key]: value } } };
}

/** Leaf paths (relative to the diffed documents) touched by a set of changes. */
export function touchedPaths(
  base: JsonObject | undefined,
  desired: JsonObject | undefined
): string[][] {
  return diffToOps(base ?? {}, desired ?? {}, []).map(op => fromPointer(op.path));
}
