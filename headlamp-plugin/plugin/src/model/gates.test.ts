import { kubevirtCR } from './fixtures';
import {
  appliedGates,
  cpuManagerGateMissing,
  GATE_TABLES,
  gateIssues,
  gateOn,
  gateRows,
  gateTableFor,
  hasDisabledList,
  liveGates,
  mergeGates,
  setK4allGate,
  wantedGates,
} from './gates';
import { setIn } from './objects';
import { ClusterConfigSpec } from './types';

const spec = (featureGates?: string[], disabledFeatureGates?: string[]): ClusterConfigSpec => ({
  features: { virt: { enabled: true, kubevirt: { featureGates, disabledFeatureGates } } },
});

describe('gate tables (Hangar gateTables.ts)', () => {
  it('picks the table of the KubeVirt minor, none for unknown versions', () => {
    expect(gateTableFor('v1.9.1')?.version).toBe('v1.9');
    expect(gateTableFor('1.8.4')?.version).toBe('v1.8');
    expect(gateTableFor('v1.10.0-rc.1')?.version).toBe('v1.10');
    expect(gateTableFor('v1.99.0')).toBeNull();
    expect(gateTableFor(undefined)).toBeNull();
  });

  it('knows disabledFeatureGates from KubeVirt 1.8', () => {
    expect(hasDisabledList('v1.7.4')).toBe(false);
    expect(hasDisabledList('v1.8.0')).toBe(true);
    expect(hasDisabledList('v1.11.0')).toBe(true);
    expect(hasDisabledList(undefined)).toBe(false);
  });
});

describe('gate lists', () => {
  it('reads the live lists and what k4all added (the annotations)', () => {
    const kv = kubevirtCR('v1.9.1', {
      featureGates: ['Sidecar', 'HostDevices'],
      disabledFeatureGates: ['Snapshot'],
      k4allOn: 'Sidecar, ',
      k4allOff: '',
    });
    expect(liveGates(kv)).toEqual({
      featureGates: ['Sidecar', 'HostDevices'],
      disabledFeatureGates: ['Snapshot'],
    });
    expect(appliedGates(kv)).toEqual({ featureGates: ['Sidecar'], disabledFeatureGates: [] });
    expect(appliedGates(null)).toEqual({ featureGates: [], disabledFeatureGates: [] });
    expect(wantedGates(spec(['VSOCK'], ['Snapshot']))).toEqual({
      featureGates: ['VSOCK'],
      disabledFeatureGates: ['Snapshot'],
    });
  });

  // The operator's VirtHook merge (spec §7.2).
  it('merges like the operator: keeps others, drops what k4all no longer wants', () => {
    const merged = mergeGates(
      { featureGates: ['HostDevices', 'Sidecar', 'VSOCK'], disabledFeatureGates: ['ImageVolume'] },
      { featureGates: ['Sidecar', 'VSOCK'], disabledFeatureGates: [] },
      { featureGates: ['VSOCK', 'DownwardMetrics'], disabledFeatureGates: ['Snapshot'] },
      true
    );
    expect(merged.featureGates.sort()).toEqual(['DownwardMetrics', 'HostDevices', 'VSOCK']);
    expect(merged.disabledFeatureGates.sort()).toEqual(['ImageVolume', 'Snapshot']);
  });

  it('turns off a gate others set, and never writes disabledFeatureGates before 1.8', () => {
    const live = { featureGates: ['HostDevices'], disabledFeatureGates: [] };
    const none = { featureGates: [], disabledFeatureGates: [] };
    const off = { featureGates: [], disabledFeatureGates: ['HostDevices'] };
    expect(mergeGates(live, none, off, true)).toEqual({
      featureGates: [],
      disabledFeatureGates: ['HostDevices'],
    });
    expect(mergeGates(live, none, off, false)).toEqual({
      featureGates: [],
      disabledFeatureGates: [],
    });
  });

  it('never writes both hot-plug gates: the live one wins', () => {
    const merged = mergeGates(
      { featureGates: ['HotplugVolumes'], disabledFeatureGates: [] },
      { featureGates: [], disabledFeatureGates: [] },
      { featureGates: ['DeclarativeHotplugVolumes'], disabledFeatureGates: [] },
      true
    );
    expect(merged.featureGates).toEqual(['HotplugVolumes']);
  });
});

