import {
  buildRows,
  componentActivation,
  componentNotice,
  componentNotices,
  displayState,
  releaseVersion,
  removalBlockers,
  summarize,
  upgradeProgress,
  visibleRows,
} from './components';
import { defaultClusterConfig, releaseManifest, releaseManifestV270 } from './fixtures';
import { setIn } from './objects';
import { compareSemver, parseSemver, sameVersion } from './semver';
import { ClusterConfigSpec, ComponentSpec } from './types';

const calico = (): ClusterConfigSpec => defaultClusterConfig().spec!;
const cilium = (): ClusterConfigSpec => setIn(calico(), ['networking', 'cni', 'type'], 'cilium');
const spec = (extra: Partial<ComponentSpec> = {}): ComponentSpec => ({
  type: 'helm',
  version: '1.0.0',
  ...extra,
});

describe('componentActivation (port of the operator shouldInstall)', () => {
  it('installs only the selected CNI and its CLI', () => {
    expect(componentActivation('calico', spec(), calico()).active).toBe(true);
    expect(componentActivation('cilium', spec(), calico())).toMatchObject({
      active: false,
      reason: 'Not used: the CNI is calico.',
    });
    expect(componentActivation('cilium-cli', spec(), cilium()).active).toBe(true);
    expect(componentActivation('calico', spec(), cilium()).active).toBe(false);
  });

  it('installs kube-vip only for HA type kubevip', () => {
    expect(componentActivation('kube-vip', spec(), calico()).active).toBe(false);
    expect(
      componentActivation('kube-vip', spec(), setIn(calico(), ['cluster', 'ha', 'type'], 'kubevip'))
        .active
    ).toBe(true);
  });

  it('skips MetalLB on Cilium without dedicated IPs (traefik, nginx or cilium keys)', () => {
    expect(componentActivation('metallb', spec(), calico()).active).toBe(true);
    expect(componentActivation('metallb', spec(), cilium()).active).toBe(false);
    expect(
      componentActivation(
        'metallb',
        spec(),
        setIn(cilium(), ['ingress', 'nginx', 'dedicatedIP'], '10.0.0.1')
      ).active
    ).toBe(true);
    // operator v0.4.0 counts the Traefik IP too (k4all-operator#7)
    expect(
      componentActivation(
        'metallb',
        spec(),
        setIn(cilium(), ['ingress', 'traefik', 'dedicatedIP'], '10.0.0.1')
      ).active
    ).toBe(true);
  });

  it('follows feature gates, then the name-based fallbacks', () => {
    const gated = spec({ featureGate: 'virt' });
    expect(componentActivation('kubevirt', gated, calico())).toMatchObject({
      active: false,
      feature: 'virt',
    });
    expect(
      componentActivation('kubevirt', gated, setIn(calico(), ['features', 'virt', 'enabled'], true))
        .active
    ).toBe(true);
    expect(componentActivation('argocd', spec(), calico())).toMatchObject({
      active: false,
      feature: 'argocd',
    });
    expect(
      componentActivation(
        'ovs-cni',
        spec(),
        setIn(calico(), ['features', 'ovsCni', 'enabled'], true)
      ).active
    ).toBe(true);
    expect(componentActivation('x', spec({ featureGate: 'nope' }), calico()).active).toBe(false);
    expect(componentActivation('traefik', spec(), calico()).active).toBe(true);
  });

  // Operator v0.6.0 engine.FeatureEnabled: the rook gate is features.rook.enabled
  // (a pointer: absent on clusters without Rook, and pruned by older CRDs).
  it('follows features.rook.enabled for the rook gate', () => {
    const rook = spec({ featureGate: 'rook' });
    expect(componentActivation('cairn', rook, calico())).toEqual({
      active: false,
      feature: 'rook',
      reason: 'Rook/Ceph storage is off.',
    });
    const on = setIn(calico(), ['features', 'rook', 'enabled'], true);
    expect(componentActivation('rook-ceph', rook, on)).toEqual({ active: true, feature: 'rook' });
  });

  it("leaves Hangar's node agent out when features.virt.hangar.nodeAgent is false", () => {
    const virt = spec({ featureGate: 'virt' });
    const on = setIn(calico(), ['features', 'virt', 'enabled'], true);
    // absent: the release default installs it with virt
    expect(componentActivation('hangar-node-agent', virt, on).active).toBe(true);
    expect(
      componentActivation(
        'hangar-node-agent',
        virt,
        setIn(on, ['features', 'virt', 'hangar', 'nodeAgent'], true)
      ).active
    ).toBe(true);
    expect(
      componentActivation(
        'hangar-node-agent',
        virt,
        setIn(on, ['features', 'virt', 'hangar', 'nodeAgent'], false)
      )
    ).toEqual({
      active: false,
      feature: 'virt',
      reason: "Hangar's node agent is turned off (features.virt.hangar.nodeAgent: false).",
    });
    // virt off says so first
    expect(componentActivation('hangar-node-agent', virt, calico()).reason).toBe(
      'Virtualization is off.'
    );
  });

  // Operator v0.6.0 gate virtMetadata (k4all-metadata): virt and
  // features.virt.metadata.enabled.
  it('installs the metadata service with the virtMetadata gate', () => {
    const gated = spec({ type: 'manifest', featureGate: 'virtMetadata' });
    const on = setIn(calico(), ['features', 'virt', 'enabled'], true);
    expect(componentActivation('k4all-metadata', gated, calico())).toEqual({
      active: false,
      feature: 'virt',
      reason: 'Virtualization is off.',
    });
    expect(componentActivation('k4all-metadata', gated, on)).toEqual({
      active: false,
      feature: 'virt',
      reason: 'The metadata service is off (features.virt.metadata.enabled).',
    });
    expect(
      componentActivation(
        'k4all-metadata',
        gated,
        setIn(on, ['features', 'virt', 'metadata', 'enabled'], true)
      )
    ).toEqual({ active: true, feature: 'virt' });
  });

  // Operator v0.6.0 gate snapshots (snapshot-controller): virt or Rook.
  it('installs what the snapshots gate covers with virt or Rook', () => {
    const sc = spec({ type: 'manifest', featureGate: 'snapshots' });
    expect(componentActivation('snapshot-controller', sc, calico())).toEqual({
      active: false,
      anyOf: ['virt', 'rook'],
      reason: 'Needs Virtualization or Rook/Ceph storage.',
    });
    for (const feature of ['virt', 'rook']) {
      expect(
        componentActivation(
          'snapshot-controller',
          sc,
          setIn(calico(), ['features', feature, 'enabled'], true)
        )
      ).toEqual({ active: true, anyOf: ['virt', 'rook'] });
    }
    // like the operator, the gate decides, not the name
    expect(
      componentActivation(
        'snapshot-controller',
        spec({ featureGate: 'virt' }),
        setIn(calico(), ['features', 'rook', 'enabled'], true)
      ).active
    ).toBe(false);
  });

  it("leaves Hangar's node agent out with nodeAgent false whatever its gate (by name, as the operator)", () => {
    const off = setIn(calico(), ['features', 'virt', 'hangar', 'nodeAgent'], false);
    expect(componentActivation('hangar-node-agent', spec({ type: 'manifest' }), off)).toEqual({
      active: false,
      reason: "Hangar's node agent is turned off (features.virt.hangar.nodeAgent: false).",
    });
  });

  it('says what the kubevirt-manager removal keeps (k4all v2.7.0)', () => {
    const removed = spec({ type: 'manifest', management: 'Removed', featureGate: 'virt' });
    const reason = componentActivation('kubevirt-manager', removed, calico()).reason!;
    expect(reason).toMatch(/^Removed: replaced by Hangar\./);
    expect(reason).toMatch(/vm-standard and vm-preemptible while VMs or pods name them/);
    expect(reason).toMatch(/images\.kubevirt-manager\.io/);
    expect(componentActivation('traefik', spec({ management: 'Removed' }), calico()).reason).toBe(
      'Removed: the operator uninstalls it.'
    );
  });

  it('leaves Unmanaged and Removed components out', () => {
    expect(componentActivation('traefik', spec({ management: 'Unmanaged' }), calico()).active).toBe(
      false
    );
    expect(componentActivation('traefik', spec({ management: 'Removed' }), calico()).active).toBe(
      false
    );
  });
});

