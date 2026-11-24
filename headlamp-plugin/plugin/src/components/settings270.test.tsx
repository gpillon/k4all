/*
 * Rendering tests of the k4all v2.7.0 settings pages' parts: gates, VM
 * state, Hangar node agent, metadata service (virtualization), kubelet,
 * hugepages, the plan and the rollout (nodes), the Ceph sections (storage),
 * and the shared banners. Icons are stubbed; Headlamp's Utils only gives the
 * cluster name for the console links.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { Capabilities, capabilitiesOf } from '../model/capabilities';
import { describeChanges } from '../model/changes';
import {
  clusterConfigV270,
  kubevirtCR,
  nodeWithCapacity,
  releaseManifestV270,
} from '../model/fixtures';
import { gateIssues } from '../model/gates';
import { nodeSettingsIssues, rolloutPlan, rolloutView } from '../model/nodeSettings';
import { setIn } from '../model/objects';
import { buildSpecPatch } from '../model/patch';
import { Draft } from '../model/settings';
import { rookView } from '../model/storage';
import { CephClusterLike } from '../model/types';
import { validateSettings } from '../model/validation';
import { vmStateIssues } from '../model/virtSettings';
import {
  KubeletSection,
  MemorySection,
  PlanView,
  RolloutPanel,
} from './nodes/nodeSettingsSections';
import { ReviewDialog } from './review/ReviewDialog';
import { SaveFlow } from './review/useSaveFlow';
import { FeatureCard, ROOK_FEATURE } from './settings/FeaturesSection';
import {
  CapabilityNotice,
  PodNetworkOverlapBanner,
  SettingsPagesLinks,
} from './settings/settingsLinks';
import { CephSection, DiskPreview, TeardownPanel } from './storage/storageSections';
import {
  GatesSection,
  HangarSection,
  MetadataSection,
  VmStateSection,
} from './virtualization/sections';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Utils: { getCluster: () => 'main' },
  Router: { createRouteURL: (name: string) => `/c/main/${name}` },
}));

const NEW: Capabilities = capabilitiesOf('v0.6.0');

function props(draft: Draft, update = vi.fn(), base: Draft = clusterConfigV270().spec!) {
  return {
    draft,
    base,
    update,
    disabled: false,
    issues: validateSettings(draft),
    status: {},
    caps: NEW,
  };
}

/** Runs the update function a section passed to its `update` callback. */
function applied(update: ReturnType<typeof vi.fn>, draft: Draft): Draft {
  expect(update).toHaveBeenCalled();
  const fn = update.mock.calls[update.mock.calls.length - 1][0] as (d: Draft) => Draft;
  return fn(draft);
}

function choose(label: string, option: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}

