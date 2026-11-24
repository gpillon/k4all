import { capabilitiesOf } from './capabilities';
import {
  describeChanges,
  formatValue,
  needsAcknowledgement,
  reappliedComponents,
  serverAdjustments,
} from './changes';
import {
  clusterConfigNginx,
  clusterConfigV270,
  defaultClusterConfig,
  releaseManifest,
  releaseManifestNginx,
  releaseManifestV270,
} from './fixtures';
import { setIn } from './objects';
import { setIngress, setOverride, setTraefik } from './settings';

const base = () => defaultClusterConfig().spec!;
const components = () => releaseManifest().spec!.components!;

describe('describeChanges', () => {
  it('lists nothing for an unchanged draft', () => {
    expect(describeChanges(base(), base(), components())).toEqual([]);
  });

  it('explains what turning a feature on installs', () => {
    const items = describeChanges(
      base(),
      setIn(base(), ['features', 'virt', 'enabled'], true),
      components()
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: 'Virtualization',
      from: 'off',
      to: 'on',
      severity: 'info',
    });
    expect(items[0].consequence).toBe(
      'Installs cdi, hangar, hangar-node-agent, kubevirt, virtctl. This takes a few minutes.'
    );
    expect(needsAcknowledgement(items)).toBe(false);
  });

  it('flags turning a feature off as dangerous', () => {
    const on = setIn(base(), ['features', 'argocd', 'enabled'], true);
    const items = describeChanges(on, base(), components());
    expect(items[0]).toMatchObject({ severity: 'danger', to: 'off' });
    expect(items[0].consequence).toMatch(/^Uninstalls argocd\./);
    expect(needsAcknowledgement(items)).toBe(true);
  });

  it('says that k4all-operator v0.5.7 keeps virtualization while VMs and their disks exist', () => {
    const on = setIn(base(), ['features', 'virt', 'enabled'], true);
    const [item] = describeChanges(on, base(), components(), capabilitiesOf('v0.5.7'));
    expect(item).toMatchObject({ key: 'features.virt.enabled', severity: 'danger', to: 'off' });
    expect(item.consequence).toBe(
      'Uninstalls cdi, hangar, hangar-node-agent, kubevirt, virtctl once nothing runs on them: ' +
        'k4all-operator keeps KubeVirt while VirtualMachines or ' +
        'VirtualMachineInstances exist, and CDI while DataVolumes or PVCs made by CDI exist, and ' +
        'this switch shows what is left. Back up the VM disks you need, then delete the VMs and ' +
        'DataVolumes.'
    );
  });

  // k4all v2.6.x: kubevirt-manager is still installed, and v0.5.7 keeps it
  // while VMs exist too (from v2.7.0 the release removes it).
  it('names kubevirt-manager among what is kept where the release still installs it', () => {
    const on = setIn(base(), ['features', 'virt', 'enabled'], true);
    const v266 = {
      ...components(),
      'kubevirt-manager': {
        type: 'manifest',
        version: 'v1.5.4',
        featureGate: 'virt',
        dependsOn: ['kubevirt'],
      },
    };
    const [item] = describeChanges(on, base(), v266, capabilitiesOf('v0.5.7'));
    expect(item.consequence).toMatch(
      /^Uninstalls cdi, hangar, hangar-node-agent, kubevirt, kubevirt-manager, virtctl once/
    );
    expect(item.consequence).toMatch(/keeps KubeVirt and kubevirt-manager while VirtualMachines/);
  });

  it('warns that k4all-operator before v0.5.7 deletes KubeVirt and CDI from under running VMs', () => {
    const on = setIn(base(), ['features', 'virt', 'enabled'], true);
    // v0.5.6, published without the guard, among them
    for (const caps of [capabilitiesOf('v0.5.6'), capabilitiesOf('v0.5.5'), capabilitiesOf(null)]) {
      const [item] = describeChanges(on, base(), components(), caps);
      expect(item.consequence).toMatch(
        /^Uninstalls cdi, hangar, hangar-node-agent, kubevirt, virtctl at once, even while VMs run: KubeVirt and CDI are deleted from under them/
      );
      expect(item.consequence).toMatch(/k4all-operator v0\.5\.7 \(k4all v2\.6\.6\)/);
    }
  });

  it('describes a Traefik address change once', () => {
    const items = describeChanges(
      base(),
      setTraefik(base(), { dedicatedIP: '192.168.1.240' }),
      components()
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: 'Traefik address',
      from: 'node address',
      to: '192.168.1.240',
      severity: 'warning',
    });
  });

  it('names ingress-nginx on clusters that still run it', () => {
    const spec = clusterConfigNginx().spec!;
    const items = describeChanges(
      spec,
      setIngress(spec, 'nginx', { dedicatedIP: '192.168.1.240', isDefault: false }),
      releaseManifestNginx().spec!.components!
    );
    expect(items.map(i => [i.key, i.label])).toEqual([
      ['ingress.nginx.dedicatedIP', 'ingress-nginx address'],
      ['ingress.nginx.isDefault', 'ingress-nginx is the default IngressClass'],
    ]);
  });

  it('flags a CNI switch and the OVS bridge as dangerous (operator v0.7.0)', () => {
    const items = describeChanges(
      base(),
      setIn(
        setIn(base(), ['networking', 'cni', 'type'], 'cilium'),
        ['features', 'ovsBridge', 'enabled'],
        false
      ),
      components()
    );
    expect(items.map(i => [i.key, i.severity])).toEqual([
      ['features.ovsBridge.enabled', 'danger'],
      ['networking.cni.type', 'danger'],
    ]);
    expect(items[1].consequence).toMatch(/migrates the pod network/);
    expect(needsAcknowledgement(items)).toBe(true);
  });

  it('notes the move of legacy nginx settings to the traefik key', () => {
    const legacy = { ingress: { nginx: { dedicatedIP: '', isDefault: true } } };
    const items = describeChanges(legacy, setTraefik(legacy, {}), components());
    expect(items.map(i => i.key)).toEqual(['ingress.traefik']);
  });

  it('warns that Cilium options restart the agents', () => {
    const items = describeChanges(
      base(),
      setIn(base(), ['networking', 'cni', 'cilium', 'hubble'], true),
      components()
    );
    expect(items[0]).toMatchObject({
      label: 'Hubble',
      from: 'not set',
      to: 'on',
      severity: 'warning',
    });
    expect(items[0].consequence).toMatch(/agents restart/);
  });

  it('groups override edits per component', () => {
    const draft = setOverride(base(), 'traefik', { values: { a: 1, b: { c: 2 } } });
    const items = describeChanges(base(), draft, components());
    expect(items).toEqual([
      expect.objectContaining({ key: 'componentOverrides.traefik', from: 'none', to: 'changed' }),
    ]);
  });
});