describe('semver', () => {
  it('parses leniently and orders pre-releases first', () => {
    expect(parseSemver('v1.2')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: [] });
    expect(parseSemver('latest')).toBeNull();
    expect(compareSemver(parseSemver('1.0.0-rc.1')!, parseSemver('1.0.0')!)).toBeLessThan(0);
    expect(compareSemver(parseSemver('1.0.0-rc.2')!, parseSemver('1.0.0-rc.10')!)).toBeLessThan(0);
    expect(sameVersion('v0.46.0', '0.46.0')).toBe(true);
  });
});

describe('upgradeProgress (port of engine.UpgradeStep)', () => {
  const certManager = releaseManifest().spec!.components!['cert-manager'];

  it('lists the path versions strictly between installed and target, then the target', () => {
    expect(upgradeProgress(certManager, 'v1.17.4')).toEqual({
      remaining: ['v1.18.6', 'v1.19.6', 'v1.20.5', 'v1.21.3'],
      next: 'v1.18.6',
    });
  });

  it('is null at the target and for fresh installs', () => {
    expect(upgradeProgress(certManager, 'v1.21.3')).toBeNull();
    expect(upgradeProgress(certManager, undefined)).toBeNull();
  });

  it('goes straight to the target for downgrades and non-semver versions', () => {
    expect(upgradeProgress(certManager, 'v1.22.0')).toEqual({
      remaining: ['v1.21.3'],
      next: 'v1.21.3',
    });
    expect(upgradeProgress({ type: 'manifest', version: 'main' }, 'abc')).toEqual({
      remaining: ['main'],
      next: 'main',
    });
  });
});

