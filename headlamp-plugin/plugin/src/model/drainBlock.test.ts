import {
  BARE_PODS_DOC_URL,
  drainBlockAdvice,
  DRAINS_NEVER_END_DOC_URL,
  parseDrainBlock,
} from './drainBlock';

// The texts of k4all-operator's shared drain (internal/drain, release-v0.6.0
// d3d7b19): BlockedMessage before the cordon, Drain while it evicts.
const PDB =
  'cannot be drained: PDB db/pg-primary allows no disruption of pod db/pg-1 ' +
  '(a single-instance CloudNativePG cluster? see docs/upgrades.md, Drains that never end)';
const BARE =
  'runs pods that declare no controller: default/debug, kube-system/tool, team/x, and 2 more ' +
  '(a drain would delete them, and nothing recreates them: delete them, or recreate them under a ' +
  'controller; see docs/upgrades.md, Pods that declare no controller)';
const NOT_CORDONED = '; the node is not cordoned';

describe('parseDrainBlock', () => {
  it('reads a node blocked before its cordon by a budget and by bare pods', () => {
    expect(parseDrainBlock(`${PDB}; ${BARE}${NOT_CORDONED}`)).toEqual({
      pdbs: [{ pdb: 'db/pg-primary', pod: 'db/pg-1' }],
      pdbMore: 0,
      bare: ['default/debug', 'kube-system/tool', 'team/x'],
      bareMore: 2,
      notCordoned: true,
    });
    expect(parseDrainBlock(`${BARE}${NOT_CORDONED}`)).toMatchObject({ pdbs: [], bareMore: 2 });
    expect(
      parseDrainBlock(
        'cannot be drained: PDB a/b allows no disruption of pod a/c; PDB a/d allows no disruption of pod a/e; ' +
          'PDB a/f allows no disruption of pod a/g; and 4 more (a single-instance CloudNativePG cluster? see docs/upgrades.md, Drains that never end)' +
          NOT_CORDONED
      )
    ).toMatchObject({
      pdbs: [
        { pdb: 'a/b', pod: 'a/c' },
        { pdb: 'a/d', pod: 'a/e' },
        { pdb: 'a/f', pod: 'a/g' },
      ],
      pdbMore: 4,
      bare: [],
    });
  });

  it('reads the bare pods a drain in progress leaves alone', () => {
    expect(
      parseDrainBlock(
        '3 pods left: default/web-1, default/debug, x/y; not evicted, they declare no controller: default/debug ' +
          '(delete them, or recreate them under a controller)'
      )
    ).toEqual({ pdbs: [], pdbMore: 0, bare: ['default/debug'], bareMore: 0, notCordoned: false });
  });

  it('is null for any other message', () => {
    expect(parseDrainBlock('draining')).toBeNull();
    expect(parseDrainBlock('drain timed out after 30 minutes, 2 pods left: a/b, c/d')).toBeNull();
    expect(parseDrainBlock(undefined)).toBeNull();
  });
});

describe('drainBlockAdvice', () => {
  it('says what to do with pods that declare no controller, and links the docs', () => {
    const a = drainBlockAdvice(parseDrainBlock(`${BARE}${NOT_CORDONED}`)!, 'w-1');
    expect(a.title).toBe('w-1 runs pods that declare no controller');
    expect(a.text).toMatch(/would delete them for good: nothing recreates them/);
    expect(a.text).toMatch(/Delete them, or recreate them under a controller/);
    expect(a.text).toMatch(/w-1 is not cordoned meanwhile/);
    expect(a.commands.map(c => c.command)).toEqual([
      'kubectl get pods -A -o wide --field-selector spec.nodeName=w-1',
      'kubectl delete pod -n default debug',
      'kubectl delete pod -n kube-system tool',
      'kubectl delete pod -n team x',
    ]);
    expect(a.links).toEqual([
      { label: 'Pods that declare no controller (docs/upgrades.md)', href: BARE_PODS_DOC_URL },
    ]);
  });

  it('says what to do with a budget that allows no disruption, and both together', () => {
    const pdb = drainBlockAdvice(parseDrainBlock(`${PDB}${NOT_CORDONED}`)!, 'cp-2');
    expect(pdb.title).toBe('cp-2 cannot be drained');
    expect(pdb.text).toMatch(/PodDisruptionBudget db\/pg-primary allows no disruption of db\/pg-1/);
    expect(pdb.commands.map(c => c.command)).toContain('kubectl get pdb -n db pg-primary -o yaml');
    expect(pdb.links).toEqual([
      { label: 'Drains that never end (docs/upgrades.md)', href: DRAINS_NEVER_END_DOC_URL },
    ]);
    const both = drainBlockAdvice(parseDrainBlock(`${PDB}; ${BARE}${NOT_CORDONED}`)!, 'cp-2');
    expect(both.title).toBe('cp-2 cannot be drained');
    expect(both.links.map(l => l.href)).toEqual([DRAINS_NEVER_END_DOC_URL, BARE_PODS_DOC_URL]);
  });

  it('during a drain: the other pods go, these wait', () => {
    const a = drainBlockAdvice(
      parseDrainBlock(
        '1 pods left: default/debug; not evicted, they declare no controller: default/debug (delete them, or recreate them under a controller)'
      )!,
      'w-1'
    );
    expect(a.text).toMatch(/The drain waits for them/);
    expect(a.severity).toBe('info');
  });
});
