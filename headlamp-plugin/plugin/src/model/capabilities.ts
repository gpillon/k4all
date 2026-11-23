/*
 * What the installed k4all-operator can do, from its version in the
 * ReleaseManifest (status.components["k4all-operator"].installedVersion, or
 * the release's spec version before the first install).
 *
 * The plugin is pinned per k4all release, but the operator moves with the
 * ReleaseManifest sync and can be newer than the plugin expects. Every
 * behaviour that depends on the operator is gated here, so supporting a new
 * operator feature is one entry in CAPABILITY_SINCE plus the control that
 * uses it. An unknown version has no optional capability.
 */

import { compareSemver, parseSemver } from './semver';
import { ReleaseManifestObject } from './types';

export const OPERATOR_COMPONENT = 'k4all-operator';

/** The first operator release with each capability. */
export const CAPABILITY_SINCE = {
  /** ClusterUpgrade: node upgrades driven from the cluster (k4all v2.4.0). */
  clusterUpgrade: 'v0.4.0',
  /** Switching spec.networking.cni.type on a running cluster (not in v0.5.0). */
  cniSwitch: 'v0.6.0',
  /** Turning spec.features.ovsBridge.enabled on and off on a running cluster (not in v0.5.0). */
  ovsBridgeToggle: 'v0.6.0',
  /**
   * Turning virt off keeps KubeVirt, CDI and kubevirt-manager while VMs and
   * their disks exist ("uninstall refused: ..."); before, they were deleted
   * from under the running VMs.
   */
  virtUninstallGuard: 'v0.5.6',
} as const;

export type CapabilityId = keyof typeof CAPABILITY_SINCE;

/** The k4all release that first pins an operator with the capability, for the UI. */
export const CAPABILITY_RELEASE: Partial<Record<CapabilityId, string>> = {
  clusterUpgrade: 'v2.4.0',
  virtUninstallGuard: 'v2.6.6',
};

export type Capabilities = Record<CapabilityId, boolean> & {
  /** The operator version the capabilities were read from, if known. */
  operatorVersion: string | null;
};

/** The installed operator version, falling back to the version the release asks for. */
export function operatorVersion(rm: ReleaseManifestObject | null | undefined): string | null {
  const installed = rm?.status?.components?.[OPERATOR_COMPONENT]?.installedVersion;
  if (installed && parseSemver(installed)) {
    return installed;
  }
  const wanted = rm?.spec?.components?.[OPERATOR_COMPONENT]?.version;
  return wanted && parseSemver(wanted) ? wanted : null;
}

/** True when version is at least since; false for unknown or unparsable versions. */
export function atLeast(version: string | null | undefined, since: string): boolean {
  const v = parseSemver(version);
  const s = parseSemver(since);
  return !!v && !!s && compareSemver(v, s) >= 0;
}

export function capabilitiesOf(version: string | null): Capabilities {
  const caps = { operatorVersion: version } as Capabilities;
  for (const id of Object.keys(CAPABILITY_SINCE) as CapabilityId[]) {
    caps[id] = atLeast(version, CAPABILITY_SINCE[id]);
  }
  return caps;
}

export function capabilities(rm: ReleaseManifestObject | null | undefined): Capabilities {
  return capabilitiesOf(operatorVersion(rm));
}

/** "coming with k4all-operator v0.6.0" style note for a missing capability. */
export function capabilityNote(id: CapabilityId): string {
  const release = CAPABILITY_RELEASE[id];
  return `coming with k4all-operator ${CAPABILITY_SINCE[id]}${
    release ? ` (k4all ${release})` : ''
  }`;
}
