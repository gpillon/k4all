import { capabilitiesOf } from './capabilities';
import { describeChanges } from './changes';
import { componentActivation } from './components';
import {
  cephClusterK4all,
  clusterConfigV270,
  nodeWithLevel,
  releaseManifestV272,
} from './fixtures';
import { setIn } from './objects';
import { applyOps } from './patch';
import {
  crashCollectorOf,
  crashCollectorPatch,
  csiImageView,
  csiIssues,
  csiVariant,
  filesystemMode,
  isLogicalVolumePath,
  managerLabel,
  monitoringIssues,
  monitoringView,
  namedDeviceIssues,
  nodeCpuLevels,
  osdHosts,
  prometheusOperatorApis,
  rookReadyHint,
  setCsiVariant,
  setFilesystemMode,
  setStorageNodes,
} from './rookSettings';
import { diskCandidates, rookDefaults, rookIssues, rookView } from './storage';
import { ClusterConfigSpec, NodeLike, RookConfig } from './types';

const rook = (r: RookConfig): ClusterConfigSpec =>
  setIn(clusterConfigV270().spec!, ['features', 'rook'], r);
const three = ['a', 'b', 'c'].map(n => nodeWithLevel(n, 'v3'));
const issueTexts = (spec: ClusterConfigSpec, nodes: NodeLike[] = three) =>
  namedDeviceIssues(spec, nodes).map(i => [i.severity, i.message]);

describe('named devices (features.rook.storage.nodes)', () => {
  it('accepts devices named once per node in the cluster', () => {
    const spec = rook({
      enabled: true,
      storage: {
        nodes: [
          { name: 'a', devices: [{ name: '/dev/vg_data/ceph0' }, { name: '/dev/sdb' }] },
          { name: 'b', devices: [{ name: '/dev/disk/by-id/nvme-SAMPLE_1' }] },
        ],
      },
    });
    expect(namedDeviceIssues(spec, three)).toEqual([]);
    expect(osdHosts(spec, 3)).toBe(2);
  });

  it('refuses what the CRD or the operator refuse, and warns on what makes it wait', () => {
    const tainted = nodeWithLevel('c', 'v3');
    tainted.spec = {
      taints: [
        { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' },
        { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' },
      ],
    };
    const spec = rook({
      enabled: true,
      storage: {
        deviceFilter: '^sdb$',
        nodes: [
          { name: 'a', devices: [{ name: 'sdb' }, { name: '/dev/sdc' }, { name: '/dev/sdc' }] },
          { name: 'a', devices: [{ name: '/dev/sdd' }] },
          { name: 'gone', devices: [] },
          { name: 'c', devices: [{ name: '' }] },
          { name: '', devices: [{ name: '/dev/sde' }] },
        ],
      },
    });
    expect(issueTexts(spec, [three[0], three[1], tainted])).toEqual([
      ['error', 'Disks for Ceph and Named devices are exclusive: clear one of them.'],
      [
        'error',
        'Node a: "sdb" is not a device path (/dev/<vg>/<lv>, /dev/disk/by-id/<id> or /dev/<name>).',
      ],
      ['error', 'Node a: /dev/sdc is named twice.'],
      ['error', 'Node a is named twice.'],
      [
        'warning',
        'Node gone is not in the cluster: k4all creates the Ceph cluster once every named node is.',
      ],
      ['error', 'Node gone: name at least one device.'],
      [
        'warning',
        "Node c has a taint that keeps Rook's pods away (dedicated=gpu:NoSchedule): k4all waits until it goes.",
      ],
      ['error', 'Node c: a device path is empty.'],
      ['error', 'Entry 5: choose a node.'],
    ]);
  });

  it('keeps the limits of the CRD', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ name: `/dev/vg/lv${i}` }));
    expect(issueTexts(rook({ storage: { nodes: [{ name: 'a', devices: many }] } }))).toEqual([
      ['error', 'Node a: at most 32 devices (33 now).'],
    ]);
  });

  it('tells logical volumes from disks', () => {
    expect(isLogicalVolumePath('/dev/vg_data/ceph0')).toBe(true);
    expect(isLogicalVolumePath('/dev/disk/by-id/nvme-x')).toBe(false);
    expect(isLogicalVolumePath('/dev/mapper/vg-lv')).toBe(false);
    expect(isLogicalVolumePath('/dev/sdb')).toBe(false);
  });

  it('removes the list, and storage with it, when the last node goes', () => {
    const spec = rook({ enabled: true, storage: { nodes: [{ name: 'a', devices: [] }] } });
    expect(setStorageNodes(spec, []).features?.rook).toEqual({ enabled: true });
  });

  it('sizes the pool from the named hosts, the mons from every node', () => {
    expect(rookDefaults(3, 1)).toEqual({ mons: 3, mgrs: 2, poolSize: 1, needsAllow: true });
    expect(rookDefaults(5, 2)).toEqual({ mons: 5, mgrs: 2, poolSize: 2, needsAllow: true });
    const spec = rook({
      enabled: true,
      storage: { nodes: [{ name: 'a', devices: [{ name: '/dev/vg/ceph0' }] }] },
    });
    expect(rookView({ spec, cephClusters: [], rm: null, nodes: three }).small?.text).toBe(
      'With 1 named node and smallCluster Refuse, k4all creates no Ceph cluster: every replica needs its own OSD host, and Ceph needs 3.'
    );
    const allow = setIn(spec, ['features', 'rook', 'smallCluster'], 'Allow');
    expect(rookIssues(allow, { nodes: three, created: false })).toEqual([
      {
        field: 'rookSmallCluster',
        severity: 'warning',
        message:
          'Ceph on 1 named node has no redundancy (pool size 1): a failed disk or node loses data.',
      },
    ]);
  });

  it('checks the creation inputs only before the CephCluster exists', () => {
    const spec = rook({ enabled: true, storage: { nodes: [{ name: 'gone', devices: [] }] } });
    expect(rookIssues(spec, { nodes: three, created: true })).toEqual([]);
    expect(rookIssues(spec, { nodes: three, created: false }).length).toBe(2);
  });
});

