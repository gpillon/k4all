import { nodeWithCapacity, releaseManifestV270 } from './fixtures';
import { deviceFilterIssues, diskCandidates, rookDefaults, rookIssues, rookView } from './storage';
import { CephClusterLike, ClusterConfigSpec } from './types';

const ceph = (name = 'rook-ceph'): CephClusterLike => ({
  metadata: { name, namespace: 'rook-ceph' },
  status: { phase: 'Ready', ceph: { health: 'HEALTH_OK' } },
});
const rook = (r: NonNullable<ClusterConfigSpec['features']>['rook']): ClusterConfigSpec => ({
  features: { rook: r },
});
const three = ['a', 'b', 'c'].map(n => nodeWithCapacity(n, 4, 16));

describe('rookDefaults (RookHook, spec §9.2)', () => {
  it('counts mons, mgrs and the pool size from the nodes', () => {
    expect(rookDefaults(1)).toEqual({ mons: 1, mgrs: 1, poolSize: 1, needsAllow: true });
    expect(rookDefaults(2)).toEqual({ mons: 1, mgrs: 2, poolSize: 2, needsAllow: true });
    expect(rookDefaults(3)).toEqual({ mons: 3, mgrs: 2, poolSize: 3, needsAllow: false });
    expect(rookDefaults(4)).toEqual({ mons: 3, mgrs: 2, poolSize: 3, needsAllow: false });
    expect(rookDefaults(5)).toEqual({ mons: 5, mgrs: 2, poolSize: 3, needsAllow: false });
  });
});

describe('rookView', () => {
  const rm = releaseManifestV270();

  it('is a creation input until the CephCluster exists, then Cairn owns it', () => {
    const before = rookView({ spec: rook({ enabled: true }), cephClusters: [], rm, nodes: three });
    expect(before).toMatchObject({ enabled: true, created: false, offRefused: false });
    const after = rookView({
      spec: rook({ enabled: true }),
      cephClusters: [ceph()],
      rm,
      nodes: three,
    });
    expect(after).toMatchObject({ created: true, clusters: ['rook-ceph/rook-ceph'] });
  });

  it('refuses turning it off while a CephCluster exists, with the steps', () => {
    const r = releaseManifestV270();
    r.status!.components!['rook-ceph'] = {
      state: 'Installed',
      message: 'uninstall refused: CephCluster rook-ceph/rook-ceph exists',
    };
    const v = rookView({
      spec: rook({ enabled: false }),
      cephClusters: [ceph()],
      rm: r,
      nodes: three,
    });
    expect(v.offRefused).toBe(true);
    expect(v.notices).toEqual([
      { name: 'rook-ceph', kind: 'refused', text: 'CephCluster rook-ceph/rook-ceph exists' },
    ]);
    expect(v.offSteps.join(' ')).toMatch(/Cairn/);
    expect(v.offSteps.join(' ')).toMatch(/kubectl -n rook-ceph delete cephcluster rook-ceph/);
  });

  it('explains what happens below 3 nodes', () => {
    const one = [three[0]];
    expect(
      rookView({ spec: rook({ enabled: true }), cephClusters: [], rm, nodes: one }).small
    ).toEqual({
      nodes: 1,
      policy: 'Refuse',
      text: 'With 1 node and smallCluster Refuse, k4all creates no Ceph cluster: Ceph needs 3 nodes for redundancy.',
    });
    expect(
      rookView({
        spec: rook({ enabled: true, smallCluster: 'Allow' }),
        cephClusters: [],
        rm,
        nodes: one,
      }).small
    ).toEqual({
      nodes: 1,
      policy: 'Allow',
      text: 'No redundancy: 1 mon and a pool of size 1. A failed disk or node loses the data on it.',
    });
    expect(
      rookView({ spec: rook({ enabled: true }), cephClusters: [], rm, nodes: three }).small
    ).toBeUndefined();
  });
});

describe('deviceFilter', () => {
  it('must be a regular expression', () => {
    expect(deviceFilterIssues('^sd[b-c]$')).toEqual([]);
    expect(deviceFilterIssues('^sd[b')).toEqual([
      {
        field: 'rookDeviceFilter',
        severity: 'error',
        message: '"^sd[b" is not a valid regular expression.',
      },
    ]);
    expect(deviceFilterIssues(undefined)).toEqual([]);
  });

  it('marks the blank disks that match as OSDs, as Rook does', () => {
    const disks = [
      {
        name: 'sda',
        sizeBytes: 100,
        partitions: ['sda1'],
        signatures: ['gpt'],
        holders: [],
        mounts: [],
      },
      { name: 'sdb', sizeBytes: 200, partitions: [], signatures: [], holders: [], mounts: [] },
      {
        name: 'sdc',
        sizeBytes: 300,
        partitions: [],
        signatures: ['lvm'],
        holders: ['dm-0'],
        mounts: [],
      },
      { name: 'nvme0n1', sizeBytes: 400, partitions: [], signatures: [], holders: [], mounts: [] },
    ];
    expect(diskCandidates(disks, '^sd').map(d => [d.name, d.blank, d.matches, d.osd])).toEqual([
      ['sda', false, true, false],
      ['sdb', true, true, true],
      ['sdc', false, true, false],
      ['nvme0n1', true, false, false],
    ]);
    expect(
      diskCandidates(disks, undefined)
        .filter(d => d.osd)
        .map(d => d.name)
    ).toEqual(['sdb', 'nvme0n1']);
  });
});

describe('rookIssues', () => {
  it('warns about Allow on small clusters and validates the filter', () => {
    const issues = rookIssues(
      rook({ enabled: true, smallCluster: 'Allow', storage: { deviceFilter: '(' } }),
      {
        nodes: [three[0]],
        created: false,
      }
    );
    expect(issues.map(i => `${i.field} ${i.severity}`)).toEqual([
      'rookDeviceFilter error',
      'rookSmallCluster warning',
    ]);
    // once created, the creation inputs are not checked: they do nothing
    expect(
      rookIssues(rook({ enabled: true, storage: { deviceFilter: '(' } }), {
        nodes: three,
        created: true,
      })
    ).toEqual([]);
  });
});
