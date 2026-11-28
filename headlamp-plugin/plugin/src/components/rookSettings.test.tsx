/*
 * Rendering tests of the k4all v2.7.2 Rook settings (Storage page) and the
 * guest bridge switch (Virtualization page): every control, every reason of
 * RookCSIImage and RookMonitoring, the crash collector read from and written
 * to the CephCluster (never the ClusterConfig), and what a viewer sees.
 * Icons are stubbed; Headlamp's lib gives the cluster name and ApiProxy.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { setCrashCollector } from '../api/rookObjects';
import { Capabilities, capabilitiesOf } from '../model/capabilities';
import {
  cephClusterK4all,
  clusterConfigV270,
  nodeWithLevel,
  releaseManifestV272,
} from '../model/fixtures';
import { setIn } from '../model/objects';
import { Draft } from '../model/settings';
import { rookIssues, rookView } from '../model/storage';
import { ClusterConfigStatus, RookConfig } from '../model/types';
import { validateSettings } from '../model/validation';
import {
  CephFsPanel,
  CrashCollectorPanel,
  CsiImagePanel,
  MonitoringPanel,
  NamedDevicesRow,
  RookReadyAlert,
} from './storage/rookSections';
import { CephSection, DiskPreview } from './storage/storageSections';
import { HangarSection } from './virtualization/sections';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Utils: { getCluster: () => 'main' },
  Router: { createRouteURL: (name: string) => `/c/main/${name}` },
  ApiProxy: { request: vi.fn(async () => ({})) },
}));

const V072: Capabilities = capabilitiesOf('v0.7.0');
const V060: Capabilities = capabilitiesOf('v0.6.0');
const three = ['a', 'b', 'c'].map(n => nodeWithLevel(n, 'v3'));

const rookOn = (r: RookConfig = {}): Draft =>
  setIn(clusterConfigV270().spec!, ['features', 'rook'], { enabled: true, ...r });

function props(
  draft: Draft,
  opts: {
    update?: ReturnType<typeof vi.fn>;
    base?: Draft;
    disabled?: boolean;
    caps?: Capabilities;
    status?: ClusterConfigStatus;
  } = {}
) {
  return {
    draft,
    base: opts.base ?? rookOn(),
    update: opts.update ?? vi.fn(),
    disabled: opts.disabled ?? false,
    issues: [...validateSettings(draft), ...rookIssues(draft, { nodes: three, created: false })],
    status: opts.status ?? {},
    caps: opts.caps ?? V072,
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

const condition = (type: string, status: string, reason: string, message = 'as written') => ({
  conditions: [{ type, status, reason, message }],
});

// ------------------------------------------------------------ named devices

describe('Named devices (features.rook.storage.nodes)', () => {
  it('adds a node with a device, offering the nodes not named yet', () => {
    const update = vi.fn();
    const draft = rookOn();
    render(<NamedDevicesRow {...props(draft, { update })} nodeNames={['a', 'b']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }));
    expect(applied(update, draft).features?.rook?.storage).toEqual({
      nodes: [{ name: 'a', devices: [{ name: '' }] }],
    });
  });

  it('edits, adds and removes the devices of a node, and says what a logical volume needs', () => {
    const update = vi.fn();
    const draft = rookOn({ storage: { nodes: [{ name: 'a', devices: [{ name: '/dev/vg/x' }] }] } });
    render(<NamedDevicesRow {...props(draft, { update })} nodeNames={['a', 'b']} />);
    expect(screen.getByText(/--wipesignatures y --zero y/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Device 1 of a'), {
      target: { value: '/dev/vg_data/ceph0' },
    });
    expect(applied(update, draft).features?.rook?.storage?.nodes).toEqual([
      { name: 'a', devices: [{ name: '/dev/vg_data/ceph0' }] },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Add a device to a' }));
    expect(applied(update, draft).features?.rook?.storage?.nodes?.[0].devices).toEqual([
      { name: '/dev/vg/x' },
      { name: '' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
    expect(applied(update, draft).features?.rook).toEqual({ enabled: true });
  });

  it('names the node of an entry, and shows the refusals', () => {
    const update = vi.fn();
    const draft = rookOn({ storage: { nodes: [{ name: '', devices: [{ name: 'sdb' }] }] } });
    render(<NamedDevicesRow {...props(draft, { update })} nodeNames={['a']} />);
    expect(screen.getByText('Entry 1: choose a node.')).toBeTruthy();
    expect(screen.getByText(/"sdb" is not a device path/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Node of entry 1'), { target: { value: 'c' } });
    expect(applied(update, draft).features?.rook?.storage?.nodes?.[0].name).toBe('c');
  });

  it('is exclusive with Disks for Ceph', () => {
    const draft = rookOn({ storage: { deviceFilter: '^sdb$' } });
    render(<NamedDevicesRow {...props(draft)} nodeNames={['a']} />);
    expect(screen.getByText(/Disks for Ceph is set: the two are exclusive/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a node' })).toBeNull();
  });

  it('shows a viewer the list and no buttons; an older operator says which one brings it', () => {
    const draft = rookOn({
      storage: {
        nodes: [{ name: 'a', devices: [{ name: '/dev/vg/ceph0' }, { name: '/dev/sdb' }] }],
      },
    });
    const { unmount } = render(
      <NamedDevicesRow {...props(draft, { disabled: true })} nodeNames={['a']} />
    );
    expect(screen.getByText('/dev/vg/ceph0')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('textbox')).toBeNull();
    unmount();
    render(<NamedDevicesRow {...props(rookOn(), { caps: V060 })} nodeNames={['a']} />);
    expect(screen.getByText(/Coming with k4all-operator v0.7.0 \(k4all v2.7.2\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a node' })).toBeNull();
  });
});

describe('RookReadyAlert', () => {
  it.each([
    ['StorageNodesUnusable', /fix Named devices below, or the node/],
    ['NamedDevicesWithoutOSD', /rook-ceph-osd-prepare job.*--wipesignatures y --zero y/],
  ])('says what to do for %s, under the message as written', (reason, hint) => {
    render(
      <RookReadyAlert
        condition={{ type: 'RookReady', status: 'False', reason, message: 'as written' }}
      />
    );
    expect(screen.getByText(`RookReady: ${reason}`)).toBeTruthy();
    expect(screen.getByText('as written')).toBeTruthy();
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it('adds nothing to the other reasons', () => {
    render(
      <RookReadyAlert
        condition={{
          type: 'RookReady',
          status: 'True',
          reason: 'CephHealthOK',
          message: 'HEALTH_OK',
        }}
      />
    );
    expect(screen.getByText('HEALTH_OK').parentElement?.textContent).toBe(
      'RookReady: CephHealthOKHEALTH_OK'
    );
  });
});

describe('CephSection with named devices and the disks per node', () => {
  const inventories = {
    nodes: [
      {
        node: 'a',
        disks: [
          {
            name: 'sda',
            sizeBytes: 2 ** 37,
            partitions: ['sda1', 'sda2'],
            signatures: ['gpt'],
            holders: ['dm-0', 'dm-1'],
            mounts: ['/boot'],
          },
          {
            name: 'sdb',
            sizeBytes: 2 ** 38,
            partitions: [],
            signatures: [],
            holders: [],
            mounts: [],
          },
          {
            name: 'sdc',
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
  };

  it('shows a disk with LVM as "can be named" instead of "in use: skipped"', () => {
    render(<DiskPreview inventories={inventories} />);
    expect(screen.getByText('LVM: a logical volume can be named')).toBeTruthy();
    expect(screen.queryByText('in use: skipped')).toBeNull();
    expect(screen.getAllByText('becomes an OSD').length).toBe(2);
  });

  it('with named devices, marks the named disks and the blank ones that can be named', () => {
    const draft = rookOn({
      storage: {
        nodes: [{ name: 'a', devices: [{ name: '/dev/sdb' }, { name: '/dev/vg/ceph0' }] }],
      },
    });
    const view = rookView({
      spec: draft,
      cephClusters: [],
      rm: releaseManifestV272(),
      nodes: three,
    });
    render(
      <CephSection
        {...props(draft)}
        view={view}
        clusters={[]}
        nodes={3}
        inventories={inventories}
        nodeNames={['a', 'b', 'c']}
      />
    );
    expect(screen.getByText('named: becomes an OSD')).toBeTruthy();
    expect(screen.getByText('blank: can be named')).toBeTruthy();
    expect(screen.getByText('LVM: a logical volume can be named')).toBeTruthy();
    // the pool counts the named host; mons every node
    expect(screen.getByText(/3 mons, 2 mgrs, pool/).textContent).toMatch(/1 with OSDs/);
    expect(screen.getByText(/of size 1/)).toBeTruthy();
    expect(screen.getByText(/every replica needs its own OSD host/)).toBeTruthy();
    expect(screen.getByText('Named devices are set: the two are exclusive.')).toBeTruthy();
    expect((screen.getByLabelText('Disks for Ceph') as HTMLInputElement).disabled).toBe(true);
  });

  it('lists the named devices among the creation inputs once the cluster exists', () => {
    const draft = rookOn({
      storage: { nodes: [{ name: 'a', devices: [{ name: '/dev/vg/ceph0' }] }] },
    });
    const ceph = cephClusterK4all();
    const view = rookView({
      spec: draft,
      cephClusters: [ceph],
      rm: releaseManifestV272(),
      nodes: three,
    });
    render(
      <CephSection {...props(draft)} view={view} clusters={[ceph]} nodes={3} inventories={null} />
    );
    expect(screen.getByText('a: /dev/vg/ceph0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a node' })).toBeNull();
  });
});

// ------------------------------------------------------------- cephcsi build

describe('CsiImagePanel (features.rook.csi.imageVariant, RookCSIImage)', () => {
  it.each([
    ['StandardImage', 'True', /^The standard cephcsi build/],
    ['OlderCPUNode', 'True', /a node reports a CPU below x86-64-v3/],
    ['NodeLevelUnknown', 'True', /a node's CPU level is unknown/],
    ['NodeLevelPending', 'True', /has not reported its CPU level yet/],
    ['Override', 'True', /^The cephcsi build the setting below forces$/],
    ['Override', 'False', /^The forced cephcsi build does not fit a node$/],
    ['ComponentOverride', 'True', /^A component override sets the cephcsi image/],
    ['CheckFailed', 'Unknown', /could not check which cephcsi build fits/],
  ])('shows %s (%s) in words with the message as written', (reason, status, title) => {
    render(
      <CsiImagePanel
        {...props(rookOn(), { status: condition('RookCSIImage', status, reason) })}
        nodes={three}
      />
    );
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText('as written')).toBeTruthy();
  });

  it('forces a build, and Auto removes the field', () => {
    const update = vi.fn();
    const draft = rookOn();
    render(<CsiImagePanel {...props(draft, { update })} nodes={three} />);
    choose('Ceph CSI image', 'Build for older CPUs');
    expect(applied(update, draft).features?.rook?.csi).toEqual({ imageVariant: 'OlderCPUs' });
    const forced = rookOn({ csi: { imageVariant: 'Standard' } });
    update.mockClear();
    render(<CsiImagePanel {...props(forced, { update })} nodes={three} />);
    fireEvent.mouseDown(screen.getAllByRole('combobox', { name: 'Ceph CSI image' })[1]);
    fireEvent.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: /^Auto: from the nodes/ })
    );
    expect(applied(update, forced).features?.rook).toEqual({ enabled: true });
  });

  it("shows each node's CPU level, and warns when Standard is forced on an older CPU", () => {
    const nodes = [
      nodeWithLevel('a', 'v3'),
      nodeWithLevel('b', 'v2'),
      nodeWithLevel('c'),
      nodeWithLevel('d', undefined, 'arm64'),
    ];
    const forced = rookOn({ csi: { imageVariant: 'Standard' } });
    const p = props(forced);
    p.issues.push({
      field: 'rookCSIImageVariant',
      severity: 'warning',
      message:
        'b reports x86-64-v2: the standard build cannot start there, and its Ceph volumes stop working.',
    });
    render(<CsiImagePanel {...p} nodes={nodes} />);
    expect(screen.getByText('a: x86-64-v3')).toBeTruthy();
    expect(screen.getByText('b: x86-64-v2')).toBeTruthy();
    expect(screen.getByText('c: no level reported')).toBeTruthy();
    expect(screen.getByText('d: arm64, either build')).toBeTruthy();
    expect(screen.getByText(/the standard build cannot start there/)).toBeTruthy();
  });
});

// ------------------------------------------------------------ crash collector

describe('CrashCollectorPanel (the CephCluster, not the ClusterConfig)', () => {
  it('shows the live value as Cairn left it, and turns it off on the CephCluster', async () => {
    const onSet = vi.fn(async () => undefined);
    const ceph = cephClusterK4all({ disable: false, daysToRetain: 7 }, 'Mozilla');
    render(
      <CrashCollectorPanel
        clusters={[ceph]}
        canPatch={{ 'rook-ceph/rook-ceph': true }}
        onSet={onSet}
      />
    );
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText(/Reports are kept 7 days. Last set by Mozilla./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('spec.crashCollector.disable: true')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(ceph, false));
  });

  it('shows an off collector with Turn on, and the refusal of a change made meanwhile', async () => {
    const onSet = vi.fn(async () => {
      throw new Error('The crash collector changed meanwhile (in Cairn?)');
    });
    render(
      <CrashCollectorPanel
        clusters={[cephClusterK4all({ disable: true }, 'k4all-operator-seed')]}
        canPatch={{ 'rook-ceph/rook-ceph': true }}
        onSet={onSet}
      />
    );
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText(/Last set by k4all, when it created the cluster/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText(/changed meanwhile \(in Cairn\?\)/)).toBeTruthy();
  });

  it('shows a viewer the value and no button; before the cluster, what k4all seeds', () => {
    const { unmount } = render(
      <CrashCollectorPanel clusters={[cephClusterK4all()]} canPatch={{}} onSet={vi.fn()} />
    );
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
    unmount();
    render(<CrashCollectorPanel clusters={[]} canPatch={{}} onSet={vi.fn()} />);
    expect(
      screen.getByText(/crash collector on, keeping crash reports for 30\s+days/)
    ).toBeTruthy();
  });

  it('writes a JSON Patch to the CephCluster with the k4all-headlamp field manager', async () => {
    const request = vi.mocked(ApiProxy.request);
    request.mockClear();
    request.mockResolvedValueOnce({});
    await setCrashCollector(cephClusterK4all(), false);
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/apis/ceph.rook.io/v1/namespaces/rook-ceph/cephclusters/rook-ceph?fieldManager=k4all-headlamp&fieldValidation=Strict'
    );
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json-patch+json'
    );
    expect(JSON.parse(init.body as string)).toEqual([
      { op: 'test', path: '/spec/crashCollector', value: { disable: false, daysToRetain: 30 } },
      { op: 'add', path: '/spec/crashCollector/disable', value: true },
    ]);
    // a failed test (changed meanwhile) is a conflict, said in words
    request.mockRejectedValueOnce({
      status: 422,
      message:
        'Unprocessable Entity - the server rejected our request due to an error in our request',
    });
    await expect(setCrashCollector(cephClusterK4all(), true)).rejects.toThrow(/changed meanwhile/);
  });
});

// ---------------------------------------------------------------- monitoring

describe('MonitoringPanel (features.rook.monitoring, RookMonitoring)', () => {
  const served = { serviceMonitors: true, prometheusRules: true };
  const missing = { serviceMonitors: false, prometheusRules: false };

  it('says before the switch is on that there is no Prometheus Operator, then turns it on', () => {
    const update = vi.fn();
    const draft = rookOn();
    render(<MonitoringPanel {...props(draft, { update })} apis={missing} />);
    expect(screen.getByText(/install a Prometheus Operator \(k4all ships none\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ceph metrics for Prometheus' }));
    expect(applied(update, draft).features?.rook?.monitoring).toEqual({ enabled: true });
  });

  it('says the APIs are served, and turning it off leaves no field behind', () => {
    const update = vi.fn();
    const draft = rookOn({ monitoring: { enabled: true } });
    render(<MonitoringPanel {...props(draft, { update })} apis={served} />);
    expect(screen.getByText(/serves ServiceMonitor and PrometheusRule/)).toBeTruthy();
    expect(screen.queryByText(/install a Prometheus Operator/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ceph metrics for Prometheus' }));
    expect(applied(update, draft).features?.rook).toEqual({ enabled: true });
  });

  it('adds, edits and removes labels, at most 8', () => {
    const update = vi.fn();
    const draft = rookOn({ monitoring: { enabled: true, labels: { release: 'kps' } } });
    render(<MonitoringPanel {...props(draft, { update })} apis={served} />);
    fireEvent.change(screen.getByLabelText('Value of label 1'), {
      target: { value: 'kube-prometheus-stack' },
    });
    expect(applied(update, draft).features?.rook?.monitoring?.labels).toEqual({
      release: 'kube-prometheus-stack',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add a label' }));
    expect(applied(update, draft).features?.rook?.monitoring?.labels).toEqual({
      release: 'kps',
      '': '',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove label release' }));
    expect(applied(update, draft).features?.rook?.monitoring).toEqual({ enabled: true });
  });

  it('offers no ninth label', () => {
    const labels = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'v']));
    render(<MonitoringPanel {...props(rookOn({ monitoring: { labels } }))} apis={served} />);
    expect(screen.queryByRole('button', { name: 'Add a label' })).toBeNull();
    expect(screen.getByText('8 of 8')).toBeTruthy();
  });

  it.each([
    ['Enabled', 'True', /^Ceph metrics on/],
    ['Disabled', 'False', /^Ceph metrics off$/],
    ['PrometheusOperatorMissing', 'False', /^No Prometheus Operator: k4all created nothing$/],
    ['CheckFailed', 'Unknown', /could not check for a Prometheus Operator/],
  ])('shows %s in words', (reason, status, title) => {
    render(
      <MonitoringPanel
        {...props(rookOn(), { status: condition('RookMonitoring', status, reason) })}
        apis={served}
      />
    );
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText('as written')).toBeTruthy();
  });

  it('shows a viewer the switch and labels, and no buttons', () => {
    const draft = rookOn({ monitoring: { enabled: true, labels: { release: 'kps' } } });
    render(<MonitoringPanel {...props(draft, { disabled: true })} apis={null} />);
    expect(screen.getByText('release=kps')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: 'Ceph metrics for Prometheus' }) as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.getByText('Checking for a Prometheus Operator…')).toBeTruthy();
  });
});

// -------------------------------------------------------------------- CephFS

describe('CephFsPanel (features.rook.filesystem.enabled)', () => {
  it('says what absent means, and writes on, off and back to absent', () => {
    const update = vi.fn();
    const draft = rookOn();
    render(<CephFsPanel {...props(draft, { update })} storageClasses={[]} />);
    expect(screen.getByText(/A cluster created before stays without it/)).toBeTruthy();
    expect(screen.getByText(/seLinuxOptions.level/)).toBeTruthy();
    expect(screen.getByText(/not created/)).toBeTruthy();
    choose('CephFS', 'On');
    expect(applied(update, draft).features?.rook?.filesystem).toEqual({ enabled: true });
    choose('CephFS', 'Off');
    expect(applied(update, draft).features?.rook?.filesystem).toEqual({ enabled: false });
  });

  it('clears the setting with Not set, and shows the StorageClass once created', () => {
    const update = vi.fn();
    const off = rookOn({ filesystem: { enabled: false } });
    render(
      <CephFsPanel
        {...props(off, { update })}
        storageClasses={[{ metadata: { name: 'ceph-cephfs' } }]}
      />
    );
    expect(screen.getByText(/k4all never creates CephFS/)).toBeTruthy();
    expect(screen.getByText(/present/)).toBeTruthy();
    choose('CephFS', /^Not set/);
    expect(applied(update, off).features?.rook).toEqual({ enabled: true });
  });

  it('is read-only for a viewer and with an older operator', () => {
    render(<CephFsPanel {...props(rookOn(), { caps: V060 })} storageClasses={null} />);
    expect(screen.getByRole('combobox', { name: 'CephFS' }).getAttribute('aria-disabled')).toBe(
      'true'
    );
    expect(screen.getByText(/checking…/)).toBeTruthy();
  });
});

// --------------------------------------------------------------- guest bridge

describe('HangarSection: the guest bridge switch', () => {
  const rm = releaseManifestV272();
  const virt = clusterConfigV270().spec!;

  it('turns the guest bridge off explicitly, and back on to the release default', () => {
    const update = vi.fn();
    render(
      <HangarSection
        {...props(virt, { update, base: virt })}
        components={rm.spec!.components!}
        statuses={{}}
      />
    );
    expect(screen.getByText(/Guest and Files tabs/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hangar guest bridge' }));
    const off = applied(update, virt);
    expect(off.features?.virt?.hangar).toEqual({ guestBridge: false });
  });

  it('removes the setting when turned back on', () => {
    const update = vi.fn();
    const off = setIn(virt, ['features', 'virt', 'hangar', 'guestBridge'], false);
    render(
      <HangarSection
        {...props(off, { update, base: off })}
        components={rm.spec!.components!}
        statuses={{}}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hangar guest bridge' }));
    expect(applied(update, off).features?.virt).toEqual({ enabled: true, emulation: 'auto' });
  });

  it('says when its APIService has been unavailable, as the operator writes it', () => {
    render(
      <HangarSection
        {...props(virt, { base: virt })}
        components={rm.spec!.components!}
        statuses={{
          'hangar-guest-bridge': {
            state: 'Installed',
            message:
              "installed but hook failed: APIService v1alpha1.subresources.hangar.magesgate.com unavailable for 12m (MissingEndpoints: no ready pods): the cluster's API discovery is incomplete until it is back; see the pods behind Service hangar-system/hangar-guest-bridge",
          },
        }}
      />
    );
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(
      screen.getByText(/^APIService v1alpha1.subresources.hangar.magesgate.com unavailable for 12m/)
    ).toBeTruthy();
    expect(screen.getByText(/removes its APIService first/)).toBeTruthy();
  });

  it('waits for k4all-operator v0.7.0', () => {
    render(
      <HangarSection
        {...props(virt, { base: virt, caps: V060 })}
        components={rm.spec!.components!}
        statuses={{}}
      />
    );
    expect(
      (screen.getByRole('checkbox', { name: 'Hangar guest bridge' }) as HTMLInputElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Hangar node agent' }) as HTMLInputElement).disabled
    ).toBe(false);
    expect(screen.getByText(/Coming with k4all-operator v0.7.0/)).toBeTruthy();
  });
});
