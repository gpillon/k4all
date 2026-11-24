import {
  atLeast,
  capabilities,
  capabilitiesOf,
  capabilityNote,
  operatorVersion,
} from './capabilities';
import { releaseManifest, releaseManifestNginx, releaseManifestV240 } from './fixtures';

describe('operator capabilities', () => {
  it('reads the installed operator version, then the version the release asks for', () => {
    expect(operatorVersion(releaseManifestNginx())).toBe('v0.5.0');
    const rm = releaseManifestNginx();
    delete rm.status!.components!['k4all-operator'];
    rm.spec!.components!['k4all-operator'].version = 'v0.6.1';
    expect(operatorVersion(rm)).toBe('v0.6.1');
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

  it('gates ClusterUpgrade on v0.4.0, CNI and OVS bridge on v0.7.0', () => {
    const v030 = capabilities(releaseManifest());
    expect(v030).toMatchObject({
      operatorVersion: 'v0.3.0',
      clusterUpgrade: false,
      cniSwitch: false,
    });
    // v0.5.0, the operator k4all v2.4.0 pins: ClusterUpgrade, no CNI switch
    const v050 = capabilities(releaseManifestV240());
    expect(v050).toMatchObject({
      operatorVersion: 'v0.5.0',
      clusterUpgrade: true,
      cniSwitch: false,
      ovsBridgeToggle: false,
    });
    expect(capabilitiesOf('v0.5.9')).toMatchObject({ cniSwitch: false, ovsBridgeToggle: false });
    // v0.6.0 (k4all v2.7.0) has neither: the CNI switch and OVS bridge removal moved to v0.7.0
    expect(capabilitiesOf('v0.6.0')).toMatchObject({ cniSwitch: false, ovsBridgeToggle: false });
    expect(capabilitiesOf('v0.7.0')).toMatchObject({ cniSwitch: true, ovsBridgeToggle: true });
  });

  it('has the k4all v2.7.0 settings from v0.6.0', () => {
    for (const v of ['v0.5.7', 'v0.5.99', 'v0.6.0-rc.1']) {
      expect(capabilitiesOf(v)).toMatchObject({
        virtSettings: false,
        nodeSettings: false,
        rookStorage: false,
      });
    }
    expect(capabilitiesOf('v0.6.0')).toMatchObject({
      virtSettings: true,
      nodeSettings: true,
      rookStorage: true,
    });
    expect(capabilitiesOf(null).nodeSettings).toBe(false);
    expect(capabilityNote('nodeSettings')).toBe('coming with k4all-operator v0.6.0 (k4all v2.7.0)');
  });

  it('has the virtualization uninstall guard from v0.5.7 (k4all v2.6.6)', () => {
    // v0.5.6 was published without it: virt off still deletes KubeVirt and CDI
    expect(capabilitiesOf('v0.5.6').virtUninstallGuard).toBe(false);
    expect(capabilitiesOf('v0.5.7').virtUninstallGuard).toBe(true);
    expect(capabilityNote('virtUninstallGuard')).toBe(
      'coming with k4all-operator v0.5.7 (k4all v2.6.6)'
    );
  });

  it('names the operator (and k4all release) that brings a capability', () => {
    expect(capabilityNote('cniSwitch')).toBe('coming with k4all-operator v0.7.0');
    expect(capabilityNote('clusterUpgrade')).toBe(
      'coming with k4all-operator v0.4.0 (k4all v2.4.0)'
    );
  });
});