describe('the disks per node with LVM and named devices', () => {
  const disks = [
    {
      name: 'sda',
      sizeBytes: 1,
      partitions: ['sda1', 'sda2'],
      signatures: ['gpt'],
      holders: ['dm-0', 'dm-1'],
      mounts: ['/boot'],
    },
    { name: 'sdb', sizeBytes: 1, partitions: [], signatures: [], holders: [], mounts: [] },
    {
      name: 'sdc',
      sizeBytes: 1,
      partitions: [],
      signatures: ['lvm'],
      holders: [],
      mounts: [],
      byId: ['wwn-0x5000c500a1b2c3d4'],
    },
    {
      name: 'sdd',
      sizeBytes: 1,
      partitions: [],
      signatures: ['luks'],
      holders: ['dm-3'],
      mounts: [],
    },
  ];

  it('marks the disks that hold LVM, whose logical volumes can be named', () => {
    expect(diskCandidates(disks, undefined).map(d => [d.name, d.osd, d.lvm])).toEqual([
      ['sda', false, true],
      ['sdb', true, false],
      ['sdc', false, true],
      ['sdd', false, false],
    ]);
  });

  it('with named devices, only the named blank disks become OSDs, by name or by-id', () => {
    const named = ['/dev/sdb', '/dev/disk/by-id/wwn-0x5000c500a1b2c3d4'];
    expect(diskCandidates(disks, undefined, named).map(d => [d.name, d.named, d.osd])).toEqual([
      ['sda', false, false],
      ['sdb', true, true],
      ['sdc', true, false],
      ['sdd', false, false],
    ]);
  });
});

