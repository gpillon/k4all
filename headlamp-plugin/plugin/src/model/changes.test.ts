import {
  describeChanges,
  formatValue,
  needsAcknowledgement,
  reappliedComponents,
  serverAdjustments,
} from './changes';
import {
  clusterConfigNginx,
  defaultClusterConfig,
  releaseManifest,
  releaseManifestNginx,
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
      'Installs cdi, kubevirt, kubevirt-manager, virtctl. This takes a few minutes.'
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

  it('flags a CNI switch and the OVS bridge as dangerous (operator v0.6.0)', () => {
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
});