describe('gateOn (KubeVirt featuregate.IsEnabled)', () => {
  const lists = (featureGates: string[] = [], disabledFeatureGates: string[] = []) => ({
    featureGates,
    disabledFeatureGates,
  });
  const v19 = gateTableFor('v1.9.1');
  const v18 = gateTableFor('v1.8.4');

  it('GA is always on, Alpha only when listed', () => {
    expect(gateOn(v19, lists([], ['VMPersistentState']), 'VMPersistentState')).toBe(true);
    expect(gateOn(v19, lists(), 'Sidecar')).toBe(false);
    expect(gateOn(v19, lists(['Sidecar']), 'Sidecar')).toBe(true);
  });

  it('Beta is on by default from 1.9 unless disabled, off before unless listed', () => {
    expect(gateOn(v19, lists(), 'Snapshot')).toBe(true);
    expect(gateOn(v19, lists([], ['Snapshot']), 'Snapshot')).toBe(false);
    expect(gateOn(v18, lists(), 'Snapshot')).toBe(false);
    expect(gateOn(v18, lists(['Snapshot']), 'Snapshot')).toBe(true);
  });

  it('cannot tell without a table, unless the gate is listed', () => {
    expect(gateOn(null, lists(), 'Snapshot')).toBeNull();
    expect(gateOn(null, lists(['Snapshot']), 'Snapshot')).toBe(true);
    expect(gateOn(null, lists([], ['Snapshot']), 'Snapshot')).toBe(false);
  });

  it('declarative hot-plug is off while HotplugVolumes is on', () => {
    expect(gateOn(v19, lists(), 'DeclarativeHotplugVolumes')).toBe(true);
    expect(gateOn(v19, lists(['HotplugVolumes']), 'DeclarativeHotplugVolumes')).toBe(false);
  });
});

describe('gateRows', () => {
  const kv = kubevirtCR('v1.9.1', {
    featureGates: ['Sidecar', 'HostDevices', 'VSOCK'],
    k4allOn: 'Sidecar,VSOCK',
  });

  it('tells k4all-owned gates from gates set elsewhere, by the annotation', () => {
    const rows = gateRows({ kv, spec: spec(['Sidecar', 'VSOCK']) });
    const row = (name: string) => rows.find(r => r.name === name)!;
    expect(row('Sidecar')).toMatchObject({
      owner: 'k4all',
      k4all: 'on',
      pending: false,
      maturity: 'Alpha',
      defaultOn: false,
      onNow: true,
      onAfter: true,
      canDisable: true,
    });
    expect(row('HostDevices')).toMatchObject({ owner: 'elsewhere', onNow: true, k4all: undefined });
    expect(row('Snapshot')).toMatchObject({
      owner: 'none',
      maturity: 'Beta',
      defaultOn: true,
      onNow: true,
    });
    expect(row('VMPersistentState')).toMatchObject({
      maturity: 'GA',
      defaultOn: true,
      canDisable: false,
    });
  });

  it('predicts the state after the operator applies a draft, and marks it pending', () => {
    const rows = gateRows({ kv, spec: spec(['Sidecar'], ['Snapshot']) });
    const row = (name: string) => rows.find(r => r.name === name)!;
    // k4all added VSOCK before; dropped from the ClusterConfig, the operator removes it
    expect(row('VSOCK')).toMatchObject({
      owner: 'none',
      onNow: true,
      onAfter: false,
      pending: true,
    });
    expect(row('Snapshot')).toMatchObject({
      owner: 'k4all',
      k4all: 'off',
      onNow: true,
      onAfter: false,
      pending: true,
    });
  });

  it('lists gates the table does not know, and works without a KubeVirt CR', () => {
    // no KubeVirt CR (virt off, or not installed yet): the release's version
    const rows = gateRows({ kv: null, version: 'v1.9.1', spec: spec(['MadeUpGate', 'Sidecar']) });
    expect(rows.find(r => r.name === 'MadeUpGate')).toMatchObject({
      owner: 'k4all',
      maturity: null,
      onNow: null,
      onAfter: false,
    });
    expect(rows.find(r => r.name === 'Sidecar')).toMatchObject({
      owner: 'k4all',
      onNow: null,
      onAfter: true,
      pending: false,
    });
    expect(gateRows({ kv: null, spec: spec(['Sidecar']) })[0]).toMatchObject({
      name: 'Sidecar',
      maturity: null,
    });
  });
});