describe('buildRows and summarize', () => {
  const rows = buildRows(releaseManifest(), calico());
  const row = (name: string) => rows.find(r => r.name === name)!;

  it('computes reverse dependencies over active components only', () => {
    expect(row('cert-manager').requiredBy).toEqual(['headlamp', 'traefik']);
    expect(row('traefik').dependsOn).toEqual(['cert-manager', 'metallb']); // ingress-nginx is Removed
    expect(row('metallb').dependsOn).toEqual(['calico']); // cilium is inactive on calico
  });

  it('shows upgrade progress and state', () => {
    expect(row('cert-manager').upgrade?.next).toBe('v1.18.6');
    expect(row('cert-manager').state).toEqual({ label: 'Upgrading', tone: 'info', busy: true });
    expect(row('kubevirt').state.label).toBe('Off');
    expect(row('ingress-nginx').management).toBe('Removed');
  });

  it('summarizes the release', () => {
    const s = summarize(rows);
    expect(s.total).toBe(21);
    expect(s.installed).toBe(6);
    expect(s.failed).toBe(0);
    expect(s.upgrading).toBe(1);
  });

  it('marks a pending force-resync', () => {
    const rm = releaseManifest();
    rm.metadata.annotations = { 'k4all.magesgate.com/force-resync': 'traefik' };
    const r = buildRows(rm, calico());
    expect(r.find(x => x.name === 'traefik')!.resyncPending).toBe(true);
    expect(r.find(x => x.name === 'headlamp')!.resyncPending).toBe(false);
  });
});

