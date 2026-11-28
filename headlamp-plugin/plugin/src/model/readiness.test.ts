import {
  barePodFinding,
  clusterUpgrade,
  clusterUpgradeWithReadiness,
  cnpgFinding,
  SEED_FINDING_KINDS as SEED_KINDS,
  vmShutdownFinding,
} from './fixtures';
import { applyOps } from './patch';
import {
  acceptAnswer,
  addApprovalOps,
  catalogEntry,
  existingApproval,
  FINDING_KINDS,
  findingAdvice,
  findingAnswers,
  findingChoices,
  findingKey,
  initialSelection,
  mergePreApproval,
  modeRows,
  readinessView,
  REMEDIATION_CATALOG,
  safeSelection,
  selectionAnswers,
  shownOptions,
  sortFindings,
  withRemediationMode,
} from './readiness';
import { ClusterUpgradeObject, Finding, RemediationApproval } from './types';

describe('the catalog of k4all-operator v0.7.0', () => {
  it('has every entry, with auto allowed only where the catalog allows it', () => {
    expect(REMEDIATION_CATALOG.map(e => [e.id, e.autoAllowed, e.hasMode])).toEqual([
      ['cnpg-disable-pdb', true, true],
      ['cnpg-maintenance-window', true, true],
      ['cnpg-add-replica', false, true],
      ['vm-migrate-first', true, true],
      ['vm-stop-start', true, true],
      ['pdb-scale-up', false, true],
      ['pdb-relax-for-node', false, true],
      ['acknowledge', false, true],
      ['ceph-wait-health', false, false],
    ]);
    for (const e of REMEDIATION_CATALOG.filter(x => !x.autoAllowed)) {
      expect(e.autoRefusal).toBeTruthy();
    }
    expect(catalogEntry('cnpg-add-replica')?.risk).toBe('None');
    expect(catalogEntry('pdb-relax-for-node')?.risk).toBe('Downtime');
  });

  it('has a label and advice for every finding kind of the seed set', () => {
    expect(Object.keys(FINDING_KINDS).sort()).toEqual([...SEED_KINDS].sort());
    for (const kind of SEED_KINDS) {
      const a = findingAdvice({
        severity: 'Info',
        kind,
        object: { kind: 'Pod', namespace: 'ns', name: 'p' },
      });
      expect(a.unknown).toBe(false);
      expect(a.label).not.toBe(kind);
      expect(a.advice).toBeTruthy();
    }
  });

  it('gives commands for the common kinds', () => {
    expect(findingAdvice(cnpgFinding()).commands.map(c => c.command)).toEqual([
      'kubectl get -n db cluster.postgresql.cnpg.io app-pg -o yaml',
    ]);
    expect(findingAdvice(barePodFinding()).commands.map(c => c.command)).toEqual([
      'kubectl delete pod -n default debug',
    ]);
    expect(
      findingAdvice(
        { severity: 'Blocks', kind: 'EvictionRefused', object: { kind: 'Pod', name: 'x' } },
        'w-1'
      ).commands.map(c => c.command)
    ).toEqual([
      'kubectl get pods -A -o wide --field-selector spec.nodeName=w-1',
      'kubectl get pdb -A',
    ]);
  });

  it('shows an unknown kind as it is', () => {
    const a = findingAdvice({
      severity: 'Disrupts',
      kind: 'KafkaRF1',
      object: { kind: 'X', name: 'y' },
    });
    expect(a).toEqual({ label: 'KafkaRF1', unknown: true, commands: [], links: [] });
  });
});

describe('answers', () => {
  it('splits the options by mode, and accepts on acknowledge or the first option', () => {
    const f = cnpgFinding();
    f.remediations![0].mode = 'auto';
    f.remediations![1].mode = 'off';
    const c = findingChoices(f);
    expect(c.auto.map(o => o.remediation)).toEqual(['cnpg-disable-pdb']);
    expect(c.off.map(o => o.remediation)).toEqual(['cnpg-maintenance-window']);
    expect(c.fixes.map(o => o.remediation)).toEqual(['cnpg-add-replica']);
    expect(c.accept?.remediation).toBe('cnpg-disable-pdb');
    expect(findingChoices(barePodFinding())).toMatchObject({
      fixes: [],
      accept: { remediation: 'acknowledge' },
    });
    expect(acceptAnswer(barePodFinding(), 'cp-2')).toEqual({
      remediation: 'acknowledge',
      target: { kind: 'Pod', namespace: 'default', name: 'debug' },
      decision: 'Accept',
      node: 'cp-2',
    });
    expect(
      findingChoices({ severity: 'Info', kind: 'EmptyDir', object: { kind: 'Pod', name: 'x' } })
        .accept
    ).toBeUndefined();
  });

  it('finds the answers given for the release, for the node or every node', () => {
    const f = vmShutdownFinding('gpu-01');
    const approvals: RemediationApproval[] = [
      { remediation: 'vm-stop-start', target: f.object, release: 'v2.5.0' },
      {
        remediation: 'vm-stop-start',
        target: f.object,
        release: 'v2.6.0',
        decision: 'Accept',
        node: 'cp-2',
      },
    ];
    expect(findingAnswers(approvals, f, { release: 'v2.5.0' }, 'cp-1')).toEqual({
      applied: ['vm-stop-start'],
      accepted: false,
    });
    expect(findingAnswers(approvals, f, { release: 'v2.6.0' }, 'cp-2')).toEqual({
      applied: [],
      accepted: true,
    });
    // An answer for another node, or another release, does not count
    expect(findingAnswers(approvals, f, { release: 'v2.6.0' }, 'cp-1').accepted).toBe(false);
    expect(
      existingApproval(approvals, f.remediations![0], { settingsHash: '0123456789abcdef' }, 'cp-1')
    ).toBeUndefined();
  });
});