describe('the cephcsi build (features.rook.csi, RookCSIImage)', () => {
  it('writes Auto as absent', () => {
    const spec = rook({ enabled: true });
    expect(csiVariant(spec)).toBe('Auto');
    const forced = setCsiVariant(spec, 'OlderCPUs');
    expect(forced.features?.rook?.csi).toEqual({ imageVariant: 'OlderCPUs' });
    expect(setCsiVariant(forced, 'Auto').features?.rook).toEqual({ enabled: true });
  });

  it.each([
    ['StandardImage', 'True', 'success', /^The standard cephcsi build/],
    ['OlderCPUNode', 'True', 'info', /reports a CPU below x86-64-v3$/],
    ['NodeLevelUnknown', 'True', 'info', /CPU level is unknown$/],
    ['NodeLevelPending', 'True', 'info', /has not reported its CPU level yet$/],
    ['Override', 'True', 'info', /^The cephcsi build the setting below forces$/],
    ['Override', 'False', 'warning', /^The forced cephcsi build does not fit a node$/],
    ['ComponentOverride', 'True', 'info', /^A component override sets the cephcsi image/],
    ['CheckFailed', 'Unknown', 'warning', /could not check/],
    ['SomethingNew', 'False', 'warning', /^cephcsi build: SomethingNew$/],
  ])('says in words what %s (%s) means', (reason, status, severity, title) => {
    const v = csiImageView({ type: 'RookCSIImage', status, reason, message: 'as written' });
    expect(v?.severity).toBe(severity);
    expect(v?.title).toMatch(title);
    expect(v?.message).toBe('as written');
  });

  it('says a component override can be dropped when Auto would choose the same', () => {
    const v = csiImageView({
      type: 'RookCSIImage',
      status: 'True',
      reason: 'ComponentOverride',
      message:
        'k4all sets no cephcsi image: componentOverrides rook-ceph csi.cephcsi names quay.io/cephcsi/cephcsi:v3.18.2-rocky9; Auto would choose quay.io/cephcsi/cephcsi:v3.18.2-rocky9 too: you can drop the override',
    });
    expect(v?.hint).toMatch(/^Auto would choose the same image: remove the override/);
    expect(
      csiImageView({ type: 'RookCSIImage', status: 'True', reason: 'ComponentOverride' })?.hint
    ).toMatch(/does nothing/);
  });

  it('reads the level of each node, and warns when Standard is forced on an older CPU', () => {
    const nodes = [
      nodeWithLevel('b', 'v2'),
      nodeWithLevel('a', 'v3'),
      nodeWithLevel('c'),
      nodeWithLevel('d', undefined, 'arm64'),
      nodeWithLevel('e', 'v9'),
    ];
    expect(nodeCpuLevels(nodes).map(n => [n.name, n.arch, n.level])).toEqual([
      ['a', 'amd64', 'v3'],
      ['b', 'amd64', 'v2'],
      ['c', 'amd64', null],
      ['d', 'arm64', null],
      ['e', 'amd64', null],
    ]);
    const standard = rook({ enabled: true, csi: { imageVariant: 'Standard' } });
    expect(csiIssues(standard, nodes)).toEqual([
      {
        field: 'rookCSIImageVariant',
        severity: 'warning',
        message:
          'b reports x86-64-v2: the standard build cannot start there, and its Ceph volumes stop working.',
      },
    ]);
    expect(csiIssues(rook({ enabled: true }), nodes)).toEqual([]);
  });
});

