import { defaultClusterConfig } from './fixtures';
import {
  adoptTraefikKey,
  draftFrom,
  effectiveTraefik,
  emulationMode,
  getOverride,
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

  it('mirrors the IP into the legacy nginx key so MetalLB (operator v0.3.0) announces it', () => {
    const draft = setTraefik(defaultClusterConfig().spec!, { dedicatedIP: '192.168.1.240' });
    expect(draft.ingress?.traefik?.dedicatedIP).toBe('192.168.1.240');
    expect(draft.ingress?.nginx?.dedicatedIP).toBe('192.168.1.240');
  });

  it('keeps the mirror in sync on later changes and clears it with the Traefik IP', () => {
    let draft = setTraefik(defaultClusterConfig().spec!, { dedicatedIP: '192.168.1.240' });
    draft = setTraefik(draft, { dedicatedIP: '192.168.1.241' });
    expect(draft.ingress?.nginx?.dedicatedIP).toBe('192.168.1.241');
    draft = setTraefik(draft, { dedicatedIP: '' });
    expect(draft.ingress?.nginx?.dedicatedIP).toBe('');
  });

  it('does not create the nginx key just to store an empty IP', () => {
    const draft = setTraefik(defaultClusterConfig().spec!, { dedicatedIP: '' });
    expect(draft.ingress?.nginx).toBeUndefined();
  });

  it('leaves a different legacy IP alone', () => {
    const spec: ClusterConfigSpec = {
      ingress: {
        traefik: { dedicatedIP: '10.0.0.1', isDefault: true },
        nginx: { dedicatedIP: '10.0.0.9' },
      },
    };
    expect(setTraefik(spec, { dedicatedIP: '10.0.0.2' }).ingress?.nginx?.dedicatedIP).toBe(
      '10.0.0.9'
    );
  });

  it('does not mutate its input', () => {
    const spec = defaultClusterConfig().spec!;
    const copy = draftFrom(spec);
    setTraefik(spec, { dedicatedIP: '192.168.1.240', isDefault: false });
    expect(spec).toEqual(copy);
  });
});

describe('adoptTraefikKey', () => {
  it('copies the effective settings to spec.ingress.traefik', () => {
    expect(adoptTraefikKey(legacySpec()).ingress?.traefik).toEqual({
      dedicatedIP: '192.168.1.240',
      isDefault: true,
    });
  });

  it('is a no-op when the key exists', () => {
    const spec = defaultClusterConfig().spec!;
    expect(adoptTraefikKey(spec)).toBe(spec);
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
