import { clusterConfigV270, nodeWithCapacity } from './fixtures';
import {
  actionFor,
  changedNodeFields,
  hugepageMath,
  nodeSettingsIssues,
  parseCpuSet,
  parseQuantity,
  rolloutPlan,
  rolloutView,
  withRolloutPaused,
} from './nodeSettings';
import { ClusterConfigSpec, NodesConfig } from './types';

const GiB = 1024 ** 3;

describe('quantities and cpusets', () => {
  it('parses Kubernetes quantities', () => {
    expect(parseQuantity('16303412Ki')).toBe(16303412 * 1024);
    expect(parseQuantity('16Gi')).toBe(16 * GiB);
    expect(parseQuantity('2M')).toBe(2e6);
    expect(parseQuantity('8')).toBe(8);
    expect(parseQuantity('1500m')).toBe(1.5);
    expect(parseQuantity('lots')).toBeNull();
    expect(parseQuantity(undefined)).toBeNull();
  });

  it('parses cpusets as kubelet reads them', () => {
    expect(parseCpuSet('0-1')).toEqual([0, 1]);
    expect(parseCpuSet('0,2, 4-5')).toEqual([0, 2, 4, 5]);
    expect(parseCpuSet('3')).toEqual([3]);
    expect(parseCpuSet('2-1')).toBeNull();
    expect(parseCpuSet('a-b')).toBeNull();
    expect(parseCpuSet('')).toBeNull();
  });
});

describe('the action a change makes the nodes take', () => {
  const nodes = (n: NodesConfig): NodesConfig => n;

  it('maxPods alone restarts kubelet, without a drain', () => {
    const fields = changedNodeFields(undefined, nodes({ kubelet: { maxPods: 250 } }));
    expect(fields).toEqual(['kubelet.maxPods']);
    expect(actionFor(fields)).toBe('restart');
  });

  it('CPU manager, reserved CPUs and topology drain and restart', () => {
    for (const kubelet of [
      { cpuManagerPolicy: 'static', reservedSystemCPUs: '0' },
      { topologyManagerPolicy: 'single-numa-node' },
      { topologyManagerScope: 'pod' },
    ]) {
      expect(actionFor(changedNodeFields({}, { kubelet: { maxPods: 110, ...kubelet } }))).toBe(
        'drain-restart'
      );
    }
  });

  it('hugepages and IOMMU drain and reboot, and win over the others', () => {
    expect(actionFor(changedNodeFields({}, { hugepages: { '1Gi': 4 } }))).toBe('drain-reboot');
    expect(
      actionFor(changedNodeFields({ iommu: true }, { iommu: false, kubelet: { maxPods: 200 } }))
    ).toBe('drain-reboot');
  });

  it('clearing a field is a change; pausing is not', () => {
    expect(changedNodeFields({ kubelet: { maxPods: 250 } }, {})).toEqual(['kubelet.maxPods']);
    expect(changedNodeFields({}, { rollout: { paused: true } })).toEqual([]);
    expect(actionFor([])).toBeNull();
  });
});