describe('addApprovalOps', () => {
  const approval: RemediationApproval = {
    remediation: 'cnpg-disable-pdb',
    target: cnpgFinding().object,
    decision: 'Apply',
    release: 'v2.6.0',
  };

  it('appends to spec.approvals without a precondition', () => {
    const cu: ClusterUpgradeObject = {
      ...clusterUpgrade(),
      spec: { targetRelease: 'v2.6.0', approvals: [{ ...approval, remediation: 'x' }] },
    };
    const ops = addApprovalOps(cu, ['spec', 'approvals'], approval);
    expect(ops).toEqual([{ op: 'add', path: '/spec/approvals/-', value: approval }]);
    expect(applyOps(cu, ops).spec?.approvals).toHaveLength(2);
    // the same answer again: nothing to send
    expect(addApprovalOps(applyOps(cu, ops), ['spec', 'approvals'], approval)).toEqual([]);
  });

  it('creates the list under a generation test when there is none', () => {
    const cu = clusterUpgrade();
    cu.spec = { targetRelease: 'v2.6.0', drain: { timeoutMinutes: 30 } };
    expect(addApprovalOps(cu, ['spec', 'approvals'], approval)).toEqual([
      { op: 'test', path: '/metadata/generation', value: 1 },
      { op: 'add', path: '/spec/approvals', value: [approval] },
    ]);
  });

  it("creates the rollout's approvals below spec.nodes", () => {
    const cc = { metadata: { name: 'c', generation: 7 }, spec: { nodes: { iommu: true } } };
    const a = { ...approval, release: undefined, settingsHash: '0123456789abcdef' };
    expect(addApprovalOps(cc, ['spec', 'nodes', 'rollout', 'approvals'], a)).toEqual([
      { op: 'test', path: '/metadata/generation', value: 7 },
      { op: 'add', path: '/spec/nodes/rollout', value: { approvals: [a] } },
    ]);
  });
});

describe('pre-approve', () => {
  const report = clusterUpgradeWithReadiness().status!.readiness!;

  it('starts from the approvals of the release being started', () => {
    const gpu = vmShutdownFinding('gpu-01').object;
    const sel = initialSelection(
      report,
      [
        { remediation: 'vm-stop-start', target: gpu, release: 'v2.6.0' },
        { remediation: 'vm-stop-start', target: gpu, release: 'v2.5.0', decision: 'Accept' },
      ],
      { release: 'v2.6.0' }
    );
    expect(sel).toEqual({
      [findingKey('cp-1', vmShutdownFinding('gpu-01'))]: {
        apply: ['vm-stop-start'],
        accept: false,
      },
    });
  });

  it('approves all safe fixes: risk None only, one per finding that blocks, never Go on', () => {
    const sel = safeSelection(report, {});
    const answers = selectionAnswers(report, sel);
    expect(answers.map(a => `${a.remediation} ${a.target.name}`)).toEqual([
      'cnpg-add-replica app-pg',
      'vm-migrate-first web-01',
    ]);
    // gpu-01 has only vm-stop-start (Downtime), cache-0 only acknowledge: left alone
    expect(sel[findingKey('cp-1', vmShutdownFinding('gpu-01'))]).toBeUndefined();
  });

  it('replaces only the answers of the options shown, for the release', () => {
    const gpu = vmShutdownFinding('gpu-01').object;
    const existing: RemediationApproval[] = [
      { remediation: 'vm-stop-start', target: gpu, release: 'v2.6.0' }, // shown: replaced
      { remediation: 'vm-stop-start', target: gpu, release: 'v2.5.0' }, // other release: kept
      {
        remediation: 'pdb-scale-up',
        target: { group: 'apps', kind: 'Deployment', namespace: 'shop', name: 'api' },
        release: 'v2.6.0',
      }, // not in the report: kept
    ];
    const cnpg = cnpgFinding();
    const merged = mergePreApproval(existing, {
      release: 'v2.6.0',
      shown: shownOptions(report),
      answers: [
        { remediation: 'cnpg-add-replica', target: cnpg.object, decision: 'Apply' },
        {
          remediation: 'acknowledge',
          target: { kind: 'Pod', namespace: 'shop', name: 'cache-0' },
          decision: 'Accept',
          node: 'cp-1',
        },
      ],
    });
    expect(merged).toEqual([
      existing[1],
      existing[2],
      {
        remediation: 'cnpg-add-replica',
        target: cnpg.object,
        decision: 'Apply',
        release: 'v2.6.0',
      },
      {
        remediation: 'acknowledge',
        target: { kind: 'Pod', namespace: 'shop', name: 'cache-0' },
        decision: 'Accept',
        node: 'cp-1',
        release: 'v2.6.0',
      },
    ]);
  });

  it('keeps an unchanged answer as it was written', () => {
    const gpu = vmShutdownFinding('gpu-01').object;
    const byHand: RemediationApproval = {
      remediation: 'vm-stop-start',
      target: gpu,
      node: 'cp-1',
      release: 'v2.6.0',
    };
    const merged = mergePreApproval([byHand], {
      release: 'v2.6.0',
      shown: shownOptions(report),
      answers: [{ remediation: 'vm-stop-start', target: gpu, decision: 'Apply' }],
    });
    expect(merged).toEqual([byHand]);
  });
});

