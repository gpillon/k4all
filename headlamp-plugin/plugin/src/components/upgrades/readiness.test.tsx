/*
 * Rendering tests of upgrade readiness (k4all-operator v0.7.0): a finding of
 * every kind of the seed set and an unknown one, "Before you upgrade" with
 * nothing, with what blocks and over several hops, Check again, the
 * pre-approve step of the start review (its answers, Approve all safe
 * fixes), the live blockers (Apply fix, Accept with its confirmation), every
 * node reason, "What k4all changed" (Put back now after its confirmation),
 * and the whole page as a viewer and with an operator before v0.7.0.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { useHeadlampNode } from '../../api/clusterObjects';
import {
  useCanPatchClusterUpgrade,
  useClusterUpgrade,
  useClusterUpgradeServed,
  useK4allData,
  useNow,
} from '../../api/hooks';
import {
  barePodFinding,
  clusterConfigV270,
  clusterUpgradeBlocked,
  clusterUpgradeInProgress,
  clusterUpgradeWithReadiness,
  cnpgFinding,
  node,
  releaseManifestV270,
  releaseManifestV272,
  SEED_FINDING_KINDS as SEED_KINDS,
} from '../../model/fixtures';
import { readinessView } from '../../model/readiness';
import { ClusterUpgradeObject, Finding, NodeLike, NodeUpgradeReason } from '../../model/types';
import { describeUpgradeChanges, desiredSpec, intentOps, upgradeView } from '../../model/upgrades';
import { FindingView, ReadinessPanel, RemediationsTable } from './readiness';
import { UpgradeProgressPanel } from './UpgradeProgress';
import { UpgradeReviewDialog } from './UpgradeReviewDialog';
import { UpgradesPage } from './UpgradesPage';
import { ReviewIntent, UpgradeFlow, useUpgradeFlow } from './useUpgradeFlow';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  Link: (props: { children: React.ReactNode }) => <a href="#node">{props.children}</a>,
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Router: { createRouteURL: (name: string) => `/c/main/${name}` },
  Utils: { timeAgo: () => '1 min' },
}));
vi.mock('../../api/hooks', () => ({
  useCanPatchClusterUpgrade: vi.fn(),
  useClusterUpgrade: vi.fn(),
  useClusterUpgradeServed: vi.fn(),
  useK4allData: vi.fn(),
  useNow: vi.fn(),
}));
vi.mock('../../api/clusterObjects', () => ({ useHeadlampNode: vi.fn() }));
vi.mock('../../api/k4allApi', () => ({}));
vi.mock('./useUpgradeFlow', () => ({ useUpgradeFlow: vi.fn() }));
vi.mock('../../api/live', () => ({
  useLiveStatus: () => ({
    updatedAt: null,
    down: false,
    downSince: null,
    intervalMs: 60000,
    refresh: () => undefined,
  }),
}));

const NOW = Date.parse('2026-11-17T10:06:00Z');

function nodes(): NodeLike[] {
  return [
    node('cp-1', { annotations: { 'k4all.magesgate.com/node-type': 'bootstrap' } }),
    node('cp-2', { annotations: { 'k4all.magesgate.com/node-type': 'control' } }),
    node('w-1', { labels: {}, annotations: { 'k4all.magesgate.com/node-type': 'worker' } }),
  ];
}

function flowStub(phase: UpgradeFlow['phase'] = { kind: 'idle' }): UpgradeFlow {
  return {
    phase,
    review: vi.fn(),
    apply: vi.fn(),
    close: vi.fn(),
    act: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    checkReadiness: vi.fn(async () => true),
    checking: false,
    approve: vi.fn(async () => true),
    restore: vi.fn(async () => true),
    busy: null,
  };
}

/** The labels of the buttons that write: none of them for a viewer. */
const WRITE_BUTTON =
  /^(Check again|Check now|Checking…|Apply fix|Accept|Put back now|Approve all safe fixes|Retry|Pre-approve)/;

function writeButtons(container: HTMLElement = document.body): string[] {
  return within(container)
    .queryAllByRole('button')
    .map(b => b.getAttribute('aria-label') || b.textContent || '')
    .filter(name => WRITE_BUTTON.test(name));
}