describe('rolloutPlan', () => {
  const nodes = [
    nodeWithCapacity('w-1', 8, 32, { worker: true, type: 'worker' }),
    nodeWithCapacity('cp-2', 8, 32, { type: 'control' }),
    nodeWithCapacity('cp-1', 8, 32, { type: 'bootstrap' }),
  ];
  const base: ClusterConfigSpec = {};

  it('goes one node at a time, bootstrap, control planes, workers, the operator node last', () => {
    const plan = rolloutPlan({
      base,
      draft: { nodes: { hugepages: { '1Gi': 2 } } },
      nodes,
      operatorNode: 'cp-1',
    });
    expect(plan.action).toBe('drain-reboot');
    expect(plan.steps.map(s => s.node)).toEqual(['cp-2', 'w-1', 'cp-1']);
    expect(plan.steps[0]).toMatchObject({ drain: 'drain', restart: 'reboot' });
    expect(plan.steps[2].note).toMatch(/runs k4all-operator/);
    expect(plan.singleNode).toBe(false);
  });

  it('restarts kubelet without a drain for maxPods only', () => {
    const plan = rolloutPlan({ base, draft: { nodes: { kubelet: { maxPods: 250 } } }, nodes });
    expect(plan.steps.map(s => [s.node, s.drain, s.restart])).toEqual([
      ['cp-1', 'none', 'kubelet'],
      ['cp-2', 'none', 'kubelet'],
      ['w-1', 'none', 'kubelet'],
    ]);
    expect(plan.summary).toMatch(/without a drain/);
  });

  it('on a single node only cordons, and the workloads stop', () => {
    const plan = rolloutPlan({
      base,
      draft: { nodes: { kubelet: { cpuManagerPolicy: 'static', reservedSystemCPUs: '0-1' } } },
      nodes: [nodes[2]],
    });
    expect(plan.singleNode).toBe(true);
    expect(plan.steps).toEqual([
      expect.objectContaining({ node: 'cp-1', drain: 'cordon', restart: 'kubelet' }),
    ]);
    expect(plan.downtime).toMatch(/workloads stop/);
  });

  it('skips nodes on a release without the node-settings agent', () => {
    const old = nodeWithCapacity('w-2', 4, 16, { worker: true });
    old.metadata.annotations = { 'k4all.magesgate.com/release': 'v2.6.6' };
    const plan = rolloutPlan({ base, draft: { nodes: { iommu: true } }, nodes: [...nodes, old] });
    expect(plan.steps.find(s => s.node === 'w-2')).toMatchObject({ skipped: true });
    expect(plan.steps.find(s => s.node === 'w-2')!.note).toMatch(/v2\.6\.6/);
  });

  it('has nothing to do when no node-level field changed', () => {
    const plan = rolloutPlan({ base, draft: { nodes: { rollout: { paused: true } } }, nodes });
    expect(plan.action).toBeNull();
    expect(plan.steps).toEqual([]);
  });
});

describe('hugepageMath', () => {
  const nodes = [nodeWithCapacity('big', 16, 64), nodeWithCapacity('small', 4, 8)];

  it('computes the share of memory per node, warning above 50 % and refusing above 80 %', () => {
    const rows = hugepageMath({ '1Gi': 4, '2Mi': 512 }, nodes);
    expect(rows).toEqual([
      { node: 'big', memoryBytes: 64 * GiB, hugepageBytes: 5 * GiB, percent: 7.8125, level: 'ok' },
      {
        node: 'small',
        memoryBytes: 8 * GiB,
        hugepageBytes: 5 * GiB,
        percent: 62.5,
        level: 'warning',
      },
    ]);
    expect(hugepageMath({ '1Gi': 7 }, nodes)[1]).toMatchObject({ percent: 87.5, level: 'error' });
    expect(hugepageMath({ '1Gi': 4 }, nodes)[1]).toMatchObject({ percent: 50, level: 'ok' });
  });

  it('cannot tell without the node memory', () => {
    const n = nodeWithCapacity('x', 4, 8);
    delete n.status!.capacity!.memory;
    expect(hugepageMath({ '1Gi': 1 }, [n])[0]).toMatchObject({ level: 'unknown', percent: null });
  });
});