describe('the crash collector (the CephCluster, not the ClusterConfig)', () => {
  it('reads the live value and who set it', () => {
    expect(crashCollectorOf(cephClusterK4all())).toEqual({
      on: true,
      set: true,
      daysToRetain: 30,
      managers: ['k4all-operator-seed'],
    });
    // Turned off in Cairn (a browser's default field manager): shown as it is.
    const cairn = crashCollectorOf(cephClusterK4all({ disable: true }, 'Mozilla'));
    expect(cairn.on).toBe(false);
    expect(cairn.managers.map(managerLabel)).toEqual(['Mozilla']);
    expect(crashCollectorOf(cephClusterK4all(null))).toEqual({
      on: true,
      set: false,
      daysToRetain: undefined,
      managers: [],
    });
    expect(managerLabel('k4all-operator-seed')).toBe('k4all, when it created the cluster');
  });

  it('patches only spec.crashCollector.disable, guarded by the value read', () => {
    const c = cephClusterK4all({ disable: false, daysToRetain: 30 });
    const ops = crashCollectorPatch(c, false);
    expect(ops).toEqual([
      { op: 'test', path: '/spec/crashCollector', value: { disable: false, daysToRetain: 30 } },
      { op: 'add', path: '/spec/crashCollector/disable', value: true },
    ]);
    expect(applyOps(c, ops).spec?.crashCollector).toEqual({ disable: true, daysToRetain: 30 });
    // Changed meanwhile (in Cairn): the test fails, nothing is overwritten.
    const changed = cephClusterK4all({ disable: false, daysToRetain: 7 });
    expect(() => applyOps(changed, ops)).toThrow(/testing value/);
  });

  it('adds the field under a generation test when the CephCluster has none', () => {
    const c = cephClusterK4all(null);
    const ops = crashCollectorPatch(c, false);
    expect(ops).toEqual([
      { op: 'test', path: '/metadata/generation', value: 4 },
      { op: 'add', path: '/spec/crashCollector', value: { disable: true } },
    ]);
    expect(applyOps(c, ops).spec?.crashCollector).toEqual({ disable: true });
  });
});

describe('monitoring (features.rook.monitoring, RookMonitoring)', () => {
  it('reads the Prometheus Operator APIs from discovery', () => {
    expect(
      prometheusOperatorApis({
        resources: [{ name: 'servicemonitors' }, { name: 'prometheusrules' }, { name: 'probes' }],
      })
    ).toEqual({ serviceMonitors: true, prometheusRules: true });
    expect(prometheusOperatorApis(null)).toEqual({
      serviceMonitors: false,
      prometheusRules: false,
    });
  });

  it('warns once it is on without a Prometheus Operator, and checks the labels', () => {
    const missing = { serviceMonitors: true, prometheusRules: false };
    const spec = rook({
      enabled: true,
      monitoring: {
        enabled: true,
        labels: { release: 'kube-prometheus-stack', 'bad key!': 'x', team: '-x' },
      },
    });
    expect(monitoringIssues(spec, missing).map(i => [i.field, i.severity, i.message])).toEqual([
      ['rookMonitoringLabels', 'error', expect.stringMatching(/^"bad key!" is not a label key/)],
      [
        'rookMonitoringLabels',
        'error',
        expect.stringMatching(/^The value of team is not a label value/),
      ],
      [
        'rookMonitoringEnabled',
        'warning',
        'monitoring.coreos.com ServiceMonitor and PrometheusRule are not served: install a Prometheus Operator (k4all ships none). Until then k4all creates nothing.',
      ],
    ]);
    // Not known yet, or off: no warning.
    expect(monitoringIssues(rook({ monitoring: { enabled: true } }), null)).toEqual([]);
    expect(monitoringIssues(rook({ monitoring: {} }), missing)).toEqual([]);
  });

  it('allows at most 8 labels, with DNS-prefixed keys', () => {
    const labels = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']));
    expect(monitoringIssues(rook({ monitoring: { labels } }), null)).toEqual([
      { field: 'rookMonitoringLabels', severity: 'error', message: 'At most 8 labels (9 now).' },
    ]);
    expect(
      monitoringIssues(
        rook({ monitoring: { labels: { 'prometheus.example.com/scrape': 'yes' } } }),
        null
      )
    ).toEqual([]);
  });

  it.each([
    ['Enabled', 'True', 'success'],
    ['Disabled', 'False', 'info'],
    ['PrometheusOperatorMissing', 'False', 'warning'],
    ['CheckFailed', 'Unknown', 'warning'],
  ])('says in words what %s means', (reason, status, severity) => {
    const v = monitoringView({ type: 'RookMonitoring', status, reason, message: 'm' });
    expect(v?.severity).toBe(severity);
    expect(v?.message).toBe('m');
  });
});