describe('readinessView', () => {
  const report = clusterUpgradeWithReadiness().status!.readiness!;

  it("takes the operator's headline, per hop, Blocks first", () => {
    const v = readinessView(report, { release: 'v2.7.0' });
    expect(v.headline).toBe(
      '1 thing will stop the upgrade; 2 VMs will shut down, 1 of them until its node is back'
    );
    expect(v.perHop).toBe(true);
    expect(v.otherRelease).toBeUndefined();
    expect(v.nodes[0].findings.map(f => f.kind)).toEqual([
      'CNPGSingleInstance',
      'VMShutdown',
      'PinnedToNode',
      'EmptyDir',
      'CephDaemonsHere',
    ]);
  });

  it('says when the report is for another release', () => {
    expect(readinessView(report, { release: 'v2.5.0' }).otherRelease).toBe('v2.7.0');
  });

  it('builds a headline from the counts without a message', () => {
    expect(
      readinessView({ summary: { blocks: 2, vmShutdowns: 3, vmsDownUntilNodeBack: 1 } }).headline
    ).toBe('2 things will stop the upgrade, 3 VMs will shut down, 1 until their node is back');
    expect(readinessView({ summary: {} }).headline).toBe('Nothing stops or disrupts the upgrade');
  });

  it("marks the node Headlamp's pod runs on, and a Headlamp pinned there", () => {
    expect(readinessView(report, { headlampNode: 'cp-2' }).nodes.map(n => n.headlamp)).toEqual([
      undefined,
      'moves',
      undefined,
    ]);
    const pinned = clusterUpgradeWithReadiness().status!.readiness!;
    pinned.nodes![2].findings!.push({
      severity: 'Disrupts',
      kind: 'PinnedToNode',
      object: { group: 'apps', kind: 'Deployment', namespace: 'headlamp', name: 'headlamp' },
    });
    expect(readinessView(pinned, { headlampNode: 'w-1' }).nodes[2].headlamp).toBe('pinned');
  });

  it('sorts findings by severity, keeping the order within one', () => {
    const f = (severity: string, name: string): Finding => ({
      severity,
      kind: 'X',
      object: { kind: 'Pod', name },
    });
    expect(
      sortFindings([f('Info', 'a'), f('Blocks', 'b'), f('Disrupts', 'c'), f('Blocks', 'd')]).map(
        x => x.object.name
      )
    ).toEqual(['b', 'd', 'c', 'a']);
  });
});

describe('remediation modes (ClusterConfig spec.upgrades.remediations)', () => {
  it('writes auto and off, and removes ask (the default) with what it leaves empty', () => {
    const spec = withRemediationMode({}, 'vm-stop-start', 'auto');
    expect(spec).toEqual({ upgrades: { remediations: { 'vm-stop-start': 'auto' } } });
    const off = withRemediationMode(spec, 'pdb-relax-for-node', 'off');
    expect(off.upgrades?.remediations).toEqual({
      'vm-stop-start': 'auto',
      'pdb-relax-for-node': 'off',
    });
    expect(withRemediationMode(spec, 'vm-stop-start', 'ask')).toEqual({});
  });

  it('lists the catalog, then the ids it does not know, with auto refused where not allowed', () => {
    const rows = modeRows({
      upgrades: { remediations: { 'pdb-scale-up': 'auto', 'zalando-add-replica': 'ask' } },
    });
    expect(rows.map(r => r.id)).toEqual([
      ...REMEDIATION_CATALOG.map(e => e.id),
      'zalando-add-replica',
    ]);
    expect(rows.find(r => r.id === 'pdb-scale-up')).toMatchObject({
      mode: 'auto',
      autoRefused: true,
    });
    expect(rows.find(r => r.id === 'zalando-add-replica')?.entry).toBeUndefined();
  });
});
