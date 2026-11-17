import {
  availableReleases,
  clusterUpgrade,
  clusterUpgradeInProgress,
  failWith,
  node,
} from './fixtures';
import { applyOps } from './patch';
import { NodeLike } from './types';
import {
  canRetry,
  describeUpgradeChanges,
  desiredSpec,
  drainBehaviour,
  drainTimer,
  estimate,
  formatDuration,
  formatSpan,
  hopChanges,
  hopKind,
  intentOps,
  nodeGuidance,
  PLAN_FAILURE,
  releasePlan,
  span,
  upgradeOrder,
  upgradeView,
} from './upgrades';

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
    // Progressing with no node in flight (the graph cannot be read): nothing moves.
    const stuck = clusterUpgradeInProgress();
    stuck.spec!.paused = true;
    stuck.status!.nodes![1].phase = 'Pending';
    expect(upgradeView(stuck).stage).toBe('paused');
    cu.status!.phase = 'Paused';
    expect(upgradeView(cu).stage).toBe('paused');
    cu.status!.phase = 'Failed';
    expect(upgradeView(cu)).toMatchObject({ stage: 'failed', tone: 'error' });
    cu.status!.phase = 'Succeeded';
    expect(upgradeView(cu).active).toBe(false);
  });

  it('tells an unreadable graph apart from up to date (GraphAvailable=False)', () => {
    const cu = clusterUpgrade();
    cu.status!.availableReleases = [];
    cu.status!.message = 'cannot read the upgrade graph: dial tcp: no route to host';
    cu.status!.conditions = cu.status!.conditions!.map(c =>
      c.type === 'GraphAvailable'
        ? { ...c, status: 'False', reason: 'ReadFailed', message: 'dial tcp: no route to host' }
        : c
    );
    const view = upgradeView(cu);
    expect(view).toMatchObject({ stage: 'graphUnavailable', tone: 'warning', active: false });
    expect(view.graph).toEqual({
      available: false,
      error: 'dial tcp: no route to host',
      url: 'https://github.com/gpillon/k4all/releases/latest/download/upgrade-graph.json',
    });
    expect(upgradeView(clusterUpgrade()).graph.available).toBe(true);
  });

  it('reads the Failed and Succeeded conditions', () => {
    const failed = failWith(
      clusterUpgradeInProgress(),
      'NoPath',
      'no release can be reached from v2.4.1 on the way to v2.6.0'
    );
    expect(upgradeView(failed).failedReason).toBe('NoPath');
    expect(PLAN_FAILURE.NoPath).toMatch(/Choose another target/);
    const done = clusterUpgrade();
    done.status!.phase = 'Succeeded';
    done.status!.conditions!.push({
      type: 'Succeeded',
      status: 'True',
      reason: 'Succeeded',
      lastTransitionTime: '2026-11-17T11:00:00Z',
    });
    done.status!.conditions = done.status!.conditions!.filter(
      c => !(c.type === 'Succeeded' && c.status === 'False')
    );
    expect(upgradeView(done)).toMatchObject({
      stage: 'succeeded',
      succeededAt: '2026-11-17T11:00:00Z',
    });
  });

  it('notices a spec the operator has not processed yet', () => {
    const cu = clusterUpgradeInProgress();
    cu.metadata.generation = 3;
    expect(upgradeView(cu).stale).toBe(true);
  });
});