describe('FindingView', () => {
  it.each(SEED_KINDS)('shows a %s finding with its label, kind, object and message', kind => {
    const f: Finding = {
      severity: kind === 'CNPGSingleInstance' ? 'Blocks' : 'Disrupts',
      kind,
      object: { kind: 'Pod', namespace: 'shop', name: 'web-1' },
      message: `the operator's words about ${kind}`,
    };
    render(<FindingView finding={f} node="w-1" controls={{ kind: 'view' }} />);
    const group = screen.getByRole('group', { name: `${kind} Pod shop/web-1` });
    expect(within(group).getByText(kind)).toBeTruthy();
    expect(within(group).getByText(`the operator's words about ${kind}`)).toBeTruthy();
    expect(within(group).getByText('Pod shop/web-1')).toBeTruthy();
  });

  it('shows a kind it does not know with its severity, kind and message', () => {
    render(
      <FindingView
        finding={{
          severity: 'Blocks',
          kind: 'KafkaMinISR',
          object: { group: 'kafka.strimzi.io', kind: 'KafkaTopic', namespace: 'k', name: 'orders' },
          message: 'min.insync.replicas equals the replicas',
        }}
        node="w-1"
        controls={{ kind: 'view' }}
      />
    );
    expect(screen.getByText('KafkaMinISR')).toBeTruthy();
    expect(screen.getByText('Blocks: stops the drain')).toBeTruthy();
    expect(screen.getByText('min.insync.replicas equals the replicas')).toBeTruthy();
    expect(screen.getByText(/A finding kind this addon does not know/)).toBeTruthy();
  });

  it('shows the risk, mode and summary of each fix, and that auto needs no answer', () => {
    const f = cnpgFinding();
    f.remediations![1].mode = 'auto';
    f.remediations![2].mode = 'off';
    render(<FindingView finding={f} node="cp-1" controls={{ kind: 'view' }} />);
    expect(screen.getByText('CloudNativePG: no budget for the hop')).toBeTruthy();
    expect(screen.getAllByText('downtime')).toHaveLength(2);
    expect(screen.getByText('no downtime')).toBeTruthy();
    expect(screen.getByText('k4all does it by itself')).toBeTruthy();
    expect(screen.getByText(/off in Settings → Upgrades: reported only/)).toBeTruthy();
    expect(screen.getByText(/instances 1 -> 2 before the hop/)).toBeTruthy();
  });
});

