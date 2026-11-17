import { availableReleases, clusterUpgrade, clusterUpgradeInProgress, node } from './fixtures';
import { applyOps } from './patch';
import { NodeLike, ReleaseInfo } from './types';
import {
  canRetry,
  clusterFacts,
  describeUpgradeChanges,
  desiredSpec,
  drainBehaviour,
  drainTimer,
  estimate,
  formatDuration,
  hopKind,
  intentOps,
  nodeGuidance,
  planPath,
  upgradeOrder,
  upgradeView,
} from './upgrades';

const versions = (plan: ReturnType<typeof planPath>) => plan.hops.map(h => h.release.version);

describe('planPath (port of k4all-upgrade plan_path)', () => {
  it("takes the stream's latest patch first, then every minor", () => {
    const plan = planPath('v2.4.0', 'v2.7.0', availableReleases());
    expect(versions(plan)).toEqual(['v2.4.1', 'v2.5.0', 'v2.6.0', 'v2.7.0']);
    expect(plan.exact).toBe(false);
    expect(plan.hops.map(h => h.kind)).toEqual(['patch', 'minor', 'minor', 'minor']);
    expect(plan.hops[1].from).toBe('v2.4.1');
  });

  it('jumps to the target patch directly inside a stream', () => {
    const releases: ReleaseInfo[] = [
      { version: 'v2.7.1', kind: 'patch' },
      { version: 'v2.7.2', kind: 'patch' },
    ];
    expect(versions(planPath('v2.7.0', 'v2.7.2', releases))).toEqual(['v2.7.2']);
  });

  it('follows minFrom exactly when the graph provides it', () => {
    const releases: ReleaseInfo[] = [
      { version: 'v2.7.1', kind: 'patch', minFrom: 'v2.7.0' },
      // v2.7.2 can only be reached from v2.7.1
      { version: 'v2.7.2', kind: 'patch', minFrom: 'v2.7.1' },
    ];
    const plan = planPath('v2.7.0', 'v2.7.2', releases);
    expect(plan.exact).toBe(true);
    expect(versions(plan)).toEqual(['v2.7.1', 'v2.7.2']);
  });

  it('reports a release the cluster cannot reach', () => {
    const releases: ReleaseInfo[] = [{ version: 'v2.8.0', kind: 'minor', minFrom: 'v2.7.5' }];
    expect(planPath('v2.7.0', 'v2.8.0', releases).error).toMatch(/No release can be reached/);
  });

  it('reports a target the cluster cannot move to, and nothing for an older one', () => {
    expect(planPath('v2.4.0', 'v2.9.0', availableReleases()).error).toMatch(/not among/);
    expect(planPath('v2.6.0', 'v2.5.0', availableReleases()).hops).toEqual([]);
    expect(planPath('main', 'v2.5.0', availableReleases()).error).toBeTruthy();
  });

  it('says what each hop changes', () => {
    const plan = planPath('v2.4.0', 'v2.7.0', availableReleases(), {
      kubernetes: '1.35.10',
      fedora: 43,
    });
    expect(plan.hops.map(h => h.changes)).toEqual([
      [],
      [{ what: 'Fedora', from: '43', to: '45' }],
      [],
      [{ what: 'Kubernetes', from: '1.35.10', to: '1.36.4' }],
    ]);
  });

  it('classifies hops like hop_kind', () => {
    expect(hopKind('v2.4.0', 'v2.4.1')).toBe('patch');
    expect(hopKind('v2.4.1', 'v2.5.0')).toBe('minor');
  });
});

describe('clusterFacts', () => {
  it('takes the oldest Kubernetes, Fedora and CRI-O among the nodes', () => {
    const a = node('a');
    const b = node('b');
    b.status!.nodeInfo = {
      kubeletVersion: 'v1.35.10',
      osImage: 'Fedora Linux 43 (k4all)',
      containerRuntimeVersion: 'cri-o://1.35.2',
    };
    expect(clusterFacts([a, b])).toEqual({ kubernetes: '1.35.10', fedora: 43, crio: '1.35' });
    expect(clusterFacts([])).toEqual({ kubernetes: undefined, fedora: undefined, crio: undefined });
  });
});

describe('upgradeOrder', () => {
  it("orders the operator's nodes bootstrap, control, worker", () => {
    const order = upgradeOrder(
      [
        { name: 'w-1', role: 'worker', phase: 'Pending' },
        { name: 'cp-2', role: 'control', phase: 'Pending' },
        { name: 'cp-1', role: 'bootstrap', phase: 'Pending' },
      ],
      []
    );
    expect(order.map(n => n.name)).toEqual(['cp-1', 'cp-2', 'w-1']);
  });

  it('falls back to the Nodes: node-type annotation, NodeConfig, control-plane label', () => {
    const boot = node('z-boot', { annotations: { 'k4all.magesgate.com/node-type': 'bootstrap' } });
    const cp = node('a-cp');
    const worker: NodeLike = { ...node('m-worker'), metadata: { name: 'm-worker', labels: {} } };
    const nc = { metadata: { name: 'm-worker' }, status: { nodeType: 'worker' } };
    const order = upgradeOrder(undefined, [worker, cp, boot], [nc]);
    expect(order.map(n => [n.name, n.role])).toEqual([
      ['z-boot', 'bootstrap'],
      ['a-cp', 'control'],
      ['m-worker', 'worker'],
    ]);
  });
});