describe("nodeGuidance (by the operator's reason, never by message text)", () => {
  const spec = { drain: { timeoutMinutes: 20 } };

  it('explains a HOLD with the commands to run on the node', () => {
    const g = nodeGuidance(
      {
        name: 'cp-2',
        phase: 'Failed',
        reason: 'HostHold',
        hostPhase: 'HOLD',
        message: 'kubeadm upgrade failed',
      },
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

  it('points at the graph for TargetRejected and at the node for RollbackRebooted', () => {
    const rejected = nodeGuidance(
      { name: 'w-1', phase: 'Failed', reason: 'TargetRejected', hostPhase: 'HOLD' },
      spec
    )!;
    expect(rejected.title).toBe('w-1 refused the hop');
    expect(rejected.text).toMatch(/k4all-upgrade.yaml/);
    const rolled = nodeGuidance(
      { name: 'w-1', phase: 'Failed', reason: 'RollbackRebooted', hostPhase: 'HOLD' },
      spec
    )!;
    expect(rolled).toMatchObject({ title: 'w-1 rolled back', retry: false });
  });

  it('offers Retry for Abandoned and DrainTimeout', () => {
    const abandoned = nodeGuidance(
      {
        name: 'w-1',
        phase: 'Failed',
        reason: 'Abandoned',
        hostPhase: 'ABANDONED',
        release: 'v2.4.1',
      },
      spec
    )!;
    expect(abandoned).toMatchObject({
      title: 'The hop was abandoned on w-1',
      severity: 'error',
      retry: true,
    });
    expect(abandoned.text).toMatch(/stays on v2.4.1/);
    const drain = nodeGuidance(
      {
        name: 'w-1',
        phase: 'Failed',
        reason: 'DrainTimeout',
        message: 'drain timed out after 20 minutes, 3 pods left',
      },
      spec
    )!;
    expect(drain.title).toBe('Draining w-1 did not finish');
    expect(drain.text).toMatch(/then Retry. Retry drains again, for up to 20 minutes/);
    expect(drain.commands[0].command).toBe(
      'kubectl get pods -A -o wide --field-selector spec.nodeName=w-1'
    );
    expect(drain.retry).toBe(true);
  });

  it('says the upgrade waits for a node that is not Ready, without calling it a failure', () => {
    const g = nodeGuidance({ name: 'w-1', phase: 'Pending', reason: 'NodeNotReady' }, spec)!;
    expect(g).toMatchObject({
      severity: 'info',
      title: 'Waiting for w-1 to be Ready',
      retry: false,
    });
  });

  it('does not guess from the message', () => {
    const g = nodeGuidance(
      { name: 'w-1', phase: 'Failed', message: 'drain timed out after 20 minutes' },
      spec
    )!;
    expect(g).toMatchObject({ title: 'w-1 failed', retry: false });
  });

  it('has nothing to say about a healthy node', () => {
    expect(nodeGuidance({ name: 'a', phase: 'Upgrading', hostPhase: 'STAGE' }, spec)).toBeNull();
    expect(nodeGuidance({ name: 'a', phase: 'Done' }, spec)).toBeNull();
  });

  it('offers Retry only for the reasons the operator retries', () => {
    const cu = failWith(clusterUpgradeInProgress(), 'Downgrade', 'targetRelease v2.3.0 is older');
    expect(canRetry(cu)).toBe(false); // a failed plan: no node to retry
    cu.status!.nodes![1] = { name: 'cp-2', phase: 'Failed', reason: 'DrainTimeout' };
    expect(canRetry(cu)).toBe(true);
    cu.status!.nodes![1] = { name: 'cp-2', phase: 'Failed', reason: 'Abandoned' };
    expect(canRetry(cu)).toBe(true);
    cu.status!.nodes![1] = { name: 'cp-2', phase: 'Failed', reason: 'HostHold', hostPhase: 'HOLD' };
    expect(canRetry(cu)).toBe(false); // a hold resumes on the node
  });
});

describe("releasePlan (the operator's availableReleases[].path)", () => {
  it('lists the hops of the path with what each one changes', () => {
    const plan = releasePlan(clusterUpgrade(), '2.7.0');
    expect(plan.error).toBeUndefined();
    expect(plan.hops.map(h => [h.from, h.release.version, h.kind])).toEqual([
      ['v2.4.0', 'v2.4.1', 'patch'],
      ['v2.4.1', 'v2.5.0', 'minor'],
      ['v2.5.0', 'v2.6.0', 'minor'],
      ['v2.6.0', 'v2.7.0', 'minor'],
    ]);
    expect(plan.hops.map(h => h.changes)).toEqual([
      [],
      [{ what: 'Fedora', from: '43', to: '45' }],
      [],
      [
        { what: 'Kubernetes', from: '1.35.10', to: '1.36.4' },
        { what: 'CRI-O', from: '1.35', to: '1.36' },
      ],
    ]);
  });

  it('follows the path, not the list of releases', () => {
    const cu = clusterUpgrade();
    // e.g. v2.5.0 straight from v2.4.0 (minFrom v2.4.0), skipping the patch
    cu.status!.availableReleases!.find(r => r.version === 'v2.5.0')!.path = ['v2.5.0'];
    expect(releasePlan(cu, 'v2.5.0').hops.map(h => h.release.version)).toEqual(['v2.5.0']);
  });

  it('says so when the operator has no way there, or the release is not offered', () => {
    const cu = clusterUpgrade();
    cu.status!.availableReleases!.find(r => r.version === 'v2.7.0')!.path = [];
    expect(releasePlan(cu, 'v2.7.0').error).toMatch(/no way from v2.4.0 to v2.7.0/);
    expect(releasePlan(cu, 'v2.9.0').error).toMatch(/not among/);
  });

  it('compares with the current release and classifies hops like hop_kind', () => {
    expect(hopChanges({ kubernetes: '1.35.10' }, { kubernetes: 'v1.35.10' })).toEqual([]);
    expect(hopKind('v2.4.0', 'v2.4.1')).toBe('patch');
    expect(hopKind('v2.4.1', 'v2.5.0')).toBe('minor');
    expect(availableReleases('v2.6.0').map(r => r.path)).toEqual([['v2.7.0']]);
  });
});

describe('durations', () => {
  const now = Date.parse('2026-11-17T10:06:00Z');

  it('measures finished and running hops and nodes', () => {
    const cu = clusterUpgradeInProgress();
    const [done, running] = cu.status!.path!;
    expect(formatSpan(span(done.startedAt, done.completedAt, now))).toBe('took 27 min');
    expect(formatSpan(span(running.startedAt, running.completedAt, now))).toBe(
      'running for 36 min'
    );
    expect(span(undefined, undefined, now)).toBeNull();
    expect(formatSpan(null)).toBeUndefined();
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
