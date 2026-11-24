import { buildRows } from './components';
import { classifyError } from './errors';
import { defaultClusterConfig, node, releaseManifest } from './fixtures';
import { clusterHealth, kubeletVersions, nodeRows, nodeUpgrades } from './health';
import { diffLines, diffStats, foldUnchanged, toYaml } from './textDiff';
import { UPGRADE_IN_PROGRESS_ANNOTATION } from './types';

const NOW = Date.parse('2026-11-17T10:03:00Z');

function input(overrides: Partial<Parameters<typeof clusterHealth>[0]> = {}) {
  const rm = releaseManifest();
  const cc = defaultClusterConfig();
  return {
    rm,
    cc,
    rows: buildRows(rm, cc.spec!),
    nodes: [node('k4all-1')],
    now: NOW,
    ...overrides,
  };
}

describe('clusterHealth', () => {
  it('reports reconciling while a component walks its upgrade path', () => {
    expect(clusterHealth(input())).toMatchObject({
      level: 'progressing',
      headline: 'Reconciling',
      banners: [],
    });
  });

  it('reports healthy when everything is settled', () => {
    const rm = releaseManifest();
    rm.status!.components!['cert-manager'] = { state: 'Installed', installedVersion: 'v1.21.3' };
    const cc = defaultClusterConfig();
    expect(clusterHealth(input({ rm, rows: buildRows(rm, cc.spec!) })).level).toBe('healthy');
  });

  it('surfaces a node upgrade hop', () => {
    const nodes = [
      node('k4all-1', { annotations: { [UPGRADE_IN_PROGRESS_ANNOTATION]: 'v2.6.0->v2.7.0' } }),
    ];
    const health = clusterHealth(input({ nodes }));
    expect(health.level).toBe('upgrading');
    expect(health.banners[0].detail).toContain('k4all-1: v2.6.0 → v2.7.0');
  });

  it('flags failed components as needing attention', () => {
    const rm = releaseManifest();
    rm.status!.components!.traefik = { state: 'Failed', message: 'helm upgrade failed' };
    const health = clusterHealth(input({ rm, rows: buildRows(rm, defaultClusterConfig().spec!) }));
    expect(health.level).toBe('degraded');
    expect(health.banners.find(b => b.id === 'failed')?.detail).toBe('traefik');
  });

  it('notices settings the operator has not applied yet, and an idle operator', () => {
    const cc = defaultClusterConfig();
    cc.metadata.generation = 4;
    cc.status!.lastReconcileTime = '2026-11-17T09:00:00Z';
    const ids = clusterHealth(input({ cc })).banners.map(b => b.id);
    expect(ids).toEqual(['applying', 'stale']);
  });

  it('lists the uninstalls k4all-operator refuses and what it waits for', () => {
    const rm = releaseManifest();
    rm.status!.components!['cert-manager'] = { state: 'Installed', installedVersion: 'v1.21.3' };
    rm.status!.components!.kubevirt = {
      state: 'Installed',
      message: 'uninstall refused: 2 VirtualMachines exist (default/a, default/b)',
    };
    rm.status!.components!.cdi = { state: 'Installed', message: 'waiting: kubevirt is kept' };
    const cc = defaultClusterConfig();
    const h = clusterHealth(input({ rm, rows: buildRows(rm, cc.spec!) }));
    expect(h.banners).toEqual([
      {
        id: 'refused',
        severity: 'warning',
        title: 'k4all-operator keeps kubevirt installed',
        detail:
          'kubevirt: 2 VirtualMachines exist (default/a, default/b). It removes it once that is gone.',
      },
      { id: 'waiting', severity: 'info', title: 'Waiting: cdi', detail: 'cdi: kubevirt is kept' },
    ]);
    expect(h.level).toBe('healthy');
  });

  it('follows the node-settings rollout', () => {
    const cc = defaultClusterConfig();
    cc.spec!.nodes = { iommu: true };
    cc.status!.nodes = {
      settingsHash: 'h',
      rollout: { phase: 'Rolling', currentNode: 'k4all-2', message: 'draining k4all-2' },
      perNode: [
        { name: 'k4all-1', appliedHash: 'h' },
        { name: 'k4all-2', appliedHash: 'old' },
      ],
    };
    const h = clusterHealth(input({ cc }));
    expect(h.banners.find(b => b.id === 'nodeSettings')).toEqual({
      id: 'nodeSettings',
      severity: 'info',
      title: 'Node settings rollout on k4all-2',
      detail: '1 of 2 nodes have the settings. draining k4all-2',
    });
    expect(h.level).toBe('progressing');
    cc.status!.nodes.rollout = { phase: 'Blocked', message: 'a ClusterUpgrade runs' };
    expect(clusterHealth(input({ cc })).banners.find(b => b.id === 'nodeSettings')).toMatchObject({
      severity: 'warning',
      title: 'Node settings rollout blocked',
      detail: '1 of 2 nodes have the settings. a ClusterUpgrade runs',
    });
    cc.status!.nodes.rollout = { phase: 'Idle' };
    expect(clusterHealth(input({ cc })).banners.some(b => b.id === 'nodeSettings')).toBe(false);
  });

  it('is unknown without the custom resources', () => {
    expect(clusterHealth(input({ cc: null })).headline).toBe('No ClusterConfig');
  });
});

