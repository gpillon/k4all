/*
 * Rendering tests of the Upgrades page parts: the release list, the review
 * dialog (path, order, drain, downtime, acknowledgement, drain options), the
 * progress panel (guidance, pause, stop, retry), the states without
 * ClusterUpgrade, and the Overview card.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { K4allData } from '../../api/hooks';
import {
  clusterConfigNginx,
  clusterUpgrade,
  clusterUpgradeInProgress,
  node,
  releaseManifest,
  releaseManifestNginx,
} from '../../model/fixtures';
import { ClusterUpgradeObject, NodeLike } from '../../model/types';
import { describeUpgradeChanges, desiredSpec, intentOps, upgradeView } from '../../model/upgrades';
import { ReleaseList } from './ReleaseList';
import { UpgradeProgressPanel } from './UpgradeProgress';
import { UpgradeReviewDialog } from './UpgradeReviewDialog';
import { UpgradeSummary } from './UpgradesCard';
import { ClusterUpgradeUnavailable } from './UpgradesPage';
import { ReviewIntent, UpgradeFlow } from './useUpgradeFlow';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  Link: (props: { children: React.ReactNode }) => <a href="#node">{props.children}</a>,
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Router: { createRouteURL: (name: string) => `/c/main/${name}` },
}));
// The data hooks and API need Headlamp's runtime; these tests pass data in directly.
vi.mock('../../api/hooks', () => ({
  useCanPatchClusterUpgrade: vi.fn(),
  useClusterUpgrade: vi.fn(),
  useClusterUpgradeServed: vi.fn(),
  useK4allData: vi.fn(),
  useNow: vi.fn(),
}));
vi.mock('../../api/k4allApi', () => ({}));
vi.mock('../../api/live', () => ({
  useLiveStatus: () => ({
    updatedAt: null,
    down: false,
    downSince: null,
    intervalMs: 60000,
    refresh: () => undefined,
  }),
}));

function nodes(): NodeLike[] {
  const v240 = (n: NodeLike) => {
    n.status!.nodeInfo = {
      kubeletVersion: 'v1.35.10',
      osImage: 'Fedora Linux 43 (k4all)',
      containerRuntimeVersion: 'cri-o://1.35.2',
    };
    return n;
  };
  return [
    v240(node('cp-1', { annotations: { 'k4all.magesgate.com/node-type': 'bootstrap' } })),
    v240(node('cp-2', { annotations: { 'k4all.magesgate.com/node-type': 'control' } })),
    v240(node('w-1', { labels: {}, annotations: { 'k4all.magesgate.com/node-type': 'worker' } })),
  ];
}

function flowStub(phase: UpgradeFlow['phase']): UpgradeFlow {
  return {
    phase,
    review: vi.fn(),
    apply: vi.fn(),
    close: vi.fn(),
    act: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    busy: null,
  };
}

function reviewPhase(cu: ClusterUpgradeObject, intent: ReviewIntent): UpgradeFlow['phase'] {
  const desired = desiredSpec(cu, intent);
  return {
    kind: 'review',
    data: {
      intent,
      base: cu,
      desired,
      ops: intentOps(cu, intent),
      result: { ...cu, spec: desired },
      items: describeUpgradeChanges(cu.spec ?? {}, desired),
    },
  };
}

describe('ReleaseList', () => {
  it('lists the targets newest first with kind, versions, hops and notes', () => {
    const cu = clusterUpgrade();
    const onChoose = vi.fn();
    render(<ReleaseList cu={cu} view={upgradeView(cu)} canPatch onChoose={onChoose} />);
    const buttons = screen.getAllByRole('button', { name: /^Upgrade to v/ });
    expect(buttons.map(b => b.textContent)).toEqual([
      'Upgrade to v2.7.0',
      'Upgrade to v2.6.0',
      'Upgrade to v2.5.0',
      'Upgrade to v2.4.1',
    ]);
    expect(screen.getByText('latest')).toBeTruthy();
    // v2.6.0 moves Kubernetes to 1.36; v2.7.0, after it, stays there
    expect(screen.getAllByText('Kubernetes 1.35.10 → 1.36.4')).toHaveLength(2);
    expect(screen.getByText(/4 hops: v2.4.1 → v2.5.0 → v2.6.0 → v2.7.0/)).toBeTruthy();
    expect(screen.getByText('Unattended join.')).toBeTruthy();
    fireEvent.click(buttons[0]);
    expect(onChoose).toHaveBeenCalledWith('v2.7.0');
  });

  it('marks the current target and disables the choice without permission', () => {
    const cu = clusterUpgradeInProgress();
    render(<ReleaseList cu={cu} view={upgradeView(cu)} canPatch={false} onChoose={vi.fn()} />);
    expect(screen.getByText('current target')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change target to v2.6.0' })).toBeNull();
    const other = screen.getByRole('button', {
      name: 'Change target to v2.7.0',
    }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
  });

  it('says when the cluster is up to date', () => {
    const cu = clusterUpgrade();
    cu.status!.availableReleases = [];
    render(<ReleaseList cu={cu} view={upgradeView(cu)} canPatch onChoose={vi.fn()} />);
    expect(screen.getByText('Nothing newer than v2.4.0')).toBeTruthy();
  });

  it('does not call an unreadable graph up to date', () => {
    const cu = clusterUpgrade();
    cu.status!.availableReleases = [];
    cu.status!.conditions = cu.status!.conditions!.map(c =>
      c.type === 'GraphAvailable' ? { ...c, status: 'False', message: 'HTTP 404' } : c
    );
    render(<ReleaseList cu={cu} view={upgradeView(cu)} canPatch onChoose={vi.fn()} />);
    expect(screen.getByText('Cannot read the upgrade graph')).toBeTruthy();
    expect(screen.getByText(/HTTP 404/)).toBeTruthy();
    expect(screen.queryByText(/Nothing newer/)).toBeNull();
  });

  it('disables a release the graph has no way to', () => {
    const cu = clusterUpgrade();
    cu.status!.availableReleases!.find(r => r.version === 'v2.7.0')!.path = [];
    render(<ReleaseList cu={cu} view={upgradeView(cu)} canPatch onChoose={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Upgrade to v2.7.0' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/no way from v2.4.0 to v2.7.0/)).toBeTruthy();
  });
});

describe('UpgradeReviewDialog', () => {
  it('shows the path hop by hop, the node order, the drain and the reboots', () => {
    const cu = clusterUpgrade();
    const flow = flowStub(reviewPhase(cu, { kind: 'start', target: 'v2.7.0' }));
    render(<UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} />);
    expect(screen.getByRole('dialog', { name: 'Upgrade to v2.7.0' })).toBeTruthy();
    const hops = within(screen.getByRole('list', { name: 'Planned hops' })).getAllByRole(
      'listitem'
    );
    expect(hops.map(h => h.textContent)).toEqual([
      expect.stringContaining('v2.4.0 → v2.4.1'),
      expect.stringContaining('Fedora 43 → 45'),
      expect.stringContaining('Kubernetes 1.35.10 → 1.36.4'),
      expect.stringContaining('Unattended join.'),
    ]);
    expect(screen.getByText(/12 reboots/)).toBeTruthy();
    expect(screen.getByText(/at most 30 minutes/)).toBeTruthy();
    expect(screen.getByText(/two control-plane nodes/)).toBeTruthy();
    expect(screen.getByText(/run kubeadm upgrade/)).toBeTruthy();
  });

  it('needs an acknowledgement before it starts the upgrade', () => {
    const cu = clusterUpgrade();
    const flow = flowStub(reviewPhase(cu, { kind: 'start', target: 'v2.5.0' }));
    render(<UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} />);
    const start = screen.getByRole('button', { name: 'Start upgrade' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /every node reboots/ }));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(flow.apply).toHaveBeenCalled();
  });

  it('checks the change again when the drain options are edited', () => {
    const cu = clusterUpgrade();
    const flow = flowStub(reviewPhase(cu, { kind: 'start', target: 'v2.5.0' }));
    render(<UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} />);
    fireEvent.change(screen.getByLabelText('Drain timeout in minutes'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Continue when the drain times out' }));
    expect(screen.queryByRole('button', { name: 'Start upgrade' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again with these options' }));
    expect(flow.review).toHaveBeenCalledWith({
      kind: 'start',
      target: 'v2.5.0',
      drain: { timeoutMinutes: 10, continueOnTimeout: true },
    });
  });

  it('only cordons a single node', () => {
    const cu = clusterUpgrade();
    cu.status!.nodes = [{ name: 'solo', role: 'bootstrap', phase: 'Done' }];
    const flow = flowStub(reviewPhase(cu, { kind: 'start', target: 'v2.5.0' }));
    render(<UpgradeReviewDialog flow={flow} nodes={[nodes()[0]]} nodeConfigs={[]} />);
    expect(screen.getByText(/cordoned before its hop, not drained/)).toBeTruthy();
    expect(screen.queryByLabelText('Drain timeout in minutes')).toBeNull();
    expect(
      screen.getByText(/Every workload, the Kubernetes API and this dashboard are down/)
    ).toBeTruthy();
  });

  it('keeps the target in the title when the dry run fails', () => {
    const flow = flowStub({
      kind: 'error',
      intent: { kind: 'start', target: '2.5.0' },
      error: { kind: 'forbidden', status: 403, message: 'Forbidden', hint: 'Not allowed.' },
      retry: vi.fn(),
    });
    render(<UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} />);
    expect(screen.getByRole('dialog', { name: 'Upgrade to v2.5.0' })).toBeTruthy();
    expect(screen.getByText('Not allowed.')).toBeTruthy();
  });

  it('warns when it replaces a target already set', () => {
    const cu = clusterUpgradeInProgress();
    const flow = flowStub(reviewPhase(cu, { kind: 'start', target: 'v2.7.0' }));
    render(<UpgradeReviewDialog flow={flow} nodes={nodes()} nodeConfigs={[]} />);
    expect(screen.getByText(/is already set/)).toBeTruthy();
  });
});

describe('UpgradeProgressPanel', () => {
  const now = Date.parse('2026-11-17T10:06:00Z');

  function renderPanel(cu: ClusterUpgradeObject, flow = flowStub({ kind: 'idle' })) {
    render(
      <UpgradeProgressPanel
        cu={cu}
        view={upgradeView(cu)}
        nodes={nodes()}
        flow={flow}
        canPatch
        now={now}
      />
    );
    return flow;
  }

  it('shows the hops, the nodes in order and the drain timer', () => {
    renderPanel(clusterUpgradeInProgress());
    const steps = within(screen.getByRole('list', { name: 'Upgrade path' })).getAllByRole(
      'listitem'
    );
    expect(steps.map(s => s.textContent)).toEqual([
      expect.stringContaining('v2.4.1'),
      expect.stringContaining('v2.5.0'),
      expect.stringContaining('v2.6.0'),
    ]);
    expect(screen.getByText('hop 2 of 3: v2.5.0')).toBeTruthy();
    const rows = within(screen.getByRole('table', { name: 'Upgrade nodes' })).getAllByRole('row');
    expect(rows.slice(1).map(r => within(r).getAllByRole('cell')[1].textContent)).toEqual([
      'cp-1',
      'cp-2',
      'w-1',
    ]);
    expect(screen.getByText(/6 min of 30 min, then the node fails/)).toBeTruthy();
  });

  it('pauses, and stops after a confirmation', () => {
    const flow = renderPanel(clusterUpgradeInProgress());
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(flow.act).toHaveBeenCalledWith({ kind: 'pause' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop upgrade' }));
    expect(flow.act).toHaveBeenCalledWith({ kind: 'stop' });
  });

  it('guides through a HOLD with the node commands', () => {
    const cu = clusterUpgradeInProgress();
    cu.status!.phase = 'Failed';
    cu.status!.nodes![1] = {
      name: 'cp-2',
      role: 'control',
      phase: 'Failed',
      reason: 'HostHold',
      hostPhase: 'HOLD',
      message: 'kubeadm upgrade node failed',
    };
    renderPanel(cu);
    expect(screen.getByText('cp-2 is on hold')).toBeTruthy();
    expect(
      screen.getByText('sudo k4all-upgrade clear-hold && sudo k4all-upgrade resume')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull(); // a hold resumes by itself
  });

  it('offers Retry after a failed drain', () => {
    const cu = clusterUpgradeInProgress();
    cu.status!.phase = 'Failed';
    cu.status!.nodes![1] = {
      ...cu.status!.nodes![1],
      phase: 'Failed',
      reason: 'DrainTimeout',
      message: 'drain timed out after 30 minutes, 3 pods left',
    };
    const flow = renderPanel(cu);
    expect(screen.getByText('Draining cp-2 did not finish')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(flow.retry).toHaveBeenCalled();
  });

  it('explains a node whose drain is blocked by pods that declare no controller', () => {
    const cu = clusterUpgradeInProgress();
    cu.status!.nodes![2] = {
      name: 'w-1',
      role: 'worker',
      phase: 'Pending',
      message:
        'runs pods that declare no controller: default/debug (a drain would delete them, and nothing ' +
        'recreates them: delete them, or recreate them under a controller; see docs/upgrades.md, Pods ' +
        'that declare no controller); the node is not cordoned',
    };
    renderPanel(cu);
    expect(screen.getByText('w-1 runs pods that declare no controller')).toBeTruthy();
    expect(screen.getByText('kubectl delete pod -n default debug')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Pods that declare no controller (docs/upgrades.md)' })
        .getAttribute('href')
    ).toBe(
      'https://github.com/gpillon/k4all/blob/main/docs/upgrades.md#pods-that-declare-no-controller'
    );
  });

  it("shows an abandoned hop from the operator's reason and host phase", () => {
    const cu = clusterUpgradeInProgress();
    cu.status!.phase = 'Failed';
    cu.status!.nodes![1] = {
      name: 'cp-2',
      role: 'control',
      release: 'v2.4.1',
      phase: 'Failed',
      reason: 'Abandoned',
      hostPhase: 'ABANDONED',
      message: 'v2.5.0 abandoned: disk full',
    };
    const flow = renderPanel(cu);
    expect(screen.getByText('The hop was abandoned on cp-2')).toBeTruthy();
    expect(screen.getByText('Abandoned')).toBeTruthy(); // host phase column
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(flow.retry).toHaveBeenCalled();
  });

  it('shows how long hops and nodes took', () => {
    renderPanel(clusterUpgradeInProgress());
    expect(screen.getByText('took 27 min')).toBeTruthy(); // hop v2.4.1
    expect(screen.getByText('running for 36 min')).toBeTruthy(); // hop v2.5.0
    expect(screen.getByText('took 11 min')).toBeTruthy(); // cp-1
    expect(screen.getByText('running for 6 min')).toBeTruthy(); // cp-2
  });

  it('resumes a paused upgrade', () => {
    const cu = clusterUpgradeInProgress();
    cu.spec!.paused = true;
    cu.status!.phase = 'Paused';
    const flow = renderPanel(cu);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(flow.act).toHaveBeenCalledWith({ kind: 'resume' });
  });
});

describe('without ClusterUpgrade', () => {
  const data = (rm = releaseManifest()): K4allData => ({
    cc: clusterConfigNginx(),
    rm,
    extraClusterConfigs: [],
    nodes: [],
    nodeConfigs: [],
    loading: false,
    crdsMissing: false,
    error: null,
  });

  it('names the operator and release that bring it, and the node command meanwhile', () => {
    render(<ClusterUpgradeUnavailable data={data()} />);
    expect(screen.getByText('Upgrades from Headlamp need k4all-operator v0.4.0')).toBeTruthy();
    expect(
      screen.getByText(
        /runs k4all-operator v0.3.0. k4all v2.4.0 brings the ClusterUpgrade API \(k4all-operator v0.4.0 or later\)/
      )
    ).toBeTruthy();
    expect(screen.getByText('sudo k4all-upgrade run --to v2.4.0')).toBeTruthy();
  });

  it('points at the installation when the operator should serve it', () => {
    render(<ClusterUpgradeUnavailable data={data(releaseManifestNginx())} />);
    expect(screen.getByText(/check the k4all-operator installation/)).toBeTruthy();
  });
});

describe('UpgradeSummary (Overview card)', () => {
  it('announces newer releases', () => {
    render(
      <MemoryRouter>
        <UpgradeSummary cu={clusterUpgrade()} />
      </MemoryRouter>
    );
    expect(
      screen.getByText(/4 newer releases, latest v2.7.0 \(Kubernetes 1.36.4, Fedora 45\)/)
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan upgrade' })).toBeTruthy();
  });

  it('follows an upgrade in progress', () => {
    render(
      <MemoryRouter>
        <UpgradeSummary cu={clusterUpgradeInProgress()} />
      </MemoryRouter>
    );
    expect(screen.getByText(/v2.4.1 → v2.6.0 · hop 2 of 3 · 1 of 3 nodes done/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Follow the upgrade' })).toBeTruthy();
  });
});