describe('nodeSettingsIssues', () => {
  const nodes = [nodeWithCapacity('cp-1', 8, 32), nodeWithCapacity('w-1', 2, 8, { worker: true })];
  const issues = (n: NodesConfig, cni = 'calico') =>
    nodeSettingsIssues({ networking: { cni: { type: cni } }, nodes: n }, { nodes }).map(
      i => `${i.field} ${i.severity}: ${i.message}`
    );

  it('needs reserved CPUs with the static CPU manager, that exist on every node', () => {
    expect(issues({ kubelet: { cpuManagerPolicy: 'static' } })).toEqual([
      'reservedSystemCPUs error: The static CPU manager needs reserved CPUs.',
    ]);
    expect(issues({ kubelet: { cpuManagerPolicy: 'static', reservedSystemCPUs: '0-3' } })).toEqual([
      'reservedSystemCPUs error: w-1 has 2 CPUs (0-1): CPUs 2, 3 do not exist there.',
    ]);
    expect(issues({ kubelet: { cpuManagerPolicy: 'static', reservedSystemCPUs: '0-1' } })).toEqual([
      'reservedSystemCPUs error: w-1 has 2 CPUs: reserving all of them leaves none for pods.',
    ]);
    expect(issues({ kubelet: { reservedSystemCPUs: 'first two' } })).toEqual([
      'reservedSystemCPUs error: "first two" is not a CPU list such as 0-1 or 0,2.',
    ]);
  });

  it('keeps maxPods within the CRD range and the per-node pod CIDR of Cilium', () => {
    expect(issues({ kubelet: { maxPods: 5 } })).toEqual(['maxPods error: Max pods is 10 to 1000.']);
    expect(issues({ kubelet: { maxPods: 300 } })).toEqual([]);
    expect(issues({ kubelet: { maxPods: 300 } }, 'cilium')).toEqual([
      'maxPods error: Cilium gives each node a /24 of pod addresses: at most 250 pods.',
    ]);
  });

  it('checks hugepages against the smallest node', () => {
    expect(issues({ hugepages: { '1Gi': 5 } })).toEqual([
      'hugepages warning: Hugepages take 62.5 % of the memory of w-1: keep them at 50 % or less, or pods run short of memory.',
    ]);
    expect(issues({ hugepages: { '1Gi': 7 } })).toEqual([
      'hugepages error: Hugepages take 87.5 % of the memory of w-1: k4all-operator refuses more than 80 %.',
    ]);
    expect(issues({ hugepages: { '2Mi': -1 } })).toEqual([
      'hugepages error: Hugepage counts are whole numbers, 0 or more.',
    ]);
  });

  it('explains a topology manager without the static CPU manager', () => {
    expect(issues({ kubelet: { topologyManagerPolicy: 'restricted' } })).toEqual([
      'topologyManagerPolicy info: Without the static CPU manager the topology manager only aligns devices (and hugepages), not CPUs.',
    ]);
  });
});

describe('rolloutView', () => {
  it('reads the rollout from status.nodes and the condition', () => {
    const cc = clusterConfigV270();
    cc.spec!.nodes = { hugepages: { '1Gi': 2 }, rollout: { paused: true } };
    cc.metadata.generation = 5;
    cc.status!.observedGeneration = 5;
    cc.status!.nodes = {
      settingsHash: 'h2',
      rollout: { phase: 'Paused', message: 'paused before w-1' },
      perNode: [
        { name: 'cp-1', appliedHash: 'h2', phase: 'Done' },
        { name: 'w-1', appliedHash: 'h1', phase: 'Pending' },
      ],
    };
    cc.status!.conditions = [
      { type: 'NodeSettingsRollout', status: 'False', reason: 'Paused', message: 'paused' },
    ];
    const v = rolloutView(cc);
    expect(v).toMatchObject({
      phase: 'Paused',
      paused: true,
      stale: false,
      done: 1,
      total: 2,
      message: 'paused before w-1',
      condition: { reason: 'Paused' },
    });
    expect(v.nodes.map(n => [n.name, n.applied])).toEqual([
      ['cp-1', true],
      ['w-1', false],
    ]);
  });

  it('is idle without status.nodes', () => {
    expect(rolloutView(clusterConfigV270())).toMatchObject({ phase: 'Idle', total: 0 });
  });
});

describe('withRolloutPaused', () => {
  it('sets or removes spec.nodes.rollout.paused, leaving no empty object', () => {
    const spec: ClusterConfigSpec = { nodes: { iommu: true } };
    expect(withRolloutPaused(spec, true).nodes).toEqual({ iommu: true, rollout: { paused: true } });
    expect(withRolloutPaused(withRolloutPaused(spec, true), false).nodes).toEqual({ iommu: true });
    expect(withRolloutPaused({ nodes: { rollout: { paused: true } } }, false)).toEqual({});
  });
});