describe('componentNotice', () => {
  // The prefixes k4all-operator v0.6.0 writes (release_controller.go): a refused
  // uninstall keeps the component installed; "waiting: " is a neutral wait (D23).
  it('reads refused uninstalls and waits from the status message', () => {
    expect(
      componentNotice({ state: 'Installed', message: 'uninstall refused: 2 VirtualMachines exist' })
    ).toEqual({ kind: 'refused', text: '2 VirtualMachines exist' });
    expect(
      componentNotice({ state: 'Installed', message: 'waiting: fewer than 3 schedulable nodes' })
    ).toEqual({ kind: 'waiting', text: 'fewer than 3 schedulable nodes' });
    expect(componentNotice({ state: 'Failed', message: 'helm: timeout' })).toBeUndefined();
    expect(componentNotice(undefined)).toBeUndefined();
  });

  it('lists every component with one, by name', () => {
    const rm = releaseManifestV270();
    rm.status!.components!.kubevirt = {
      state: 'Installed',
      message: 'uninstall refused: VMs exist',
    };
    rm.status!.components!['rook-ceph'] = { state: 'Installed', message: 'waiting: 1 node' };
    expect(componentNotices(rm)).toEqual([
      { name: 'kubevirt', kind: 'refused', text: 'VMs exist' },
      { name: 'rook-ceph', kind: 'waiting', text: '1 node' },
    ]);
  });
});

describe('categories', () => {
  it('files the k4all v2.7.0 components', () => {
    const rows = buildRows(releaseManifestV270(), calico());
    const category = (name: string) => rows.find(r => r.name === name)!.category;
    expect(category('hangar')).toBe('Virtualization');
    expect(category('hangar-node-agent')).toBe('Virtualization');
    expect(category('k4all-metadata')).toBe('Virtualization');
    expect(category('cairn')).toBe('Storage');
    expect(category('rook-ceph')).toBe('Storage');
    expect(category('ceph-csi-drivers')).toBe('Storage');
    expect(category('snapshot-controller')).toBe('Storage');
    expect(rows.filter(r => r.category === 'Other').map(r => r.name)).toEqual([]);
  });
});

describe('displayState', () => {
  it('maps operator states to labels and tones', () => {
    expect(displayState({ state: 'Failed' }, { active: true }).tone).toBe('error');
    expect(displayState({ state: 'Unmanaged' }, { active: false }).tone).toBe('warning');
    expect(displayState(undefined, { active: true }).label).toBe('Not reconciled yet');
    expect(displayState(undefined, { active: false }).label).toBe('Off');
  });
});

describe('removalBlockers', () => {
  const rows = buildRows(releaseManifest(), calico());
  const blockers = (name: string) => removalBlockers(rows.find(r => r.name === name)!, calico());

  it('protects the operator, the dashboard, the CNI and dependencies', () => {
    expect(blockers('k4all-operator')[0]).toMatch(/operator itself/);
    expect(blockers('headlamp')[0]).toMatch(/dashboard/);
    expect(blockers('calico')).toContain('It is the cluster CNI.');
    expect(blockers('cert-manager')).toContain('Required by headlamp, traefik.');
  });

  it('points feature components to the feature switch', () => {
    expect(blockers('kubevirt')).toEqual(['Turn off Virtualization in Settings instead.']);
    const v270 = buildRows(releaseManifestV270(), calico());
    expect(removalBlockers(v270.find(r => r.name === 'rook-ceph')!, calico())).toEqual([
      'Turn off Rook/Ceph storage in Settings > Storage instead.',
    ]);
  });

  it('allows removing a leaf component', () => {
    expect(blockers('kube-vip')).toEqual([]);
  });
});

describe('releaseVersion', () => {
  it('reads the k4all release from the OS image tag', () => {
    expect(releaseVersion(releaseManifest())).toBe('v2.6.0');
    const rm = releaseManifest();
    rm.spec!.osImage!.imageTag = 'latest';
    expect(releaseVersion(rm)).toBeNull();
  });
});

describe('visibleRows', () => {
  it('hides components the release Removed unless asked', () => {
    const rows = buildRows(releaseManifest(), defaultClusterConfig().spec!);
    expect(rows.some(r => r.name === 'ingress-nginx')).toBe(true);
    expect(visibleRows(rows, false).some(r => r.name === 'ingress-nginx')).toBe(false);
    expect(visibleRows(rows, false).some(r => r.name === 'kubevirt-manager')).toBe(false);
    expect(visibleRows(rows, false)).toHaveLength(rows.length - 2);
    expect(visibleRows(rows, true)).toHaveLength(rows.length);
  });
});