describe('setK4allGate', () => {
  const kv = kubevirtCR('v1.9.1');

  it('puts a gate in one list or none, and leaves no empty lists behind', () => {
    let s = setK4allGate(spec(), 'Sidecar', 'on', { kv }).spec;
    expect(s.features?.virt?.kubevirt).toEqual({ featureGates: ['Sidecar'] });
    s = setK4allGate(s, 'Sidecar', 'off', { kv }).spec;
    expect(s.features?.virt?.kubevirt).toEqual({ disabledFeatureGates: ['Sidecar'] });
    s = setK4allGate(s, 'Sidecar', undefined, { kv }).spec;
    expect(s.features?.virt?.kubevirt).toBeUndefined();
    expect(s.features?.virt?.enabled).toBe(true);
  });

  it('keeps vmStateStorageClass when the gate lists empty', () => {
    const base: ClusterConfigSpec = {
      features: {
        virt: { kubevirt: { featureGates: ['Sidecar'], vmStateStorageClass: 'ceph-rbd' } },
      },
    };
    expect(setK4allGate(base, 'Sidecar', undefined, { kv }).spec.features?.virt?.kubevirt).toEqual({
      vmStateStorageClass: 'ceph-rbd',
    });
  });

  it('turns the other hot-plug gate off when one goes on', () => {
    // 1.9: DeclarativeHotplugVolumes is Beta, on by default
    const r = setK4allGate(spec(), 'HotplugVolumes', 'on', { kv });
    expect(r.spec.features?.virt?.kubevirt).toEqual({
      featureGates: ['HotplugVolumes'],
      disabledFeatureGates: ['DeclarativeHotplugVolumes'],
    });
    expect(r.also).toEqual(['DeclarativeHotplugVolumes']);
    // and back: the old one was only k4all's, dropping it is enough
    const back = setK4allGate(r.spec, 'DeclarativeHotplugVolumes', 'on', { kv });
    expect(back.spec.features?.virt?.kubevirt).toEqual({
      featureGates: ['DeclarativeHotplugVolumes'],
    });
    expect(back.also).toEqual(['HotplugVolumes']);
  });

  it('drops the rival from k4all on 1.8 without disabling it when it is off anyway', () => {
    const kv18 = kubevirtCR('v1.8.4');
    const r = setK4allGate(spec(['HotplugVolumes']), 'DeclarativeHotplugVolumes', 'on', {
      kv: kv18,
    });
    expect(r.spec.features?.virt?.kubevirt).toEqual({
      featureGates: ['DeclarativeHotplugVolumes'],
    });
    expect(r.also).toEqual(['HotplugVolumes']);
  });
});

describe('gateIssues', () => {
  const kv = kubevirtCR('v1.9.1', { featureGates: ['HotplugVolumes'] });
  const messages = (s: ClusterConfigSpec) =>
    gateIssues(s, { kv }).map(i => `${i.severity}: ${i.message}`);

  it('refuses a GA gate in the off list', () => {
    expect(messages(spec([], ['VMPersistentState']))).toEqual([
      'error: VMPersistentState is GA in KubeVirt v1.9: always on, it cannot be turned off.',
    ]);
  });

  it('refuses a gate in both lists and both hot-plug gates', () => {
    expect(messages(spec(['Sidecar'], ['Sidecar']))).toContain(
      'error: Sidecar cannot be both on and off.'
    );
    expect(messages(spec(['HotplugVolumes', 'DeclarativeHotplugVolumes']))).toContain(
      'error: HotplugVolumes turns DeclarativeHotplugVolumes off: set one.'
    );
  });

  it('warns about entries that do nothing and a live rival', () => {
    expect(messages(spec(['LiveMigration']))).toEqual([
      'warning: LiveMigration is GA in KubeVirt v1.9: always on, the entry does nothing.',
    ]);
    expect(messages(spec(['Macvtap', 'NoSuchGate']))).toEqual([
      'warning: Macvtap was removed from KubeVirt: the entry does nothing.',
      'warning: KubeVirt v1.9 does not know NoSuchGate: the entry does nothing.',
    ]);
    expect(messages(spec(['DeclarativeHotplugVolumes']))).toEqual([
      'warning: HotplugVolumes is on in the KubeVirt CR (set elsewhere): k4all-operator does not add DeclarativeHotplugVolumes while it is there. Turn HotplugVolumes off here too.',
    ]);
  });
});

