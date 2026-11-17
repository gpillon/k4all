/*
 * Line diff for the YAML preview of a change (current spec vs the spec the
 * API server returns from a dry run). Specs are short, so a plain LCS table
 * is fast enough and keeps the code obvious.
 */

import yaml from 'js-yaml';

export type DiffLineKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line numbers in the old/new text (absent for added/deleted lines). */
  oldNo?: number;
  newNo?: number;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const b = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i], oldNo: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], newNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i], oldNo: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j], newNo: j + 1 });
    j++;
  }
  return out;
}

export type Hunk = { kind: 'lines'; lines: DiffLine[] } | { kind: 'gap'; hidden: number };

/** Keeps `context` unchanged lines around each change and folds the rest. */
export function foldUnchanged(lines: DiffLine[], context = 3): Hunk[] {
  const keep = lines.map(() => false);
  lines.forEach((line, idx) => {
    if (line.kind !== 'same') {
      for (
        let k = Math.max(0, idx - context);
        k <= Math.min(lines.length - 1, idx + context);
        k++
      ) {
        keep[k] = true;
      }
    }
  });
  const hunks: Hunk[] = [];
  let current: DiffLine[] = [];
  let hidden = 0;
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      if (hidden > 0) {
        hunks.push({ kind: 'gap', hidden });
        hidden = 0;
      }
      current.push(line);
    } else {
      if (current.length > 0) {
        hunks.push({ kind: 'lines', lines: current });
        current = [];
      }
      hidden++;
    }
  });
  if (current.length > 0) {
    hunks.push({ kind: 'lines', lines: current });
  }
  if (hidden > 0) {
    hunks.push({ kind: 'gap', hidden });
  }
  return hunks;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter(l => l.kind === 'add').length,
    removed: lines.filter(l => l.kind === 'del').length,
  };
}

/** YAML for diffs (stable key order) and editors (sortKeys false keeps the user's order). */
export function toYaml(value: unknown, sortKeys = true): string {
  if (value === undefined) {
    return '';
  }
  // Through JSON first: drops undefined members, which js-yaml refuses to dump.
  return yaml.dump(JSON.parse(JSON.stringify(value)), { noRefs: true, sortKeys, lineWidth: 100 });
}
