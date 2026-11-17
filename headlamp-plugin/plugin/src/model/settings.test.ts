import {
  clusterConfigV240,
  defaultClusterConfig,
  releaseManifest,
  releaseManifestV240,
} from './fixtures';
import { setIn } from './objects';
import {
  activeIngress,
  draftFrom,
  effectiveIngress,
  effectiveTraefik,
  emulationMode,
  getOverride,
  ingressExposure,
  setIngress,
  setOverride,
  setTraefik,
  traefikExposure,
} from './settings';
import { ClusterConfigSpec } from './types';

const legacySpec = (): ClusterConfigSpec => ({
  networking: { cni: { type: 'calico' } },
  ingress: {
    nginx: { dedicatedIP: '192.168.1.240', isDefault: true },
    cilium: { dedicatedIP: '' },
  },
});

describe('effectiveTraefik', () => {
  it('reads spec.ingress.traefik when present', () => {
    expect(effectiveTraefik(defaultClusterConfig().spec!)).toEqual({
      dedicatedIP: '',
      isDefault: true,
      source: 'traefik',
    });
  });

  it('falls back to spec.ingress.nginx on configs from before v2.6.0', () => {
    expect(effectiveTraefik(legacySpec())).toEqual({
      dedicatedIP: '192.168.1.240',
      isDefault: true,
      source: 'nginx',
    });
  });

  it('reads a missing isDefault as false, like the operator', () => {
    expect(effectiveTraefik({ ingress: { traefik: { dedicatedIP: '10.0.0.1' } } }).isDefault).toBe(
      false
    );
    expect(effectiveTraefik({}).source).toBe('none');
  });
});

describe('setTraefik', () => {
  it('materializes spec.ingress.traefik with both fields explicit', () => {
    const draft = setTraefik(legacySpec(), { isDefault: false });
    expect(draft.ingress?.traefik).toEqual({ dedicatedIP: '192.168.1.240', isDefault: false });
    // the legacy key is left as it was
    expect(draft.ingress?.nginx).toEqual({ dedicatedIP: '192.168.1.240', isDefault: true });
  });

  it('writes spec.ingress.traefik only, never the ingress-nginx key', () => {
    let draft = setTraefik(defaultClusterConfig().spec!, { dedicatedIP: '192.168.1.240' });
    expect(draft.ingress?.traefik).toEqual({ dedicatedIP: '192.168.1.240', isDefault: true });
    expect(draft.ingress?.nginx).toBeUndefined();
    // inherited values: the first change saves them to the traefik key, nginx stays as it was
    draft = setTraefik(legacySpec(), { dedicatedIP: '192.168.1.241' });
    expect(draft.ingress?.traefik).toEqual({ dedicatedIP: '192.168.1.241', isDefault: true });
    expect(draft.ingress?.nginx).toEqual(legacySpec().ingress?.nginx);
  });

  it('does not mutate its input', () => {
    const spec = defaultClusterConfig().spec!;
    const copy = draftFrom(spec);
    setTraefik(spec, { dedicatedIP: '192.168.1.240', isDefault: false });
    expect(spec).toEqual(copy);
  });
});

describe('setOverride', () => {
  it('sets values and helmArgs', () => {
    const draft = setOverride({}, 'traefik', {
      values: { logs: { general: { level: 'DEBUG' } } },
      helmArgs: ['--set a=1'],
    });
    expect(getOverride(draft, 'traefik')).toEqual({
      values: { logs: { general: { level: 'DEBUG' } } },
      helmArgs: ['--set a=1'],
    });
  });

  it('drops the key when the override becomes empty', () => {
    const draft = setOverride(
      { componentOverrides: { traefik: { values: { a: 1 } } } },
      'traefik',
      {
        values: {},
        helmArgs: [],
      }
    );
    expect(draft.componentOverrides).toEqual({});
  });

  it('removes only the cleared part', () => {
    const draft = setOverride(
      { componentOverrides: { traefik: { values: { a: 1 }, helmArgs: ['--set b=2'] } } },
      'traefik',
      {
        values: { a: 1 },
      }
    );
    expect(draft.componentOverrides?.traefik).toEqual({ values: { a: 1 } });
  });
});

describe('emulationMode', () => {
  it('defaults to auto', () => {
    expect(emulationMode({})).toBe('auto');
    expect(emulationMode({ features: { virt: { emulation: 'true' } } })).toBe('true');
  });
});

describe('traefikExposure (mirror of the operator Traefik hook)', () => {
  const spec = () => defaultClusterConfig().spec!;

  it('uses host ports by default', () => {
    expect(traefikExposure(spec()).kind).toBe('host-ports');
  });

  it('uses a LoadBalancer with a dedicated IP', () => {
    expect(traefikExposure(setTraefik(spec(), { dedicatedIP: '192.168.1.240' })).summary).toContain(
      '192.168.1.240'
    );
  });

  it('goes through kube-vip on kube-vip HA clusters, and on the node address when not default', () => {
    const kubevip: ClusterConfigSpec = { ...spec(), cluster: { ha: { type: 'kubevip' } } };
    expect(traefikExposure(kubevip).kind).toBe('kube-vip');
    expect(traefikExposure(setTraefik(spec(), { isDefault: false })).kind).toBe(
      'loadbalancer-node'
    );
  });
});

describe('ingress-nginx clusters (k4all v2.4.0 and v2.5.x)', () => {
  it('finds the active controller in the ReleaseManifest', () => {
    expect(activeIngress(releaseManifest().spec!.components)).toBe('traefik'); // nginx Removed
    expect(activeIngress(releaseManifestV240().spec!.components)).toBe('nginx');
    // without a ReleaseManifest the config decides
    expect(activeIngress(undefined, clusterConfigV240().spec)).toBe('nginx');
    expect(activeIngress(undefined, defaultClusterConfig().spec)).toBe('traefik');
  });

  it('reads and writes spec.ingress.nginx only, both fields explicit', () => {
    const spec = clusterConfigV240().spec!;
    expect(effectiveIngress(spec, 'nginx')).toEqual({
      dedicatedIP: '',
      isDefault: true,
      source: 'nginx',
    });
    const next = setIngress(spec, 'nginx', { dedicatedIP: '192.168.1.240' });
    expect(next.ingress?.nginx).toEqual({ dedicatedIP: '192.168.1.240', isDefault: true });
    expect(next.ingress?.traefik).toBeUndefined();
    const notDefault = setIngress({}, 'nginx', { isDefault: false });
    expect(notDefault.ingress?.nginx).toEqual({ dedicatedIP: '', isDefault: false });
  });

  it('ignores a traefik key the ingress-nginx hook does not read', () => {
    const spec = setIn(clusterConfigV240().spec!, ['ingress', 'traefik'], {
      dedicatedIP: '10.0.0.9',
      isDefault: false,
    });
    expect(effectiveIngress(spec, 'nginx').dedicatedIP).toBe('');
    expect(ingressExposure(spec, 'nginx').kind).toBe('host-ports');
  });
});