describe('describeChanges, k4all v2.7.0 settings', () => {
  const v270 = () => clusterConfigV270().spec!;
  const c270 = () => releaseManifestV270().spec!.components!;
  const caps = capabilitiesOf('v0.6.0');

  it('turns Rook on with what it installs, the snapshot controller only when new', () => {
    const noVirt = setIn(v270(), ['features', 'virt', 'enabled'], false);
    const [item] = describeChanges(
      noVirt,
      setIn(noVirt, ['features', 'rook'], { enabled: true }),
      c270(),
      caps
    );
    expect(item).toMatchObject({ key: 'features.rook.enabled', label: 'Rook/Ceph storage' });
    expect(item.consequence).toBe(
      'Installs cairn, ceph-csi-drivers, rook-ceph, snapshot-controller. This takes a few minutes.'
    );
    // virt already brings the snapshot controller
    const [withVirt] = describeChanges(
      v270(),
      setIn(v270(), ['features', 'rook'], { enabled: true }),
      c270(),
      caps
    );
    expect(withVirt.consequence).toBe(
      'Installs cairn, ceph-csi-drivers, rook-ceph. This takes a few minutes.'
    );
  });

  it('turns Rook off as dangerous, kept while a CephCluster exists', () => {
    const on = setIn(v270(), ['features', 'rook'], { enabled: true });
    const [item] = describeChanges(
      on,
      setIn(on, ['features', 'rook', 'enabled'], false),
      c270(),
      caps
    );
    expect(item).toMatchObject({ severity: 'danger', to: 'off' });
    expect(item.consequence).toMatch(/while a CephCluster exists/);
    expect(item.consequence).toMatch(/never wipes disks/);
  });

  it('describes each gate k4all turns on or off, once', () => {
    const draft = setIn(v270(), ['features', 'virt', 'kubevirt'], {
      featureGates: ['Sidecar'],
      disabledFeatureGates: ['Snapshot'],
    });
    const items = describeChanges(v270(), draft, c270(), caps);
    expect(items.map(i => [i.key, i.from, i.to, i.severity])).toEqual([
      ['features.virt.kubevirt.gates.Sidecar', 'not set by k4all', 'on', 'info'],
      ['features.virt.kubevirt.gates.Snapshot', 'not set by k4all', 'off', 'warning'],
    ]);
    expect(items[1].consequence).toMatch(/even where Hangar or an admin set it/);
  });

  it('describes node settings by what the nodes do', () => {
    const items = describeChanges(
      v270(),
      setIn(v270(), ['nodes'], { kubelet: { maxPods: 250 }, hugepages: { '1Gi': 2 } }),
      c270(),
      caps
    );
    expect(items.map(i => [i.key, i.label, i.from, i.to, i.severity])).toEqual([
      ['nodes.hugepages.1Gi', '1 GiB hugepages per node', 'not set by k4all', '2', 'danger'],
      ['nodes.kubelet.maxPods', 'Max pods per node', 'not set by k4all', '250', 'danger'],
    ]);
    expect(items[0].consequence).toMatch(/drained and reboots/);
    // maxPods alone: kubelet restarts without a drain, a warning
    const [only] = describeChanges(
      v270(),
      setIn(v270(), ['nodes', 'kubelet', 'maxPods'], 250),
      c270(),
      caps
    );
    expect(only).toMatchObject({ severity: 'warning' });
    expect(only.consequence).toMatch(/without a drain/);
    // clearing it: kubelet-config gets back what it had before k4all
    const set = setIn(v270(), ['nodes', 'kubelet', 'maxPods'], 200);
    const [cleared] = describeChanges(set, v270(), c270(), caps);
    expect(cleared).toMatchObject({ from: '200', to: 'value before k4all', severity: 'warning' });
    expect(cleared.consequence).toMatch(
      /^kube-system\/kubelet-config gets back the value maxPods had before k4all set it .*without a drain/
    );
    const [known] = describeChanges(set, v270(), c270(), caps, {
      kubeletPrior: { maxPods: '250' },
    });
    expect(known).toMatchObject({ to: '250 (before k4all)' });
    expect(known.consequence).toMatch(/gets back maxPods: 250/);
  });

  it('labels the virtualization and storage fields', () => {
    const draft = setIn(
      setIn(
        setIn(v270(), ['features', 'virt', 'hangar', 'nodeAgent'], false),
        ['features', 'virt', 'kubevirt', 'vmStateStorageClass'],
        'ceph-rbd'
      ),
      ['features', 'virt', 'metadata'],
      { enabled: true, scope: 'All' }
    );
    const items = describeChanges(v270(), draft, c270(), caps);
    expect(items.map(i => [i.key, i.label, i.to])).toEqual([
      ['features.virt.hangar.nodeAgent', 'Hangar node agent', 'off'],
      ['features.virt.kubevirt.vmStateStorageClass', 'VM state StorageClass', 'ceph-rbd'],
      ['features.virt.metadata.enabled', 'Metadata service', 'on'],
      ['features.virt.metadata.scope', 'Metadata service: which VMs', 'All'],
    ]);
    expect(items[0].consequence).toMatch(/Uninstalls hangar-node-agent/);
  });
});