describe('GatesSection', () => {
  const kv = kubevirtCR('v1.9.1', { featureGates: ['Sidecar', 'HostDevices'], k4allOn: 'Sidecar' });
  const draft = setIn(clusterConfigV270().spec!, ['features', 'virt', 'kubevirt'], {
    featureGates: ['Sidecar'],
  });

  it('tells gates k4all owns from gates set elsewhere, with maturity and state', () => {
    render(<GatesSection {...props(draft, vi.fn(), draft)} kv={kv} />);
    const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    expect(within(row('Sidecar')).getByText('k4all')).toBeTruthy();
    expect(within(row('Sidecar')).getByText('Alpha')).toBeTruthy();
    expect(within(row('HostDevices')).getByText('set elsewhere')).toBeTruthy();
    expect(within(row('Snapshot')).getByText('Beta')).toBeTruthy();
    expect(screen.getByText('KubeVirt v1.9.1')).toBeTruthy();
    // GA gates are hidden by default
    expect(screen.queryByText('LiveMigration')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(screen.getByText('LiveMigration')).toBeTruthy();
  });

  it('writes the off list, and cannot turn a GA gate off', () => {
    const update = vi.fn();
    render(<GatesSection {...props(draft, update, draft)} kv={kv} />);
    choose('k4all setting of Snapshot', 'Off');
    expect(applied(update, draft).features?.virt?.kubevirt).toEqual({
      featureGates: ['Sidecar'],
      disabledFeatureGates: ['Snapshot'],
    });
    fireEvent.change(screen.getByLabelText('Search gates'), { target: { value: 'VMPersistent' } });
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.mouseDown(
      screen.getByRole('combobox', { name: 'k4all setting of VMPersistentState' })
    );
    expect(
      within(screen.getByRole('listbox'))
        .getByRole('option', { name: 'Off (GA: always on)' })
        .getAttribute('aria-disabled')
    ).toBe('true');
  });

  it('says when turning one hot-plug gate on turned the other off', () => {
    const update = vi.fn();
    const onAlso = vi.fn();
    const base = clusterConfigV270().spec!;
    render(
      <GatesSection {...props(base, update, base)} kv={kubevirtCR('v1.9.1')} onAlso={onAlso} />
    );
    fireEvent.change(screen.getByLabelText('Search gates'), { target: { value: 'Hotplug' } });
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    choose('k4all setting of HotplugVolumes', 'On');
    expect(applied(update, base).features?.virt?.kubevirt).toEqual({
      featureGates: ['HotplugVolumes'],
      disabledFeatureGates: ['DeclarativeHotplugVolumes'],
    });
    expect(onAlso).toHaveBeenCalledWith(['DeclarativeHotplugVolumes']);
  });

  it('shows the refusal of a GA gate in the off list', () => {
    const bad = setIn(
      draft,
      ['features', 'virt', 'kubevirt', 'disabledFeatureGates'],
      ['LiveMigration']
    );
    render(
      <GatesSection {...props(bad, vi.fn(), draft)} issues={gateIssues(bad, { kv })} kv={kv} />
    );
    expect(screen.getByText(/LiveMigration is GA in KubeVirt v1.9: always on/)).toBeTruthy();
  });

  it('works from the release version without a KubeVirt CR', () => {
    render(<GatesSection {...props(draft, vi.fn(), draft)} kv={null} releaseVersion="v1.9.1" />);
    expect(screen.getByText('KubeVirt not running (release: v1.9.1)')).toBeTruthy();
    expect(screen.getByText('Sidecar')).toBeTruthy();
  });
});

describe('VmStateSection', () => {
  const storageClasses = [
    {
      metadata: {
        name: 'topolvm-provisioner',
        annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
      },
    },
    { metadata: { name: 'ceph-rbd' } },
  ];
  const profiles = [
    {
      metadata: { name: 'ceph-rbd' },
      status: { claimPropertySets: [{ volumeMode: 'Filesystem', accessModes: ['ReadWriteOnce'] }] },
    },
  ];

  it('picks a StorageClass, and warns on ReadWriteOnce', () => {
    const update = vi.fn();
    const draft = clusterConfigV270().spec!;
    const { unmount } = render(
      <VmStateSection
        {...props(draft, update)}
        kv={kubevirtCR()}
        storageClasses={storageClasses}
        profiles={profiles}
      />
    );
    expect(screen.getByText(/New VM state volumes go to/)).toBeTruthy();
    expect(screen.getByText('topolvm-provisioner')).toBeTruthy();
    choose('VM state StorageClass', 'ceph-rbd');
    const next = applied(update, draft);
    expect(next.features?.virt?.kubevirt).toEqual({ vmStateStorageClass: 'ceph-rbd' });
    unmount();
    const ctx = { kv: kubevirtCR(), storageClasses, profiles };
    render(<VmStateSection {...props(next, vi.fn())} issues={vmStateIssues(next, ctx)} {...ctx} />);
    expect(
      screen.getByText(/copies the state to the target node at each live migration/)
    ).toBeTruthy();
  });
});

describe('HangarSection', () => {
  const rm = releaseManifestV270();

  it('turns the node agent off explicitly, and back to the release default', () => {
    const update = vi.fn();
    const draft = clusterConfigV270().spec!;
    render(
      <HangarSection {...props(draft, update)} components={rm.spec!.components!} statuses={{}} />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hangar node agent' }));
    const off = applied(update, draft);
    expect(off.features?.virt?.hangar).toEqual({ nodeAgent: false });
  });

  it('removes the setting when turned back on from the release default', () => {
    const update = vi.fn();
    const off = setIn(
      clusterConfigV270().spec!,
      ['features', 'virt', 'hangar', 'nodeAgent'],
      false
    );
    render(
      <HangarSection {...props(off, update)} components={rm.spec!.components!} statuses={{}} />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hangar node agent' }));
    expect(applied(update, off).features?.virt).toEqual({ enabled: true, emulation: 'auto' });
  });
});

describe('MetadataSection', () => {
  it('explains the opt-in label and the PodSecurity limit, and enables the service', () => {
    const update = vi.fn();
    const draft = clusterConfigV270().spec!;
    render(<MetadataSection {...props(draft, update)} />);
    expect(screen.getByText('k4all.magesgate.com/metadata: enabled')).toBeTruthy();
    expect(screen.getByText(/it is not injected/)).toBeTruthy();
    // below settings wait for the switch
    expect((screen.getByLabelText('Vendor-data ConfigMap') as HTMLInputElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Metadata service' }));
    expect(applied(update, draft).features?.virt?.metadata).toEqual({ enabled: true });
  });

  it('writes the scope and the token lifetime, and clears them back to the defaults', () => {
    const update = vi.fn();
    const draft = setIn(clusterConfigV270().spec!, ['features', 'virt', 'metadata'], {
      enabled: true,
      tokens: { expirationSeconds: 3600 },
    });
    render(<MetadataSection {...props(draft, update)} />);
    choose('Metadata service: which VMs', 'All VMs');
    expect(applied(update, draft).features?.virt?.metadata?.scope).toBe('All');
    fireEvent.change(screen.getByLabelText('Token lifetime in seconds'), { target: { value: '' } });
    expect(applied(update, draft).features?.virt?.metadata).toEqual({ enabled: true });
  });
});

describe('KubeletSection and MemorySection', () => {
  const nodes = [nodeWithCapacity('cp-1', 8, 32), nodeWithCapacity('w-1', 2, 8, { worker: true })];
  const nodeProps = (draft: Draft, update = vi.fn()) => ({
    ...props(draft, update),
    issues: [...validateSettings(draft), ...nodeSettingsIssues(draft, { nodes })],
    nodes,
  });

  it('shows the CPUs of each node next to the reserved CPUs, and their refusal', () => {
    const draft = setIn(clusterConfigV270().spec!, ['nodes', 'kubelet'], {
      cpuManagerPolicy: 'static',
      reservedSystemCPUs: '0-3',
    });
    render(<KubeletSection {...nodeProps(draft)} />);
    expect(screen.getByText('cp-1: 8 CPUs (0-7)')).toBeTruthy();
    expect(screen.getByText('w-1: 2 CPUs (0-1)')).toBeTruthy();
    expect(screen.getByText(/w-1 has 2 CPUs \(0-1\): CPUs 2, 3 do not exist there/)).toBeTruthy();
  });

  it('writes maxPods, and clearing it leaves spec.nodes absent', () => {
    const update = vi.fn();
    const draft = clusterConfigV270().spec!;
    const { unmount } = render(<KubeletSection {...nodeProps(draft, update)} />);
    fireEvent.change(screen.getByLabelText('Max pods per node'), { target: { value: '250' } });
    const set = applied(update, draft);
    expect(set.nodes).toEqual({ kubelet: { maxPods: 250 } });
    unmount();
    const clear = vi.fn();
    render(<KubeletSection {...nodeProps(set, clear)} />);
    fireEvent.change(screen.getByLabelText('Max pods per node'), { target: { value: '' } });
    expect(applied(clear, set).nodes).toBeUndefined();
  });

  it('says what a cleared field goes back to', () => {
    const set = setIn(clusterConfigV270().spec!, ['nodes', 'kubelet', 'maxPods'], 200);
    const cleared = clusterConfigV270().spec!;
    render(<KubeletSection {...nodeProps(cleared)} base={set} kubeletPrior={{ maxPods: '250' }} />);
    expect(screen.getByText(/gets back maxPods: 250/)).toBeTruthy();
    expect(
      screen.getAllByText(/keeps the value it had before k4all set it/).length
    ).toBeGreaterThan(0);
  });

  it('does the memory math per node and warns above 50 %', () => {
    const draft = setIn(clusterConfigV270().spec!, ['nodes', 'hugepages'], { '1Gi': 5 });
    render(<MemorySection {...nodeProps(draft)} />);
    const table = screen.getByRole('table', { name: 'Hugepage memory per node' });
    expect(within(table).getByText('62.5 %')).toBeTruthy();
    expect(within(table).getByText('15.6 %')).toBeTruthy();
    expect(screen.getByText(/Hugepages take 62.5 % of the memory of w-1/)).toBeTruthy();
  });
});

describe('PlanView and RolloutPanel', () => {
  it('lists the nodes in order with what each does', () => {
    const nodes = [
      nodeWithCapacity('w-1', 4, 16, { worker: true, type: 'worker' }),
      nodeWithCapacity('cp-1', 4, 16, { type: 'bootstrap' }),
    ];
    const plan = rolloutPlan({ base: {}, draft: { nodes: { iommu: true } }, nodes });
    render(<PlanView plan={plan} />);
    expect(screen.getByText(/What saving does: drain, reboot/)).toBeTruthy();
    const rows = within(screen.getByRole('table', { name: 'Rollout order' })).getAllByRole('row');
    // the operator's order: workers first, the bootstrap node last
    expect(rows.slice(1).map(r => within(r).getAllByRole('cell')[1].textContent)).toEqual([
      'w-1',
      'cp-1',
    ]);
  });

  it('says that a single node stops its workloads', () => {
    const plan = rolloutPlan({
      base: {},
      draft: { nodes: { hugepages: { '2Mi': 512 } } },
      nodes: [nodeWithCapacity('k4all-1', 4, 16)],
    });
    render(<PlanView plan={plan} />);
    expect(screen.getByText(/workloads stop while it reboots/)).toBeTruthy();
    expect(screen.getByText('cordon only')).toBeTruthy();
  });

  it('shows the rollout per node and pauses it', () => {
    const cc = clusterConfigV270();
    cc.spec!.nodes = { iommu: true };
    cc.status!.nodes = {
      settingsHash: 'h',
      rollout: { phase: 'Rolling', currentNode: 'w-1', message: 'draining' },
      perNode: [
        { name: 'cp-1', appliedHash: 'h', phase: 'Done' },
        { name: 'w-1', appliedHash: 'x', phase: 'Draining' },
      ],
    };
    const onPause = vi.fn();
    const { unmount } = render(
      <RolloutPanel view={rolloutView(cc)} canPause busy={false} onPause={onPause} />
    );
    expect(screen.getByText('1 of 2 nodes')).toBeTruthy();
    expect(screen.getByText('draining')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledWith(true);
    unmount();
    cc.spec!.nodes.rollout = { paused: true };
    render(<RolloutPanel view={rolloutView(cc)} canPause busy={false} onPause={onPause} />);
    expect(screen.getByText('Pausing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onPause).toHaveBeenLastCalledWith(false);
  });
});

describe('rollout per node', () => {
  it('shows the phases, the next action and a refusal', () => {
    const cc = clusterConfigV270();
    cc.spec!.nodes = { kubelet: { reservedSystemCPUs: '0-3' } };
    cc.status!.nodes = {
      settingsHash: 'h',
      rollout: { phase: 'Blocked', currentNode: 'w-1', message: 'w-1 refuses the settings' },
      perNode: [
        { name: 'w-1', phase: 'Applying', message: 'CPUs 2-3 do not exist' },
        { name: 'cp-1', phase: 'Pending', message: 'next: drain-restart' },
      ],
    };
    cc.status!.conditions = [
      {
        type: 'NodeSettingsRollout',
        status: 'False',
        reason: 'NodeRefused',
        message: 'w-1 refuses',
      },
    ];
    render(<RolloutPanel view={rolloutView(cc)} canPause busy={false} onPause={vi.fn()} />);
    expect(screen.getByText('refused')).toBeTruthy();
    expect(screen.getByText('next: drain, kubelet restart')).toBeTruthy();
    expect(
      screen.getByText(/refuses the settings/, {
        selector: '.MuiAlert-message, .MuiAlert-message *',
      })
    ).toBeTruthy();
  });
});

describe('a held uninstall group (#96)', () => {
  it('lists the shared message once, with the components it holds', () => {
    const rm = releaseManifestV270();
    const held = 'uninstall refused: kubevirt: 2 VirtualMachines exist';
    for (const name of ['kubevirt', 'cdi', 'hangar']) {
      rm.status!.components![name] = { state: 'Installed', message: held };
    }
    const off = setIn(clusterConfigV270().spec!, ['features', 'virt', 'enabled'], false);
    render(
      <FeatureCard
        {...props(off, vi.fn(), off)}
        def={{ key: 'virt', icon: 'x', label: 'Virtualization', help: '' }}
        components={rm.spec!.components!}
        statuses={rm.status!.components}
      />
    );
    expect(screen.getAllByText('kubevirt: 2 VirtualMachines exist')).toHaveLength(1);
    expect(screen.getByText('cdi, hangar, kubevirt')).toBeTruthy();
  });
});

describe('storage sections', () => {
  const ceph: CephClusterLike = {
    metadata: { name: 'rook-ceph', namespace: 'rook-ceph' },
    status: { phase: 'Ready', ceph: { health: 'HEALTH_OK' } },
  };
  const three = ['a', 'b', 'c'].map(n => nodeWithCapacity(n, 4, 16));
  const on = setIn(clusterConfigV270().spec!, ['features', 'rook'], { enabled: true });

  it('says "created: manage it in Cairn" once the CephCluster exists', () => {
    const view = rookView({
      spec: on,
      cephClusters: [ceph],
      rm: releaseManifestV270(),
      nodes: three,
    });
    render(
      <CephSection {...props(on)} view={view} clusters={[ceph]} nodes={3} inventories={null} />
    );
    expect(screen.getByText('Created: manage it in Cairn')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Hosts and OSDs' }).getAttribute('href')).toBe(
      '/c/main/ceph/osds'
    );
    expect(screen.queryByLabelText('Disks for Ceph')).toBeNull();
  });

  it('takes the creation inputs before, with the disks that would become OSDs', () => {
    const update = vi.fn();
    const view = rookView({ spec: on, cephClusters: [], rm: releaseManifestV270(), nodes: three });
    render(
      <CephSection
        {...props(on, update)}
        view={view}
        clusters={[]}
        nodes={3}
        inventories={{
          nodes: [
            {
              node: 'a',
              disks: [
                {
                  name: 'sda',
                  sizeBytes: 2 ** 37,
                  partitions: ['sda1'],
                  signatures: ['gpt'],
                  holders: [],
                  mounts: ['/'],
                },
                {
                  name: 'sdb',
                  sizeBytes: 2 ** 38,
                  partitions: [],
                  signatures: [],
                  holders: [],
                  mounts: [],
                },
              ],
            },
          ],
          missing: false,
          denied: false,
        }}
      />
    );
    expect(screen.getByText(/3 mons, 2 mgrs, pool/)).toBeTruthy();
    expect(screen.getByText('becomes an OSD')).toBeTruthy();
    expect(screen.getByText('in use: skipped')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Disks for Ceph'), { target: { value: '^sdb$' } });
    expect(applied(update, on).features?.rook).toEqual({
      enabled: true,
      storage: { deviceFilter: '^sdb$' },
    });
  });

  it('warns that Allow on one node has no redundancy', () => {
    const allow = setIn(on, ['features', 'rook', 'smallCluster'], 'Allow');
    const view = rookView({
      spec: allow,
      cephClusters: [],
      rm: releaseManifestV270(),
      nodes: [three[0]],
    });
    render(
      <CephSection {...props(allow)} view={view} clusters={[]} nodes={1} inventories={null} />
    );
    expect(screen.getByText(/No redundancy: 1 mon and a pool of size 1/)).toBeTruthy();
  });

  it('cannot tell the disks without the node agent', () => {
    render(<DiskPreview inventories={{ nodes: [], missing: true, denied: false }} />);
    expect(screen.getByText(/Which disks Ceph would take: unknown/)).toBeTruthy();
  });

  it('explains why Rook stays and the steps to turn it off, and that disks are never wiped', () => {
    const rm = releaseManifestV270();
    rm.status!.components!['rook-ceph'] = {
      state: 'Installed',
      message: 'uninstall refused: CephCluster rook-ceph/rook-ceph exists',
    };
    const off = setIn(on, ['features', 'rook', 'enabled'], false);
    render(
      <TeardownPanel view={rookView({ spec: off, cephClusters: [ceph], rm, nodes: three })} />
    );
    expect(
      screen.getByText('k4all-operator keeps Rook installed while a CephCluster exists')
    ).toBeTruthy();
    expect(screen.getByText(/CephCluster rook-ceph\/rook-ceph exists/)).toBeTruthy();
    expect(screen.getByText(/kubectl -n rook-ceph delete cephcluster rook-ceph/)).toBeTruthy();
    expect(screen.getByText(/k4all never wipes disks/)).toBeTruthy();
  });

  it('shows refused uninstalls and waits on the Rook switch', () => {
    const rm = releaseManifestV270();
    rm.status!.components!['rook-ceph'] = {
      state: 'Installed',
      message: 'waiting: 1 schedulable node, smallCluster Refuse',
    };
    render(
      <FeatureCard
        {...props(on)}
        def={ROOK_FEATURE}
        components={rm.spec!.components!}
        statuses={rm.status!.components}
      />
    );
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText('1 schedulable node, smallCluster Refuse')).toBeTruthy();
    expect(screen.getByText('rook-ceph', { selector: 'span' })).toBeTruthy();
  });

  it('names only what turning virt off removes: Rook keeps the snapshot controller', () => {
    const rm = releaseManifestV270();
    const virtOff = setIn(on, ['features', 'virt', 'enabled'], false);
    render(
      <FeatureCard
        {...props(virtOff, vi.fn(), on)}
        def={{ key: 'virt', icon: 'x', label: 'Virtualization', help: '' }}
        components={rm.spec!.components!}
      />
    );
    const alert = screen.getByText(/^Uninstalls /);
    expect(alert.textContent).toMatch(
      /^Uninstalls cdi, hangar, hangar-node-agent, kubevirt, virtctl once/
    );
  });

  it('leaves no rook key behind when switched on and off on a cluster without it', () => {
    const update = vi.fn();
    const base = clusterConfigV270().spec!;
    const rm = releaseManifestV270();
    render(
      <FeatureCard
        {...props(on, update, base)}
        def={ROOK_FEATURE}
        components={rm.spec!.components!}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rook/Ceph storage' }));
    expect(applied(update, on).features?.rook).toBeUndefined();
  });
});

describe('banners', () => {
  it('shows PodNetworkOverlap when True or Unknown only', () => {
    const status = (s: string) => ({
      conditions: [
        {
          type: 'PodNetworkOverlap',
          status: s,
          reason: 'OverlapFound',
          message: 'node pod CIDR 10.0.2.0/24 overlaps 10.0.2.0/24 (virt)',
        },
      ],
    });
    const { unmount } = render(<PodNetworkOverlapBanner status={status('True')} />);
    expect(screen.getByText('Pod addresses overlap another network')).toBeTruthy();
    expect(screen.getByText(/overlaps 10.0.2.0\/24/)).toBeTruthy();
    unmount();
    // False without a note says nothing
    const { container } = render(<PodNetworkOverlapBanner status={status('False')} />);
    expect(container.textContent).toBe('');
  });

  it('shows the note of a False PodNetworkOverlap as information', () => {
    render(
      <PodNetworkOverlapBanner
        status={{
          conditions: [
            {
              type: 'PodNetworkOverlap',
              status: 'False',
              reason: 'NoOverlap',
              message:
                'no overlap. Note: the pool 10.0.0.0/8 holds the service network 10.96.0.0/16; Cilium never allocates it.',
            },
          ],
        }}
      />
    );
    expect(
      screen.getByText(
        'Note: the pool 10.0.0.0/8 holds the service network 10.96.0.0/16; Cilium never allocates it.'
      )
    ).toBeTruthy();
    expect(screen.queryByText('Pod addresses overlap another network')).toBeNull();
  });

  it('says which operator brings the settings, read-only meanwhile', () => {
    render(
      <CapabilityNotice caps={capabilitiesOf('v0.5.7')} id="nodeSettings" what="Node settings" />
    );
    expect(
      screen.getByText('Node settings need k4all-operator v0.6.0 (k4all v2.7.0)')
    ).toBeTruthy();
    expect(screen.getByText(/runs k4all-operator v0.5.7/)).toBeTruthy();
  });
});

describe('/k4all/settings links', () => {
  it('links the three pages, marking those the operator cannot do yet', () => {
    render(
      <MemoryRouter>
        <SettingsPagesLinks caps={capabilitiesOf('v0.5.7')} />
      </MemoryRouter>
    );
    for (const name of ['Virtualization settings', 'Nodes settings', 'Storage settings']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getAllByText('Coming with k4all-operator v0.6.0 (k4all v2.7.0)')).toHaveLength(3);
  });
});

describe('ReviewDialog with the node plan', () => {
  it('shows the plan of the reviewed draft above the changes, and asks to acknowledge reboots', () => {
    const base = clusterConfigV270();
    const draft = setIn(base.spec!, ['nodes', 'iommu'], true);
    const flow: SaveFlow = {
      phase: {
        kind: 'review',
        data: {
          base,
          draft,
          ops: buildSpecPatch(base, draft),
          result: { ...base, spec: draft },
          items: describeChanges(base.spec!, draft, releaseManifestV270().spec!.components!, NEW),
          adjustments: [],
          reapplied: [],
        },
      },
      review: vi.fn(),
      apply: vi.fn(),
      resolve: vi.fn(),
      close: vi.fn(),
    };
    const nodes = [nodeWithCapacity('k4all-1', 4, 16)];
    render(
      <ReviewDialog
        flow={flow}
        title="Apply"
        extra={review => (
          <PlanView
            plan={rolloutPlan({ base: review.base.spec!, draft: review.draft, nodes })}
            title="After saving"
          />
        )}
      />
    );
    expect(screen.getByText(/After saving: drain, reboot/)).toBeTruthy();
    expect(screen.getByText(/drained and reboots with the new kernel arguments/)).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply changes' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand the consequences/ }));
    expect(apply.disabled).toBe(false);
  });
});
