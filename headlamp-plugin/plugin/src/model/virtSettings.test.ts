import { kubevirtCR } from './fixtures';
import { ClusterConfigSpec, StorageClassLike, StorageProfileLike } from './types';
import { metadataIssues, vmStateInfo, vmStateIssues } from './virtSettings';

const sc = (name: string, isDefault = false): StorageClassLike => ({
  metadata: {
    name,
    annotations: isDefault ? { 'storageclass.kubernetes.io/is-default-class': 'true' } : {},
  },
  provisioner: 'x',
});
const profile = (name: string, ...sets: [string, string[]][]): StorageProfileLike => ({
  metadata: { name },
  status: {
    claimPropertySets: sets.map(([volumeMode, accessModes]) => ({ volumeMode, accessModes })),
  },
});
const withVmState = (name?: string): ClusterConfigSpec => ({
  features: { virt: { enabled: true, kubevirt: name ? { vmStateStorageClass: name } : undefined } },
});
const classes = [sc('topolvm-provisioner', true), sc('ceph-rbd'), sc('nfs')];

describe('vmStateInfo (KubeVirt backend-storage, v1.9.1)', () => {
  it('says where the VM state lives when k4all does not own it', () => {
    expect(
      vmStateInfo(withVmState(), { kv: kubevirtCR(), storageClasses: classes, profiles: [] })
    ).toMatchObject({
      owned: false,
      effective: 'topolvm-provisioner',
      how: 'default',
      access: 'RWO',
    });
    const kv = kubevirtCR('v1.9.1', { vmStateStorageClass: 'nfs' });
    expect(vmStateInfo(withVmState(), { kv, storageClasses: classes, profiles: [] })).toMatchObject(
      {
        owned: false,
        effective: 'nfs',
        how: 'kubevirt-cr',
      }
    );
  });

  it('reads the access mode from the Filesystem entries of the StorageProfile', () => {
    const ctx = (profiles: StorageProfileLike[]) => ({
      kv: kubevirtCR(),
      storageClasses: classes,
      profiles,
    });
    expect(
      vmStateInfo(withVmState('nfs'), ctx([profile('nfs', ['Filesystem', ['ReadWriteMany']])]))
        .access
    ).toBe('RWX');
    expect(
      vmStateInfo(
        withVmState('ceph-rbd'),
        ctx([profile('ceph-rbd', ['Filesystem', ['ReadWriteOnce']], ['Block', ['ReadWriteMany']])])
      ).access
    ).toBe('RWO');
    // block only: KubeVirt falls back to RWX Filesystem, which RBD cannot give
    expect(
      vmStateInfo(withVmState('ceph-rbd'), ctx([profile('ceph-rbd', ['Block', ['ReadWriteMany']])]))
    ).toMatchObject({
      owned: true,
      how: 'k4all',
      access: 'RWX',
      fallback: true,
    });
  });
});

describe('vmStateIssues', () => {
  const ctx = (profiles: StorageProfileLike[] = []) => ({
    kv: kubevirtCR(),
    storageClasses: classes,
    profiles,
  });
  const messages = (s: ClusterConfigSpec, profiles: StorageProfileLike[] = []) =>
    vmStateIssues(s, ctx(profiles)).map(i => `${i.severity}: ${i.message}`);

  it('warns about a StorageClass that does not exist', () => {
    expect(messages(withVmState('fast'))).toEqual([
      'warning: There is no StorageClass fast. k4all-operator writes it anyway and reports it in the KubeVirtSettings condition; VMs with persistent EFI or TPM state cannot start.',
    ]);
  });

  it('warns on RWO: KubeVirt copies the state at each live migration', () => {
    expect(
      messages(withVmState('ceph-rbd'), [profile('ceph-rbd', ['Filesystem', ['ReadWriteOnce']])])
    ).toEqual([
      'warning: ceph-rbd gives the VM state ReadWriteOnce volumes: KubeVirt copies the state to the target node at each live migration. It works; a ReadWriteMany class avoids the copy.',
    ]);
  });

  it('warns when the profile has no Filesystem entry: KubeVirt then asks for RWX Filesystem', () => {
    expect(
      messages(withVmState('ceph-rbd'), [profile('ceph-rbd', ['Block', ['ReadWriteMany']])])[0]
    ).toMatch(/^warning: The CDI StorageProfile of ceph-rbd lists no Filesystem access mode/);
    expect(messages(withVmState())).toEqual([]);
  });
});

describe('metadataIssues', () => {
  const md = (m: NonNullable<NonNullable<ClusterConfigSpec['features']>['virt']>['metadata']) =>
    metadataIssues({ features: { virt: { enabled: true, metadata: m } } }).map(
      i => `${i.field} ${i.severity}: ${i.message}`
    );

  it('keeps token lifetimes at 600 s or more', () => {
    expect(md({ enabled: true, tokens: { expirationSeconds: 300 } })).toEqual([
      'metadataExpiration error: Tokens live at least 600 seconds (kubelet refuses shorter projected tokens).',
    ]);
    expect(md({ enabled: true, tokens: { expirationSeconds: 3600 } })).toEqual([]);
  });

  it("refuses the API server's own audience", () => {
    expect(
      md({
        enabled: true,
        tokens: { audiences: ['k4all-metadata', 'https://kubernetes.default.svc.cluster.local'] },
      })
    ).toEqual([
      "metadataAudiences error: https://kubernetes.default.svc.cluster.local is the API server's audience: a token read inside a VM could then call the API server.",
    ]);
    expect(md({ enabled: true, tokens: { audiences: [' '] } })).toEqual([
      'metadataAudiences error: An audience cannot be empty.',
    ]);
  });

  it('checks the vendor-data ConfigMap name', () => {
    expect(md({ enabled: true, vendorDataConfigMap: 'k4all-vendor-data' })).toEqual([]);
    expect(md({ enabled: true, vendorDataConfigMap: 'Vendor_Data' })).toEqual([
      'metadataVendorData error: "Vendor_Data" is not a ConfigMap name (lowercase letters, digits, "-" and ".").',
    ]);
  });
});