describe('formatValue', () => {
  it('formats booleans, lists and empties for people', () => {
    expect(formatValue(true)).toBe('on');
    expect(formatValue([])).toBe('none');
    expect(formatValue(['eth1', 'eth2'])).toBe('eth1, eth2');
    expect(formatValue('', 'auto')).toBe('auto');
  });
});

describe('serverAdjustments', () => {
  it('is empty when the server stores what was sent', () => {
    expect(serverAdjustments(base(), base())).toEqual([]);
  });

  it('reports defaults the server filled in and fields it dropped', () => {
    const sent = setIn(base(), ['ingress', 'traefik'], { dedicatedIP: '10.1.1.1' });
    const stored = setIn(
      setIn(base(), ['ingress', 'traefik'], { dedicatedIP: '10.1.1.1', isDefault: true }),
      ['proxy'],
      undefined
    );
    expect(serverAdjustments(sent, stored)).toEqual([
      { path: 'ingress.traefik.isDefault', sent: undefined, stored: true },
      { path: 'proxy.httpProxy', sent: '', stored: undefined },
      { path: 'proxy.httpsProxy', sent: '', stored: undefined },
      { path: 'proxy.noProxy', sent: '', stored: undefined },
    ]);
  });
});

describe('reappliedComponents', () => {
  it('re-applies every active hooked component on a settings change', () => {
    const draft = setIn(base(), ['features', 'argocd', 'enabled'], true);
    expect(reappliedComponents(base(), draft, components())).toEqual([
      'calico',
      'headlamp',
      'metallb',
      'traefik',
    ]);
  });

  it('re-applies only the overridden component on an override change', () => {
    const draft = setOverride(base(), 'cert-manager', { values: { replicaCount: 2 } });
    expect(reappliedComponents(base(), draft, components())).toEqual(['cert-manager']);
  });

  it('is empty without changes', () => {
    expect(reappliedComponents(base(), base(), components())).toEqual([]);
  });

  // Every component with a hook in the operator's registry (v0.6.0) hashes the
  // whole settings: CDI and the Rook charts too.
  it('includes CDI and the Rook charts', () => {
    const on = setIn(setIn(base(), ['features', 'virt', 'enabled'], true), ['features', 'rook'], {
      enabled: true,
    });
    const draft = setIn(on, ['features', 'argocd', 'enabled'], true);
    expect(reappliedComponents(on, draft, releaseManifestV270().spec!.components!)).toEqual([
      'calico',
      'cdi',
      'ceph-csi-drivers',
      'headlamp',
      'kubevirt',
      'metallb',
      'rook-ceph',
      'traefik',
    ]);
  });
});
