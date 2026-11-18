import { defaultClusterConfig } from './fixtures';
import { followStored, formFromOverride, overrideChanged, parseOverrideForm } from './overrides';
import { applyOps, buildSpecPatch } from './patch';
import { setOverride } from './settings';

describe('override form', () => {
  it('round-trips a stored override', () => {
    const stored = {
      values: { deployment: { replicas: 2 }, logs: { general: { level: 'DEBUG' } } },
      helmArgs: ['--set a=1'],
    };
    const form = formFromOverride(stored);
    expect(form.argsText).toBe('--set a=1');
    const parsed = parseOverrideForm('traefik', 'helm', form);
    expect(parsed.issues).toEqual([]);
    expect(parsed.override).toEqual(stored);
    expect(overrideChanged(stored, parsed.override)).toBe(false);
  });

  it('starts empty without an override', () => {
    expect(formFromOverride(undefined)).toEqual({ valuesText: '', argsText: '' });
    expect(parseOverrideForm('traefik', 'helm', { valuesText: '', argsText: '' }).override).toEqual(
      {}
    );
  });

  it('ignores blank and comment lines in helmArgs and validates the rest', () => {
    const parsed = parseOverrideForm('traefik', 'helm', {
      valuesText: '',
      argsText: '# comment\n--set a=1\n\n--set-string b=2\n',
    });
    expect(parsed.override).toBeUndefined();
    expect(parsed.issues.map(i => i.message)).toEqual([
      'Line 2: "--set-string b=2": only --set key=value is supported.',
    ]);
  });

  it('reports YAML errors on the values field', () => {
    const parsed = parseOverrideForm('traefik', 'helm', { valuesText: 'a: [1\n', argsText: '' });
    expect(parsed.issues[0].field).toBe('override:traefik:values');
    expect(parsed.override).toBeUndefined();
  });

  it('keeps component warnings without blocking', () => {
    const parsed = parseOverrideForm('metallb', 'manifest', {
      valuesText: 'a: 1\n',
      argsText: '--set b=2',
    });
    expect(parsed.override).toEqual({ values: { a: 1 }, helmArgs: ['--set b=2'] });
    expect(parsed.issues.map(i => i.severity)).toEqual(['warning', 'warning']);
  });

  it('treats an empty override like no override', () => {
    expect(overrideChanged(undefined, {})).toBe(false);
    expect(overrideChanged({ values: {} }, undefined)).toBe(false);
    expect(overrideChanged(undefined, { helmArgs: ['--set a=1'] })).toBe(true);
  });

  it('patches only componentOverrides.<name>, with explicit nulls preserved', () => {
    const cc = defaultClusterConfig();
    const parsed = parseOverrideForm('headlamp', 'helm', {
      valuesText: 'config:\n  baseURL: null\n',
      argsText: '',
    });
    const draft = setOverride(cc.spec!, 'headlamp', parsed.override!);
    const ops = buildSpecPatch(cc, draft);
    expect(ops).toEqual([
      { op: 'test', path: '/metadata/generation', value: 3 },
      {
        op: 'add',
        path: '/spec/componentOverrides/headlamp',
        value: { values: { config: { baseURL: null } } },
      },
    ]);
    expect(applyOps(cc, ops).spec?.componentOverrides?.headlamp?.values).toEqual({
      config: { baseURL: null },
    });
  });
});

describe('followStored', () => {
  const old = { values: { a: 1 } };
  const newer = { values: { a: 2 } };

  it('lets an untouched form follow a change made elsewhere', () => {
    expect(followStored(formFromOverride(old), old, newer, 'traefik', 'helm')).toEqual(
      formFromOverride(newer)
    );
  });

  it('normalizes the form after its own save', () => {
    const typed = { valuesText: 'a:   2\n', argsText: '' };
    expect(followStored(typed, old, newer, 'traefik', 'helm')).toEqual(formFromOverride(newer));
  });

  it('keeps local edits', () => {
    const edited = { valuesText: 'a: 3\n', argsText: '' };
    expect(followStored(edited, old, newer, 'traefik', 'helm')).toBe(edited);
  });
});