describe('ReadinessPanel (Before you upgrade)', () => {
  it('says nothing is in the way when no node has a finding', () => {
    const view = readinessView({
      checkedAt: '2026-11-17T10:00:00Z',
      release: 'v2.5.0',
      hops: 1,
      summary: {},
      nodes: [{ name: 'cp-1', findings: [] }],
    });
    render(<ReadinessPanel view={view} now={NOW} checking={false} />);
    expect(screen.getByText('Nothing stops or disrupts the upgrade')).toBeTruthy();
    expect(screen.getByText(/checked 6 min ago/)).toBeTruthy();
    expect(screen.getByText(/without dry-run evictions/)).toBeTruthy();
    expect(screen.getByText(/move everything with at most a restart/)).toBeTruthy();
    expect(screen.queryByText(/per hop/)).toBeNull();
  });

  it('puts what blocks first, folds what only informs, counts what was left out', () => {
    const report = clusterUpgradeWithReadiness().status!.readiness!;
    report.hops = 1;
    render(<ReadinessPanel view={readinessView(report)} now={NOW} checking={false} />);
    expect(
      screen.getByText(
        '1 thing will stop the upgrade; 2 VMs will shut down per hop, 1 of them until their node is back'
      )
    ).toBeTruthy();
    const cp1 = screen.getByRole('region', { name: 'Readiness of cp-1' });
    const groups = within(cp1).getAllByRole('group');
    expect(groups[0].getAttribute('aria-label')).toBe('CNPGSingleInstance Cluster db/app-pg');
    expect(within(cp1).getByText('2 things to know')).toBeTruthy();
    expect(screen.getByText(/2 more findings left out of the report/)).toBeTruthy();
    // view only: no fix controls
    expect(writeButtons()).toEqual([]);
  });

  it('says the counts are per hop over several hops', () => {
    const report = clusterUpgradeWithReadiness().status!.readiness!;
    const { unmount } = render(
      <ReadinessPanel view={readinessView(report)} now={NOW} checking={false} />
    );
    // the operator's sentence says it once
    expect(screen.getAllByText(/per hop/)).toHaveLength(1);
    expect(screen.getByText(/in 4 hops: every hop drains and reboots every node/)).toBeTruthy();
    expect(screen.getByText(/with dry-run evictions/)).toBeTruthy();
    unmount();
    // a sentence built from the counts says it too
    delete report.message;
    render(<ReadinessPanel view={readinessView(report)} now={NOW} checking={false} />);
    expect(screen.getByText(/, per hop$/)).toBeTruthy();
  });

  it('asks for a new check, and shows checking meanwhile', () => {
    const onCheck = vi.fn();
    const view = readinessView(clusterUpgradeWithReadiness().status!.readiness!);
    const { rerender } = render(
      <ReadinessPanel view={view} now={NOW} checking={false} onCheck={onCheck} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    rerender(<ReadinessPanel view={view} now={NOW} checking onCheck={onCheck} />);
    expect((screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('warns on the node that runs this page, and how to follow from kubectl', () => {
    const view = readinessView(clusterUpgradeWithReadiness().status!.readiness!, {
      headlampNode: 'cp-2',
    });
    render(<ReadinessPanel view={view} now={NOW} checking={false} />);
    const cp2 = screen.getByRole('region', { name: 'Readiness of cp-2' });
    expect(within(cp2).getByText('This page runs on cp-2')).toBeTruthy();
    expect(within(cp2).getByText('kubectl get clusterupgrade k4all -w')).toBeTruthy();
    expect(
      within(cp2).getByText('kubectl get events --field-selector involvedObject.name=k4all')
    ).toBeTruthy();
  });
});

function startReview(cu: ClusterUpgradeObject, intent: ReviewIntent): UpgradeFlow {
  const desired = desiredSpec(cu, intent);
  return flowStub({
    kind: 'review',
    data: {
      intent,
      base: cu,
      desired,
      ops: intentOps(cu, intent),
      result: { ...cu, spec: desired },
      items: describeUpgradeChanges(cu.spec ?? {}, desired),
    },
  });
}

describe('UpgradeReviewDialog: Before you upgrade, then the plan', { timeout: 20000 }, () => {
  it('turns the chosen fixes into approvals for the release being started', () => {
    const cu = clusterUpgradeWithReadiness();
    const flow = startReview(cu, { kind: 'start', target: 'v2.7.0' });
    render(
      <UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} readiness now={NOW} />
    );
    const answer = screen.getByRole('radiogroup', { name: 'Answer for Cluster db/app-pg on cp-1' });
    expect(
      (within(answer).getByRole('radio', { name: 'Fix it myself' }) as HTMLInputElement).checked
    ).toBe(true);
    fireEvent.click(within(answer).getByRole('radio', { name: /CloudNativePG: a replica first/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again with these options' }));
    const intent = vi.mocked(flow.review).mock.calls[0][0] as Extract<
      ReviewIntent,
      { kind: 'start' }
    >;
    expect(intent.approvals?.answers).toEqual([
      { remediation: 'cnpg-add-replica', target: cnpgFinding().object, decision: 'Apply' },
    ]);
    // the next dry run writes it with the release being started
    const ops = intentOps(cu, intent);
    expect(ops[0]).toEqual({ op: 'test', path: '/metadata/generation', value: 1 });
    expect(ops).toContainEqual({
      op: 'add',
      path: '/spec/approvals',
      value: [
        {
          remediation: 'cnpg-add-replica',
          target: cnpgFinding().object,
          decision: 'Apply',
          release: 'v2.7.0',
        },
      ],
    });
  });

  it('approves all safe fixes: only those without downtime', () => {
    const cu = clusterUpgradeWithReadiness();
    const flow = startReview(cu, { kind: 'start', target: 'v2.7.0' });
    render(
      <UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} readiness now={NOW} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve all safe fixes' }));
    expect(
      (screen.getByRole('radio', { name: /CloudNativePG: a replica first/ }) as HTMLInputElement)
        .checked
    ).toBe(true);
    const cp2 = screen.getByRole('region', { name: 'Readiness of cp-2' });
    const boxes = within(cp2).getAllByRole('checkbox') as HTMLInputElement[];
    const byLabel = (re: RegExp) =>
      boxes.find(b => re.test(b.closest('label')?.textContent ?? ''))!;
    expect(byLabel(/Move the VM live first/).checked).toBe(true);
    expect(byLabel(/Stop the VM cleanly/).checked).toBe(false);
    expect(byLabel(/Accept: the disruption happens/).checked).toBe(false);
    const cp1 = screen.getByRole('region', { name: 'Readiness of cp-1' });
    for (const b of within(cp1).getAllByRole('checkbox') as HTMLInputElement[]) {
      expect(b.checked).toBe(false); // gpu-01 only stops with downtime; cache-0 only accepts
    }
  });

  it('says when the report is for another release', () => {
    const cu = clusterUpgradeWithReadiness();
    const flow = startReview(cu, { kind: 'start', target: 'v2.5.0' });
    render(
      <UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} readiness now={NOW} />
    );
    expect(screen.getByText(/This report is for v2.7.0, not v2.5.0/)).toBeTruthy();
  });

  it('has no first step without the capability', () => {
    const cu = clusterUpgradeWithReadiness();
    const flow = startReview(cu, { kind: 'start', target: 'v2.7.0' });
    render(<UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} now={NOW} />);
    expect(screen.queryByText('Before you upgrade')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Ask also for disruptions' })).toBeNull();
  });
});

describe('live blockers', { timeout: 20000 }, () => {
  function renderBlocked(flow = flowStub(), canPatch = true, readiness = true) {
    const cu = clusterUpgradeBlocked();
    render(
      <UpgradeProgressPanel
        cu={cu}
        view={upgradeView(cu)}
        nodes={nodes()}
        flow={flow}
        canPatch={canPatch}
        now={NOW}
        readiness={readiness}
      />
    );
    return flow;
  }

  it('Apply fix adds one approval', () => {
    const flow = renderBlocked();
    const held = screen.getByRole('region', { name: 'What holds cp-2' });
    expect(within(held).getByText('cp-2')).toBeTruthy();
    fireEvent.click(
      within(held).getByRole('button', {
        name: 'Apply fix cnpg-disable-pdb for Cluster db/app-pg',
      })
    );
    expect(flow.approve).toHaveBeenCalledTimes(1);
    expect(flow.approve).toHaveBeenCalledWith({
      remediation: 'cnpg-disable-pdb',
      target: cnpgFinding().object,
      decision: 'Apply',
    });
  });

  it('Accept on what blocks asks first: the node is drained anyway', () => {
    const flow = renderBlocked();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Cluster db/app-pg on cp-2' }));
    expect(flow.approve).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Go on without a fix?' });
    expect(
      within(dialog).getByText(/cordoned and drained anyway, up to the drain timeout/)
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and drain' }));
    // Accept is written for the finding's first option, for this node only
    expect(flow.approve).toHaveBeenCalledWith({
      remediation: 'cnpg-disable-pdb',
      target: cnpgFinding().object,
      decision: 'Accept',
      node: 'cp-2',
    });
  });

  it('Accept on a pod that declares no controller says the drain deletes it', () => {
    const flow = renderBlocked();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Pod default/debug on cp-2' }));
    expect(flow.approve).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Go on without a fix?' });
    expect(
      within(dialog).getByText(/the drain deletes Pod default\/debug, and nothing recreates it/)
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and drain' }));
    expect(flow.approve).toHaveBeenCalledWith({
      remediation: 'acknowledge',
      target: barePodFinding().object,
      decision: 'Accept',
      node: 'cp-2',
    });
  });

  it('shows an answer already given instead of its button', () => {
    const cu = clusterUpgradeBlocked();
    cu.spec!.approvals = [
      { remediation: 'cnpg-disable-pdb', target: cnpgFinding().object, release: 'v2.6.0' },
    ];
    render(
      <UpgradeProgressPanel
        cu={cu}
        view={upgradeView(cu)}
        nodes={nodes()}
        flow={flowStub()}
        canPatch
        now={NOW}
        readiness
      />
    );
    expect(screen.getByText('approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Apply fix cnpg-disable-pdb/ })).toBeNull();
  });

  it('a viewer sees the blockers and no button', () => {
    renderBlocked(flowStub(), false);
    expect(screen.getByRole('region', { name: 'What holds cp-2' })).toBeTruthy();
    expect(writeButtons()).toEqual([]);
  });

  const REASONS: [NodeUpgradeReason, string, string][] = [
    ['HostHold', 'Failed', 'cp-2 is on hold'],
    ['TargetRejected', 'Failed', 'cp-2 refused the hop'],
    ['RollbackRebooted', 'Failed', 'cp-2 rolled back'],
    ['Abandoned', 'Failed', 'The hop was abandoned on cp-2'],
    ['DrainTimeout', 'Failed', 'Draining cp-2 did not finish'],
    ['NodeNotReady', 'Pending', 'Waiting for cp-2 to be Ready'],
    ['DrainBlocked', 'Pending', 'cp-2 cannot be drained'],
    ['WaitingForApproval', 'Pending', 'cp-2 waits for your answer'],
    ['Remediating', 'Pending', 'Applying fixes before the drain of cp-2'],
    ['Restoring', 'Done', 'Putting back what k4all changed for cp-2'],
    ['RestoreFailed', 'Done', 'Putting back a fix failed for cp-2'],
  ];
  it.each(REASONS)('guides a node with reason %s', (reason, phase, title) => {
    const cu = clusterUpgradeBlocked();
    cu.status!.nodes![1] = {
      ...cu.status!.nodes![1],
      phase,
      reason,
      hostPhase: phase === 'Failed' ? 'HOLD' : undefined,
    };
    const flow = flowStub();
    render(
      <UpgradeProgressPanel
        cu={cu}
        view={upgradeView(cu)}
        nodes={nodes()}
        flow={flow}
        canPatch
        now={NOW}
        readiness
      />
    );
    expect(screen.getByText(title)).toBeTruthy();
    const retry = ['Abandoned', 'DrainTimeout', 'RestoreFailed'].includes(reason);
    expect(screen.queryAllByRole('button', { name: 'Retry' }).length > 0).toBe(
      retry && (phase === 'Failed' || reason === 'RestoreFailed')
    );
  });
});

describe('What k4all changed', () => {
  const records = clusterUpgradeBlocked().status!.remediations!;

  it('lists the records, and puts one back after the confirmation', () => {
    const onRestore = vi.fn();
    render(<RemediationsTable records={records} now={NOW} onRestore={onRestore} />);
    const rows = within(screen.getByRole('table', { name: 'What k4all changed' })).getAllByRole(
      'row'
    );
    expect(
      rows.slice(1).map(r =>
        within(r)
          .getAllByRole('cell')
          .slice(0, 5)
          .map(c => c.textContent)
      )
    ).toEqual([
      [
        'VirtualMachine lab/gpu-01',
        'Stop the VM cleanly, start it after',
        'cp-1',
        'v2.5.0',
        'approval',
      ],
      ['VirtualMachine lab/web-01', 'Move the VM live first', 'cp-1', 'v2.5.0', 'auto'],
    ]);
    expect(screen.getByText('set spec.runStrategy Halted (was Always)')).toBeTruthy();
    // a record already put back has no button
    expect(screen.getAllByRole('button', { name: /^Put back/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Put back rm-4c1f9a now' }));
    expect(onRestore).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Put back now?' });
    expect(within(dialog).getByText(/for a node that is not coming back/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Put back now' }));
    expect(onRestore).toHaveBeenCalledWith(records[0]);
  });

  it('has no button for a viewer', () => {
    render(<RemediationsTable records={records} now={NOW} />);
    expect(writeButtons()).toEqual([]);
  });
});

describe('UpgradesPage', { timeout: 20000 }, () => {
  function renderPage(cu: ClusterUpgradeObject, opts: { canPatch: boolean; v272: boolean }) {
    vi.mocked(useK4allData).mockReturnValue({
      cc: clusterConfigV270(),
      rm: opts.v272 ? releaseManifestV272() : releaseManifestV270(),
      extraClusterConfigs: [],
      nodes: nodes(),
      nodeConfigs: [],
      loading: false,
      crdsMissing: false,
      error: null,
    });
    vi.mocked(useClusterUpgradeServed).mockReturnValue(true);
    vi.mocked(useClusterUpgrade).mockReturnValue({ cu, loading: false, error: null });
    vi.mocked(useCanPatchClusterUpgrade).mockReturnValue(opts.canPatch);
    vi.mocked(useNow).mockReturnValue(NOW);
    vi.mocked(useHeadlampNode).mockReturnValue({ node: 'w-1', denied: false, loading: false });
    const flow = flowStub();
    vi.mocked(useUpgradeFlow).mockReturnValue(flow);
    render(<UpgradesPage />);
    return flow;
  }

  function withReport(cu: ClusterUpgradeObject): ClusterUpgradeObject {
    cu.status!.readiness = clusterUpgradeWithReadiness().status!.readiness;
    return cu;
  }

  it('shows the Blocked condition, the report, the blockers and the records', () => {
    const flow = renderPage(withReport(clusterUpgradeBlocked()), { canPatch: true, v272: true });
    expect(screen.getByText('The next node waits for your answer')).toBeTruthy();
    expect(
      screen.getByText('cp-2 waits for an answer to cnpg-disable-pdb for db/app-pg')
    ).toBeTruthy();
    expect(screen.getByText('Before you upgrade')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'What holds cp-2' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'What k4all changed' })).toBeTruthy();
    // while an upgrade runs, the report's fixes are answered at once
    const cp1 = screen.getByRole('region', { name: 'Readiness of cp-1' });
    fireEvent.click(
      within(cp1).getByRole('button', {
        name: 'Apply fix vm-stop-start for VirtualMachine lab/gpu-01',
      })
    );
    expect(flow.approve).toHaveBeenCalledWith({
      remediation: 'vm-stop-start',
      target: { group: 'kubevirt.io', kind: 'VirtualMachine', namespace: 'lab', name: 'gpu-01' },
      decision: 'Apply',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(flow.checkReadiness).toHaveBeenCalled();
  });

  it('a viewer sees the report, the blockers and the records, and no button of them', () => {
    renderPage(withReport(clusterUpgradeBlocked()), { canPatch: false, v272: true });
    expect(screen.getByText('Before you upgrade')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'What holds cp-2' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'What k4all changed' })).toBeTruthy();
    expect(writeButtons()).toEqual([]);
  });

  it("with an older operator: no new panel, no new control, and the drain's text advised", () => {
    const cu = clusterUpgradeInProgress();
    cu.status!.nodes![1] = {
      ...cu.status!.nodes![1],
      phase: 'Pending',
      message:
        'cannot be drained: PDB db/app-pg-primary allows no disruption of pod db/app-pg-1 ' +
        '(a single-instance CloudNativePG cluster? see docs/upgrades.md, Drains that never end); ' +
        'the node is not cordoned',
    };
    delete cu.status!.nodes![1].drainStartedAt;
    renderPage(cu, { canPatch: true, v272: false });
    expect(screen.getByText('cp-2 cannot be drained')).toBeTruthy();
    expect(screen.getByText('kubectl get pdb -n db app-pg-primary -o yaml')).toBeTruthy();
    expect(screen.queryByText('Before you upgrade')).toBeNull();
    expect(screen.queryByText('What k4all changed')).toBeNull();
    expect(writeButtons().filter(b => b !== 'Retry')).toEqual([]);
  });

  it('hides the new controls without the capability, even when the status has the fields', () => {
    renderPage(withReport(clusterUpgradeBlocked()), { canPatch: true, v272: false });
    expect(screen.queryByText('Before you upgrade')).toBeNull();
    expect(screen.queryByRole('region', { name: 'What holds cp-2' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'What k4all changed' })).toBeNull();
    expect(writeButtons()).toEqual([]);
  });
});