describe('estimate and drain', () => {
  const three = upgradeOrder(clusterUpgrade().status!.nodes, []);

  it('counts one reboot per node and hop', () => {
    const e = estimate(3, three, { timeoutMinutes: 10 });
    expect(e).toMatchObject({ reboots: 9, nodes: 3, controlPlanes: 2, minutes: [45, 135] });
    expect(e.notes.join(' ')).toMatch(/two control-plane nodes/);
    expect(drainBehaviour(e)).toMatch(/at most 10 minutes.*the node fails/);
    expect(drainBehaviour({ ...e, continueOnTimeout: true })).toMatch(/hop runs anyway/);
  });

  it('only cordons a single node and says everything goes down', () => {
    const e = estimate(2, [{ name: 'solo', role: 'bootstrap' }]);
    expect(e.singleNode).toBe(true);
    expect(e.notes[0]).toMatch(/only cordoned.*2 times/);
    expect(drainBehaviour(e)).toMatch(/not drained/);
  });

  it('times a drain against the timeout', () => {
    const n = clusterUpgradeInProgress().status!.nodes![1];
    const start = Date.parse('2026-11-17T10:00:00Z');
    expect(drainTimer(n, { timeoutMinutes: 30 }, start + 6 * 60000)).toMatchObject({
      fraction: 0.2,
      overdue: false,
      remainingMs: 24 * 60000,
    });
    expect(drainTimer(n, {}, start + 31 * 60000)?.overdue).toBe(true);
    expect(drainTimer({ name: 'x', phase: 'Pending' }, {}, start)).toBeNull();
    expect(formatDuration(45000)).toBe('45 s');
    expect(formatDuration(65 * 60000)).toBe('1 h 5 min');
  });
});

describe('upgradeView', () => {
  it('tells an idle cluster with newer releases from one that is up to date', () => {
    const view = upgradeView(clusterUpgrade());
    expect(view).toMatchObject({ stage: 'available', current: 'v2.4.0', active: false });
    expect(view.latest?.version).toBe('v2.7.0');
    const latest = clusterUpgrade();
    latest.status!.availableReleases = [];
    expect(upgradeView(latest).stage).toBe('upToDate');
    expect(upgradeView({ metadata: { name: 'k4all' } }).stage).toBe('waiting');
  });

  it('follows an upgrade: hop index, nodes done, progress over all node hops', () => {
    const view = upgradeView(clusterUpgradeInProgress());
    expect(view).toMatchObject({
      stage: 'progressing',
      target: 'v2.6.0',
      hopIndex: 2,
      nodesDone: 1,
      nodesTotal: 3,
      active: true,
      stale: false,
    });
    expect(view.progress).toBeCloseTo(4 / 9);
  });

  it('shows pausing until the node in progress is done, then paused', () => {
    const cu = clusterUpgradeInProgress();
    cu.spec!.paused = true;
    expect(upgradeView(cu).stage).toBe('pausing');
    cu.status!.phase = 'Paused';
    expect(upgradeView(cu).stage).toBe('paused');
    cu.status!.phase = 'Failed';
    expect(upgradeView(cu)).toMatchObject({ stage: 'failed', tone: 'error' });
    cu.status!.phase = 'Succeeded';
    expect(upgradeView(cu).active).toBe(false);
  });

  it('notices a spec the operator has not processed yet', () => {
    const cu = clusterUpgradeInProgress();
    cu.metadata.generation = 3;
    expect(upgradeView(cu).stale).toBe(true);
  });
});

