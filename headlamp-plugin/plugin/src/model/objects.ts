/*
 * Small, dependency-free helpers for JSON documents: path access, immutable
 * updates, JSON equality and RFC 6901 JSON pointers.
 */

export type Path = ReadonlyArray<string | number>;

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality with JSON semantics: object keys whose value is undefined do not count. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!jsonEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** A deep copy through JSON, which is what every object here is. */
export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function getIn(doc: unknown, path: Path): unknown {
  let cur: unknown = doc;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === 'number') {
      cur = cur[key];
    } else if (isPlainObject(cur)) {
      cur = cur[String(key)];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Returns a copy of doc with value at path. Missing or non-object levels on
 * the way are replaced by objects. Setting undefined removes the key.
 */
export function setIn<T>(doc: T, path: Path, value: unknown): T {
  if (path.length === 0) {
    return value as T;
  }
  const [head, ...rest] = path;
  if (Array.isArray(doc) && typeof head === 'number') {
    const copy = doc.slice();
    copy[head] = setIn(copy[head], rest, value);
    return copy as unknown as T;
  }
  const base: JsonObject = isPlainObject(doc) ? { ...doc } : {};
  const key = String(head);
  const next = setIn(base[key], rest, value);
  if (next === undefined) {
    delete base[key];
  } else {
    base[key] = next;
  }
  return base as unknown as T;
}

/**
 * setIn, then removes the objects on the path that the change left empty
 * (deepest first), so clearing the last field of a setting leaves the
 * setting absent ("not owned"), not an empty object.
 */
export function setPruned<T>(doc: T, path: Path, value: unknown): T {
  let out = setIn(doc, path, value);
  if (value !== undefined) {
    return out;
  }
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = getIn(out, path.slice(0, depth));
    if (!isPlainObject(parent) || Object.keys(parent).length > 0) {
      break;
    }
    out = setIn(out, path.slice(0, depth), undefined);
  }
  return out;
}

export function deleteIn<T>(doc: T, path: Path): T {
  if (path.length === 0 || getIn(doc, path) === undefined) {
    return doc;
  }
  return setIn(doc, path, undefined);
}

// ----------------------------------------------------------- JSON pointers

export function escapePointerToken(token: string | number): string {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function toPointer(path: Path): string {
  return path.map(t => '/' + escapePointerToken(t)).join('');
}

export function fromPointer(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new Error(`invalid JSON pointer "${pointer}"`);
  }
  return pointer.slice(1).split('/').map(unescapePointerToken);
}

/** "networking.cni.cilium.hubble" style label of a path, for humans. */
export function dottedPath(path: Path): string {
  return path.map(String).join('.');
}
