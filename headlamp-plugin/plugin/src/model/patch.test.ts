import { defaultClusterConfig } from './fixtures';
import { fromPointer, toPointer } from './objects';
import {
  annotationMergePatch,
  applyOps,
  buildSpecPatch,
  changeOps,
  diffToOps,
  PatchTestFailed,
  writeQuery,
} from './patch';
import { setOverride, setTraefik } from './settings';
import { FORCE_RESYNC_ANNOTATION } from './types';

describe('JSON pointers', () => {
  it('escapes ~ and / in keys and round-trips', () => {
    const path = ['metadata', 'annotations', 'k4all.magesgate.com/force-resync', 'a~b'];
    const pointer = toPointer(path);
    expect(pointer).toBe('/metadata/annotations/k4all.magesgate.com~1force-resync/a~0b');
    expect(fromPointer(pointer)).toEqual(path);
  });
});

describe('diffToOps', () => {
  it('returns nothing for equal documents', () => {
    expect(diffToOps({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toEqual([]);
  });

  it('emits add, replace and remove per key, recursing into objects', () => {
    const ops = diffToOps({ a: 1, b: { c: true, d: 'x' } }, { a: 2, b: { c: true }, e: { f: 1 } }, [
      'spec',
    ]);
    expect(ops).toEqual([
      { op: 'replace', path: '/spec/a', value: 2 },
      { op: 'remove', path: '/spec/b/d' },
      { op: 'add', path: '/spec/e', value: { f: 1 } },
    ]);
  });

  it('replaces arrays as a whole', () => {
    expect(diffToOps({ l: ['eth0'] }, { l: ['eth0', 'eth1'] })).toEqual([
      { op: 'replace', path: '/l', value: ['eth0', 'eth1'] },
    ]);
  });

  it('keeps explicit nulls (Helm uses them to delete chart defaults)', () => {
    expect(diffToOps({ v: { a: 1 } }, { v: { a: null } })).toEqual([
      { op: 'replace', path: '/v/a', value: null },
    ]);
    expect(diffToOps({ v: {} }, { v: { a: null } })).toEqual([
      { op: 'add', path: '/v/a', value: null },
    ]);
  });

  it('turns a type change (object to scalar) into a replace', () => {
    expect(diffToOps({ a: { b: 1 } }, { a: 'x' })).toEqual([
      { op: 'replace', path: '/a', value: 'x' },
    ]);
  });
});

describe('buildSpecPatch', () => {
  it('is empty when the draft equals the spec', () => {
    const cc = defaultClusterConfig();
    expect(buildSpecPatch(cc, cc.spec)).toEqual([]);
  });

  it('starts with a generation precondition and only touches changed fields', () => {
    const cc = defaultClusterConfig();
    const draft = { ...cc.spec, features: { ...cc.spec!.features, argocd: { enabled: true } } };
    const ops = buildSpecPatch(cc, draft);
    expect(ops).toEqual([
      { op: 'test', path: '/metadata/generation', value: 3 },
      { op: 'replace', path: '/spec/features/argocd/enabled', value: true },
    ]);
    expect(changeOps(ops)).toHaveLength(1);
  });

  it('falls back to resourceVersion when there is no generation', () => {
    const ops = buildSpecPatch({ metadata: { resourceVersion: '12' }, spec: { a: 1 } }, { a: 2 });
    expect(ops[0]).toEqual({ op: 'test', path: '/metadata/resourceVersion', value: '12' });
  });

  it('adds the whole spec when the object has none', () => {
    const ops = buildSpecPatch({ metadata: { generation: 1 } }, { a: 1 });
    expect(ops[1]).toEqual({ op: 'add', path: '/spec', value: { a: 1 } });
  });

  it('produces a patch that, applied to the stored object, yields the draft', () => {
    const cc = defaultClusterConfig();
    let draft = setTraefik(cc.spec!, { dedicatedIP: '192.168.1.240' });
    draft = setOverride(draft, 'headlamp', { values: { config: { oidc: { clientID: 'k4all' } } } });
    const patched = applyOps(cc, buildSpecPatch(cc, draft));
    expect(patched.spec).toEqual(draft);
    expect(patched.status).toEqual(cc.status);
  });

  it('fails the precondition when someone changed the spec meanwhile', () => {
    const cc = defaultClusterConfig();
    const ops = buildSpecPatch(cc, { ...cc.spec, proxy: {} });
    const newer = { ...cc, metadata: { ...cc.metadata, generation: 4 } };
    expect(() => applyOps(newer, ops)).toThrow(PatchTestFailed);
  });
});

describe('applyOps', () => {
  it('rejects remove and replace of missing paths like the API server', () => {
    expect(() => applyOps({}, [{ op: 'remove', path: '/a' }])).toThrow();
    expect(() => applyOps({}, [{ op: 'replace', path: '/a', value: 1 }])).toThrow();
    expect(() => applyOps({}, [{ op: 'add', path: '/a/b', value: 1 }])).toThrow();
  });
});

describe('annotationMergePatch', () => {
  it('sets or removes one annotation without replacing the map', () => {
    expect(annotationMergePatch(FORCE_RESYNC_ANNOTATION, 'traefik')).toEqual({
      metadata: { annotations: { 'k4all.magesgate.com/force-resync': 'traefik' } },
    });
    expect(annotationMergePatch(FORCE_RESYNC_ANNOTATION, null)).toEqual({
      metadata: { annotations: { 'k4all.magesgate.com/force-resync': null } },
    });
  });
});

describe('writeQuery', () => {
  it('always names the field manager and asks for strict validation', () => {
    expect(writeQuery({})).toBe('fieldManager=k4all-headlamp&fieldValidation=Strict');
    expect(writeQuery({ dryRun: true })).toContain('dryRun=All');
  });
});