describe('nodes', () => {
  it('parses the upgrade annotation and orders nodes by role', () => {
    const worker = node(
      'w1',
      { labels: {}, annotations: { [UPGRADE_IN_PROGRESS_ANNOTATION]: 'v2.6.0->v2.7.0' } },
      '192.168.1.20'
    );
    const rows = nodeRows(
      [worker, node('cp1')],
      [{ metadata: { name: 'cp1' }, status: { nodeName: 'cp1', nodeType: 'bootstrap' } }]
    );
    expect(rows.map(r => `${r.name}:${r.role}`)).toEqual(['cp1:bootstrap', 'w1:worker']);
    expect(rows[1].upgrade).toMatchObject({ from: 'v2.6.0', to: 'v2.7.0' });
    expect(rows[1].internalIP).toBe('192.168.1.20');
    expect(nodeUpgrades([worker])).toHaveLength(1);
    expect(kubeletVersions([worker, node('cp1')])).toEqual(['v1.36.2']);
  });
});

describe('classifyError', () => {
  it('recognizes a failed generation precondition as a conflict', () => {
    const err = Object.assign(
      new Error('Unprocessable Entity - testing value /metadata/generation failed: test failed'),
      {
        status: 422,
      }
    );
    expect(classifyError(err).kind).toBe('conflict');
    expect(classifyError({ status: 409, message: 'Conflict' }).kind).toBe('conflict');
  });

  it('separates validation errors, with a hint for unknown fields', () => {
    const strict = classifyError({
      status: 400,
      message: 'Bad Request - strict decoding error: unknown field "spec.ingress.traefik"',
    });
    expect(strict.kind).toBe('invalid');
    expect(strict.hint).toMatch(/Upgrade k4all/);
    expect(
      classifyError({ status: 422, message: 'spec.features.virt.emulation: Unsupported value' })
        .kind
    ).toBe('invalid');
  });

  it('maps permissions, absence and outages', () => {
    expect(classifyError({ status: 403, message: 'Forbidden' }).kind).toBe('forbidden');
    expect(classifyError({ status: 404, message: 'Not Found' }).kind).toBe('notFound');
    expect(classifyError(new Error('Failed to fetch')).kind).toBe('unavailable');
    expect(classifyError({ status: 503, message: 'Service Unavailable' }).kind).toBe('unavailable');
  });
});

describe('text diff', () => {
  it('produces a minimal line diff', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(lines.map(l => `${l.kind}:${l.text}`)).toEqual([
      'same:a',
      'del:b',
      'add:B',
      'same:c',
      'add:d',
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('folds long unchanged runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'L10');
    const hunks = foldUnchanged(diffLines(before, after), 2);
    expect(
      hunks.map(h => (h.kind === 'gap' ? `gap${h.hidden}` : `lines${h.lines.length}`))
    ).toEqual(['gap8', 'lines6', 'gap7']);
  });

  it('dumps YAML with sorted keys for stable diffs', () => {
    expect(toYaml({ b: 1, a: { d: true, c: null } })).toBe('a:\n  c: null\n  d: true\nb: 1\n');
    expect(toYaml(undefined)).toBe('');
  });
});

describe('toYaml', () => {
  it('skips undefined members', () => {
    expect(toYaml({ a: undefined, b: [1] })).toBe('b:\n  - 1\n');
  });
});
