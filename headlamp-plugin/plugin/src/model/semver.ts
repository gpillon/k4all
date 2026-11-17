/*
 * Lenient semantic versions, parsed like Masterminds/semver's NewVersion
 * (the library the operator uses for upgradePath): an optional "v", and
 * minor/patch may be missing ("1.2" is 1.2.0).
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE =
  /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

export function parseSemver(raw: string | undefined | null): SemVer | null {
  if (!raw) {
    return null;
  }
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) {
    return Number(a) - Number(b);
  }
  if (an !== bn) {
    return an ? -1 : 1; // numeric identifiers sort first
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) {
      return a[key] - b[key];
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // A release is greater than any of its pre-releases.
    return b.prerelease.length - a.prerelease.length;
  }
  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    if (a.prerelease[i] === undefined) {
      return -1;
    }
    if (b.prerelease[i] === undefined) {
      return 1;
    }
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (c !== 0) {
      return c;
    }
  }
  return 0;
}

/** Same release, ignoring a leading "v" ("v1.2.3" and "1.2.3" match). */
export function sameVersion(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    return compareSemver(pa, pb) === 0;
  }
  return a.replace(/^v/, '') === b.replace(/^v/, '');
}