describe('CephFS (features.rook.filesystem.enabled)', () => {
  it('writes on, off, and absent for the default', () => {
    const spec = rook({ enabled: true });
    expect(filesystemMode(spec)).toBe('default');
    const on = setFilesystemMode(spec, 'on');
    expect(on.features?.rook?.filesystem).toEqual({ enabled: true });
    expect(filesystemMode(setFilesystemMode(on, 'off'))).toBe('off');
    expect(setFilesystemMode(on, 'default').features?.rook).toEqual({ enabled: true });
  });
});

describe('RookReady of named devices (operator v0.7.0)', () => {
  it('says what to do for StorageNodesUnusable and NamedDevicesWithoutOSD only', () => {
    const hint = (reason: string) => rookReadyHint({ type: 'RookReady', status: 'False', reason });
    expect(hint('StorageNodesUnusable')).toMatch(/fix Named devices below, or the node/);
    expect(hint('NamedDevicesWithoutOSD')).toMatch(/rook-ceph-osd-prepare job.*--wipesignatures y/);
    expect(hint('NotEnoughNodes')).toBeUndefined();
  });
});

describe('the review of the v2.7.2 Rook and Hangar settings', () => {
  const caps = capabilitiesOf('v0.7.0');
  const rm = releaseManifestV272();
  const base = rook({ enabled: true });
  const changes = (draft: ClusterConfigSpec) =>
    describeChanges(base, draft, rm.spec!.components!, caps).map(i => [
      i.label,
      i.from,
      i.to,
      i.severity,
    ]);

  it('lists named devices and labels in words', () => {
    const draft = rook({
      enabled: true,
      storage: {
        nodes: [{ name: 'a', devices: [{ name: '/dev/vg/ceph0' }, { name: '/dev/sdb' }] }],
      },
      monitoring: { enabled: true, labels: { release: 'kps', team: 'ops' } },
    });
    expect(changes(draft)).toEqual([
      ['Ceph metrics for Prometheus', 'off', 'on', 'info'],
      ['Monitoring labels', 'none', 'release=kps, team=ops', 'info'],
      ['Named devices', 'none', 'a: /dev/vg/ceph0, /dev/sdb', 'info'],
    ]);
  });

  it('warns on a forced standard build and on creating CephFS', () => {
    expect(
      changes(
        rook({ enabled: true, csi: { imageVariant: 'Standard' }, filesystem: { enabled: true } })
      )
    ).toEqual([
      ['Ceph CSI image', 'Auto', 'Standard', 'warning'],
      ['CephFS', 'not set (with a new Ceph cluster)', 'on', 'warning'],
    ]);
  });

  it('says what turning the guest bridge off removes', () => {
    const off = setIn(base, ['features', 'virt', 'hangar', 'guestBridge'], false);
    const items = describeChanges(base, off, rm.spec!.components!, caps);
    expect(items.map(i => [i.label, i.to, i.severity])).toEqual([
      ['Hangar guest bridge', 'off', 'warning'],
    ]);
    expect(items[0].consequence).toMatch(/^Uninstalls hangar-guest-bridge, its APIService first/);
    expect(
      componentActivation('hangar-guest-bridge', rm.spec!.components!['hangar-guest-bridge'], off)
    ).toEqual({
      active: false,
      feature: 'virt',
      reason: "Hangar's guest bridge is turned off (features.virt.hangar.guestBridge: false).",
    });
    expect(
      componentActivation('hangar-guest-bridge', rm.spec!.components!['hangar-guest-bridge'], base)
        .active
    ).toBe(true);
  });
});
