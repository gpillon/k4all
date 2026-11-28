/*
 * What the installed k4all-operator can do, from its version in the
 * ReleaseManifest (status.components["k4all-operator"].installedVersion, or
 * the release's spec version before the first install).
 *
 * The plugin is pinned per k4all release, but the operator moves with the
 * ReleaseManifest sync and can be newer than the plugin expects. Every
 * behaviour that depends on the operator is gated here, so supporting a new
 * operator feature is one entry in CAPABILITY_SINCE plus the control that
 * uses it. An unknown version has no optional capability. A pre-release has
 * the capabilities of its release: v0.6.0-rc.1, the operator of a v2.7.0 test
 * build, has v0.6.0's.
 */

import { compareSemver, parseSemver } from './semver';
import { ReleaseManifestObject } from './types';

export const OPERATOR_COMPONENT = 'k4all-operator';

/** The first operator release with each capability. */
export const CAPABILITY_SINCE = {
  /** ClusterUpgrade: node upgrades driven from the cluster (k4all v2.4.0). */
  clusterUpgrade: 'v0.4.0',
  /**
   * Switching spec.networking.cni.type on a running cluster. Planned for
   * v0.6.0 until the k4all v2.7.0 spec moved it to v0.7.0 (D1), then for
   * v0.7.0 until the k4all v2.7.2 decisions moved it to v0.8.0: v0.6.x and
   * v0.7.x do not have it.
   */
  cniSwitch: 'v0.8.0',
  /** Turning spec.features.ovsBridge.enabled on and off on a running cluster (with the CNI switch). */
  ovsBridgeToggle: 'v0.8.0',
  /**
   * Turning virt off keeps KubeVirt, CDI and kubevirt-manager while VMs and
   * their disks exist ("uninstall refused: ..."); before, they were deleted
   * from under the running VMs (v0.5.6 too: it was published without this).
   */
  virtUninstallGuard: 'v0.5.7',
  /**
   * features.virt.kubevirt (gates, vmStateStorageClass), .hangar.nodeAgent
   * and .metadata (k4all v2.7.0). Older CRDs do not have the fields.
   */
  virtSettings: 'v0.6.0',
  /** spec.nodes (kubelet settings, hugepages, IOMMU) and its rollout in status.nodes. */
  nodeSettings: 'v0.6.0',
  /** features.rook: Rook/Ceph with the Cairn console. */
  rookStorage: 'v0.6.0',
  /**
   * Upgrade readiness and remediations (k4all v2.7.2): ClusterUpgrade
   * status.readiness, nodes[].blockers, remediations and spec.approvals,
   * drain.confirmDisruptions, the check-readiness and restore annotations;
   * ClusterConfig spec.upgrades.remediations, the rollout's approvals,
   * blockers and records. Older CRDs do not have the fields, and a strict
   * write with them would be refused.
   */
  upgradeReadiness: 'v0.7.0',
  /**
   * features.rook.storage.nodes (named OSD devices, logical volumes
   * included), .csi.imageVariant, .monitoring and .filesystem, with the
   * RookCSIImage and RookMonitoring conditions (k4all v2.7.2).
   */
  rookOptions: 'v0.7.0',
  /** features.virt.hangar.guestBridge: Hangar's guest bridge (k4all v2.7.2). */
  guestBridge: 'v0.7.0',
} as const;

export type CapabilityId = keyof typeof CAPABILITY_SINCE;

/** The k4all release that first pins an operator with the capability, for the UI. */
export const CAPABILITY_RELEASE: Partial<Record<CapabilityId, string>> = {
  clusterUpgrade: 'v2.4.0',
  virtUninstallGuard: 'v2.6.6',
  virtSettings: 'v2.7.0',
  nodeSettings: 'v2.7.0',
  rookStorage: 'v2.7.0',
  upgradeReadiness: 'v2.7.2',
  rookOptions: 'v2.7.2',
  guestBridge: 'v2.7.2',
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

/**
 * True when version is at least since; false for unknown or unparsable
 * versions. Only the core version (X.Y.Z) counts: -rc.N and any other
 * pre-release or build suffix are ignored.
 */
export function atLeast(version: string | null | undefined, since: string): boolean {
  const v = parseSemver(version);
  const s = parseSemver(since);
  return !!v && !!s && compareSemver({ ...v, prerelease: [] }, { ...s, prerelease: [] }) >= 0;
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