describe('cpuManagerGateMissing (k4all#111)', () => {
  const staticVirt: ClusterConfigSpec = {
    features: { virt: { enabled: true } },
    nodes: { kubelet: { cpuManagerPolicy: 'static', reservedSystemCPUs: '0-1' } },
  };
  const off = kubevirtCR('v1.9.1', { featureGates: ['Sidecar'] });
  const on = kubevirtCR('v1.9.1', { featureGates: ['Sidecar', 'CPUManager'] });

  it('says so with the static policy, Virtualization on and the gate off in the KubeVirt CR', () => {
    expect(cpuManagerGateMissing(staticVirt, { kv: off })).toBe(true);
    expect(cpuManagerGateMissing(staticVirt, { kv: kubevirtCR('v1.9.1') })).toBe(true);
    expect(cpuManagerGateMissing(staticVirt, { kv: on })).toBe(false);
  });

  it('reads the CR, not the ClusterConfig: a gate k4all has yet to apply is still off', () => {
    const wanted = setIn(staticVirt, ['features', 'virt', 'kubevirt'], {
      featureGates: ['CPUManager'],
    });
    expect(cpuManagerGateMissing(wanted, { kv: off })).toBe(true);
    // on by k4all, or set elsewhere (Hangar, by hand): either way KubeVirt runs it
    const k4all = kubevirtCR('v1.9.1', { featureGates: ['CPUManager'], k4allOn: 'CPUManager' });
    expect(cpuManagerGateMissing(wanted, { kv: k4all })).toBe(false);
  });

  it('says nothing without the static policy or without Virtualization', () => {
    const none = setIn(staticVirt, ['nodes', 'kubelet', 'cpuManagerPolicy'], 'none');
    expect(cpuManagerGateMissing(none, { kv: off })).toBe(false);
    const notSet = setIn(staticVirt, ['nodes'], undefined);
    expect(cpuManagerGateMissing(notSet, { kv: off })).toBe(false);
    const virtOff = setIn(staticVirt, ['features', 'virt', 'enabled'], false);
    expect(cpuManagerGateMissing(virtOff, { kv: off })).toBe(false);
  });

  it('says nothing when the KubeVirt CR cannot be read', () => {
    expect(cpuManagerGateMissing(staticVirt, { kv: null })).toBe(false);
    expect(cpuManagerGateMissing(staticVirt, { kv: undefined, version: 'v1.9.1' })).toBe(false);
  });

  it('without a table for the version, the gate is off unless the CR lists it', () => {
    expect(cpuManagerGateMissing(staticVirt, { kv: kubevirtCR('v1.99.0') })).toBe(true);
    expect(
      cpuManagerGateMissing(staticVirt, {
        kv: kubevirtCR('v1.99.0', { featureGates: ['CPUManager'] }),
      })
    ).toBe(false);
  });

  it('takes the release version without one in the CR status', () => {
    const noStatus = { ...kubevirtCR('v1.9.1'), status: {} };
    expect(cpuManagerGateMissing(staticVirt, { kv: noStatus, version: 'v1.9.1' })).toBe(true);
  });

  it('follows the table: a gate on by default, unknown or Discontinued needs nothing', () => {
    const fake = (version: string, maturity?: 'Beta' | 'GA' | 'Discontinued') => ({
      version,
      source: 'test',
      betaOnByDefault: true,
      disabledList: true,
      gates: maturity ? { CPUManager: maturity } : {},
    });
    GATE_TABLES.push(
      fake('v1.95', 'Beta'),
      fake('v1.96', 'GA'),
      fake('v1.97', 'Discontinued'),
      fake('v1.98')
    );
    try {
      expect(cpuManagerGateMissing(staticVirt, { kv: kubevirtCR('v1.95.0') })).toBe(false);
      expect(
        cpuManagerGateMissing(staticVirt, {
          kv: kubevirtCR('v1.95.0', { disabledFeatureGates: ['CPUManager'] }),
        })
      ).toBe(true);
      expect(cpuManagerGateMissing(staticVirt, { kv: kubevirtCR('v1.96.0') })).toBe(false);
      expect(cpuManagerGateMissing(staticVirt, { kv: kubevirtCR('v1.97.0') })).toBe(false);
      expect(cpuManagerGateMissing(staticVirt, { kv: kubevirtCR('v1.98.0') })).toBe(false);
    } finally {
      GATE_TABLES.splice(GATE_TABLES.length - 4, 4);
    }
  });
});