describe('nodeGuidance', () => {
  const spec = { drain: { timeoutMinutes: 20 } };

  it('explains a HOLD with the commands to run on the node', () => {
    const g = nodeGuidance(
      { name: 'cp-2', phase: 'Failed', hostPhase: 'HOLD', message: 'kubeadm upgrade failed' },
      spec
    )!;
    expect(g.title).toBe('cp-2 is on hold');
    expect(g.text).toMatch(/kubeadm upgrade failed/);
    expect(g.commands.map(c => c.command)).toEqual([
      'sudo k4all-upgrade status',
      'sudo k4all-upgrade clear-hold && sudo k4all-upgrade resume',
      'sudo k4all-upgrade clear-hold --abandon',
    ]);
    expect(g.retry).toBe(false);
  });

  it('points at the graph when the node refuses the target', () => {
    const g = nodeGuidance(
      {
        name: 'w-1',
        phase: 'Upgrading',
        hostPhase: 'HOLD',
        message: 'upgrade-target v2.5.0 is not one hop from v2.4.0',
      },
      spec
    )!;
    expect(g.title).toBe('w-1 refused the hop');
    expect(g.text).toMatch(/k4all-upgrade.yaml/);
  });

  it('offers Retry for an abandoned hop and a failed drain', () => {
    const abandoned = nodeGuidance(
      { name: 'w-1', phase: 'Failed', hostPhase: 'ABANDONED', release: 'v2.4.1' },
      spec
    )!;
    expect(abandoned).toMatchObject({ severity: 'error', retry: true });
    expect(abandoned.text).toMatch(/stays on v2.4.1/);
    const drain = nodeGuidance(
      { name: 'w-1', phase: 'Failed', drainStartedAt: '2026-11-17T10:00:00Z' },
      spec
    )!;
    expect(drain.title).toBe('Draining w-1 did not finish');
    expect(drain.text).toMatch(/within 20 minutes/);
    expect(drain.commands[0].command).toBe(
      'kubectl get pods -A -o wide --field-selector spec.nodeName=w-1'
    );
    expect(drain.retry).toBe(true);
  });

  it('has nothing to say about a healthy node', () => {
    expect(nodeGuidance({ name: 'a', phase: 'Upgrading', hostPhase: 'STAGE' }, spec)).toBeNull();
    expect(nodeGuidance({ name: 'a', phase: 'Done' }, spec)).toBeNull();
  });

  it('offers Retry only where it helps', () => {
    const cu = clusterUpgradeInProgress();
    expect(canRetry(cu)).toBe(false);
    cu.status!.phase = 'Failed';
    expect(canRetry(cu)).toBe(true);
    cu.status!.nodes![1] = { name: 'cp-2', phase: 'Failed', hostPhase: 'HOLD' };
    expect(canRetry(cu)).toBe(false); // a hold resumes by itself
  });
});

describe('spec writes', () => {
  it('starts an upgrade: target set, a leftover pause lifted, guarded by generation', () => {
    const cu = clusterUpgrade({ spec: { paused: true, drain: { timeoutMinutes: 30 } } });
    const ops = intentOps(cu, { kind: 'start', target: '2.7.0' });
    expect(ops[0]).toEqual({ op: 'test', path: '/metadata/generation', value: 1 });
    const after = applyOps(cu, ops);
    expect(after.spec).toEqual({ targetRelease: 'v2.7.0', drain: { timeoutMinutes: 30 } });
  });

  it('carries drain options chosen in the review', () => {
    const spec = desiredSpec(clusterUpgrade(), {
      kind: 'start',
      target: 'v2.5.0',
      drain: { timeoutMinutes: 10, continueOnTimeout: true },
    });
    expect(spec.drain).toEqual({ timeoutMinutes: 10, continueOnTimeout: true });
  });

  it('pauses, resumes and stops', () => {
    const cu = clusterUpgradeInProgress();
    expect(desiredSpec(cu, { kind: 'pause' }).paused).toBe(true);
    const paused = { ...cu, spec: { ...cu.spec, paused: true } };
    expect(desiredSpec(paused, { kind: 'resume' }).paused).toBeUndefined();
    expect(desiredSpec(paused, { kind: 'stop' })).toEqual({ drain: { timeoutMinutes: 30 } });
    expect(intentOps(cu, { kind: 'resume' })).toEqual([]); // nothing to change
  });

  it('works on an object without a spec', () => {
    const cu = clusterUpgrade({ spec: undefined });
    expect(applyOps(cu, intentOps(cu, { kind: 'pause' })).spec).toEqual({ paused: true });
  });

  it('saves settings, with the default graph written as empty', () => {
    const cu = clusterUpgrade({ spec: { graphUrl: 'https://lab/graph.json' } });
    const spec = desiredSpec(cu, {
      kind: 'settings',
      drain: { timeoutMinutes: 45, continueOnTimeout: false },
      graphUrl: 'https://github.com/gpillon/k4all/releases/latest/download/upgrade-graph.json',
    });
    expect(spec).toEqual({ drain: { timeoutMinutes: 45 } });
  });

  it('describes the changes for the review', () => {
    const items = describeUpgradeChanges(
      { paused: true, drain: { timeoutMinutes: 30 } },
      { targetRelease: 'v2.7.0', drain: { timeoutMinutes: 10, continueOnTimeout: true } }
    );
    expect(items.map(i => [i.key, i.severity])).toEqual([
      ['spec.targetRelease', 'danger'],
      ['spec.paused', 'info'],
      ['spec.drain.timeoutMinutes', 'info'],
      ['spec.drain.continueOnTimeout', 'warning'],
    ]);
    expect(describeUpgradeChanges({ targetRelease: 'v2.7.0' }, {})[0].consequence).toMatch(
      /stops after the node in progress/
    );
  });
});
