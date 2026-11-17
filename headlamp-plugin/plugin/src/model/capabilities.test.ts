import {
  atLeast,
  capabilities,
  capabilitiesOf,
  capabilityNote,
  operatorVersion,
} from './capabilities';
import { releaseManifest, releaseManifestV240 } from './fixtures';

describe('operator capabilities', () => {
  it('reads the installed operator version, then the version the release asks for', () => {
    expect(operatorVersion(releaseManifestV240())).toBe('v0.4.0');
    const rm = releaseManifestV240();
    delete rm.status!.components!['k4all-operator'];
    rm.spec!.components!['k4all-operator'].version = 'v0.5.1';
    expect(operatorVersion(rm)).toBe('v0.5.1');
    rm.spec!.components!['k4all-operator'].version = 'latest';
    expect(operatorVersion(rm)).toBeNull();
    expect(operatorVersion(null)).toBeNull();
  });

  it('compares versions strictly; unknown means no capability', () => {
    expect(atLeast('v0.4.0', 'v0.4.0')).toBe(true);
    expect(atLeast('0.10.0', 'v0.5.0')).toBe(true);
    expect(atLeast('v0.5.0-rc.1', 'v0.5.0')).toBe(false);
    expect(atLeast(null, 'v0.4.0')).toBe(false);
    expect(atLeast('main', 'v0.4.0')).toBe(false);
  });

  it('gates ClusterUpgrade and the MetalLB fix on v0.4.0, CNI and OVS bridge on v0.5.0', () => {
    const v030 = capabilities(releaseManifest());
    expect(v030).toMatchObject({
      operatorVersion: 'v0.3.0',
      clusterUpgrade: false,
      metallbReadsTraefikIP: false,
      cniSwitch: false,
    });
    const v040 = capabilities(releaseManifestV240());
    expect(v040).toMatchObject({
      clusterUpgrade: true,
      metallbReadsTraefikIP: true,
      cniSwitch: false,
      ovsBridgeToggle: false,
    });
    expect(capabilitiesOf('v0.5.0')).toMatchObject({ cniSwitch: true, ovsBridgeToggle: true });
  });

  it('names the operator (and k4all release) that brings a capability', () => {
    expect(capabilityNote('cniSwitch')).toBe('coming with k4all-operator v0.5.0');
    expect(capabilityNote('clusterUpgrade')).toBe(
      'coming with k4all-operator v0.4.0 (k4all v2.4.0)'
    );
  });
});
