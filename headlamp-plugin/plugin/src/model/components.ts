/*
 * ReleaseManifest components as the UI shows them. componentActivation is a
 * port of shouldInstall/FilterActiveComponents (k4all-operator
 * internal/engine/deps.go, v0.4.0): keep the two in sync.
 */

import { compareSemver, parseSemver, sameVersion } from './semver';
import {
  ClusterConfigSpec,
  ComponentSpec,
  ComponentStatus,
  FORCE_RESYNC_ANNOTATION,
  ReleaseManifestObject,
} from './types';

/** The ClusterConfig features that install components (the operator's feature gates). */
export type Feature = 'virt' | 'argocd' | 'ovsCni' | 'rook';

export const FEATURES: Feature[] = ['virt', 'argocd', 'ovsCni', 'rook'];

export interface Activation {
  active: boolean;
  /** Why an inactive component is not installed. */
  reason?: string;
  /** The ClusterConfig feature that turns it on, when there is one. */
  feature?: Feature;
  /** Any of these features turns it on (the snapshot controller: virt or Rook). */
  anyOf?: Feature[];
}

export const FEATURE_LABEL: Record<Feature, string> = {
  virt: 'Virtualization',
  argocd: 'Argo CD',
  ovsCni: 'OVS secondary networks',
  rook: 'Rook/Ceph storage',
};

/** Where the plugin turns each feature on and off. */
const FEATURE_PLACE: Record<Feature, string> = {
  virt: 'Settings',
  argocd: 'Settings',
  ovsCni: 'Settings',
  rook: 'Settings > Storage',
};

export function featureEnabled(feature: string, config: ClusterConfigSpec): boolean {
  switch (feature) {
    case 'virt':
      return config.features?.virt?.enabled === true;
    case 'argocd':
      return config.features?.argocd?.enabled === true;
    case 'ovsCni':
      return config.features?.ovsCni?.enabled === true;
    case 'rook':
      // features.rook exists from operator v0.6.0 (k4all v2.7.0); older CRDs prune it.
      return config.features?.rook?.enabled === true;
  }
  return false;
}

/**
 * Gates of operator v0.6.0 that are not a ClusterConfig feature of their own
 * (engine.FeatureEnabled): snapshots (the CSI snapshot controller) is on
 * with virt or Rook; virtMetadata (k4all-metadata) is virt plus
 * features.virt.metadata.enabled.
 */
const ANY_OF_GATE: Record<string, Feature[]> = {
  snapshots: ['virt', 'rook'],
};
const VIRT_METADATA_GATE = 'virtMetadata';

/** Hangar's node agent: the operator leaves it out by name when nodeAgent is false (D6). */
const HANGAR_NODE_AGENT = 'hangar-node-agent';

/** Why a component the release set to Removed is gone, and what its removal keeps. */
export const REMOVED_REASON: Record<string, string> = {
  // k4all v2.7.0 (operator v0.6.0, its Remover hook, spec §10.3). The operator
  // only logs what it kept (D25); the component page checks which are left.
  'kubevirt-manager':
    'Removed: replaced by Hangar. k4all removed its console and roles; it keeps the ' +
    'PriorityClasses vm-standard and vm-preemptible while VMs or pods name them, the image ' +
    'catalog CRD images.kubevirt-manager.io while it holds images, and the namespace ' +
    'kubevirt-manager while your objects are in it. VMs are untouched.',
};

/**
 * The start of the message of a component k4all-operator keeps installed
 * though it should go (its feature off, or management Removed), because its
 * uninstall would break what runs on it (v0.5.7: KubeVirt while VMs exist).
 */
export const UNINSTALL_REFUSED = 'uninstall refused: ';

/**
 * The start of the message of a component that waits for something before
 * the operator goes on (v0.6.0, D23): Rook below 3 nodes with smallCluster
 * Refuse, a feature group held by one of its members. Neutral, not a failure.
 */
export const WAITING = 'waiting: ';

/** Why k4all-operator refuses to uninstall the component, if it does. */
export function uninstallRefusal(status: ComponentStatus | undefined): string | undefined {
  const message = status?.message;
  return message?.startsWith(UNINSTALL_REFUSED)
    ? message.slice(UNINSTALL_REFUSED.length)
    : undefined;
}

export interface ComponentNotice {
  kind: 'refused' | 'waiting';
  /** The operator's message after the prefix, as written. */
  text: string;
}

/** A refused uninstall or a wait, from the component's status message. */
export function componentNotice(status: ComponentStatus | undefined): ComponentNotice | undefined {
  const refused = uninstallRefusal(status);
  if (refused !== undefined) {
    return { kind: 'refused', text: refused };
  }
  const message = status?.message;
  return message?.startsWith(WAITING)
    ? { kind: 'waiting', text: message.slice(WAITING.length) }
    : undefined;
}

/** Every component with a refused uninstall or a wait, by name. */
export function componentNotices(
  rm: ReleaseManifestObject | null | undefined
): (ComponentNotice & { name: string })[] {
  return Object.entries(rm?.status?.components ?? {})
    .map(([name, status]) => ({ name, notice: componentNotice(status) }))
    .filter((e): e is { name: string; notice: ComponentNotice } => !!e.notice)
    .map(e => ({ name: e.name, ...e.notice }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The feature that gates a component: its featureGate, or the operator's name-based fallback. */
export function componentFeature(name: string, spec: ComponentSpec): Feature | undefined {
  if (spec.featureGate) {
    return (FEATURES as string[]).includes(spec.featureGate)
      ? (spec.featureGate as Feature)
      : undefined;
  }
  switch (name) {
    case 'kubevirt':
    case 'virtctl':
    case 'cdi':
    case 'kubevirt-manager':
      return 'virt';
    case 'argocd':
      return 'argocd';
    case 'multus-cni':
    case 'ovs-cni':
      return 'ovsCni';
  }
  return undefined;
}

/**
 * The LoadBalancer IPs the ingress controllers ask for, each once: Traefik's,
 * NGINX's, then Cilium's (IngressConfig.DedicatedIPs, operator v0.4.0).
 */
export function dedicatedIPs(config: ClusterConfigSpec): string[] {
  const ingress = config.ingress ?? {};
  const ips: string[] = [];
  for (const ip of [
    ingress.traefik?.dedicatedIP,
    ingress.nginx?.dedicatedIP,
    ingress.cilium?.dedicatedIP,
  ]) {
    if (ip && !ips.includes(ip)) {
      ips.push(ip);
    }
  }
  return ips;
}

export function componentActivation(
  name: string,
  spec: ComponentSpec,
  config: ClusterConfigSpec
): Activation {
  if (spec.management === 'Unmanaged') {
    return { active: false, reason: 'Unmanaged: the operator leaves it alone.' };
  }
  if (spec.management === 'Removed') {
    return {
      active: false,
      reason: REMOVED_REASON[name] ?? 'Removed: the operator uninstalls it.',
    };
  }
  const cni = config.networking?.cni?.type ?? '';
  switch (name) {
    case 'calico':
      return cni === 'calico'
        ? { active: true }
        : { active: false, reason: `Not used: the CNI is ${cni || 'unset'}.` };
    case 'cilium':
    case 'cilium-cli':
      return cni === 'cilium'
        ? { active: true }
        : { active: false, reason: `Not used: the CNI is ${cni || 'unset'}.` };
    case 'kube-vip':
      return config.cluster?.ha?.type === 'kubevip'
        ? { active: true }
        : {
            active: false,
            reason: `Not used: control plane HA is ${config.cluster?.ha?.type || 'none'}.`,
          };
    case 'metallb': {
      if (cni === 'cilium' && dedicatedIPs(config).length === 0) {
        return {
          active: false,
          reason: 'Not used: Cilium handles LoadBalancer addresses and no dedicated IP is set.',
        };
      }
      break;
    }
  }
  const gate = spec.featureGate;
  const anyOf = gate ? ANY_OF_GATE[gate] : undefined;
  if (anyOf) {
    return anyOf.some(f => featureEnabled(f, config))
      ? { active: true, anyOf }
      : {
          active: false,
          anyOf,
          reason: `Needs ${anyOf.map(f => FEATURE_LABEL[f]).join(' or ')}.`,
        };
  }
  const feature = gate === VIRT_METADATA_GATE ? 'virt' : componentFeature(name, spec);
  if (gate && !feature) {
    return { active: false, reason: `Unknown feature gate "${gate}".` };
  }
  if (feature && !featureEnabled(feature, config)) {
    return { active: false, feature, reason: `${FEATURE_LABEL[feature]} is off.` };
  }
  if (gate === VIRT_METADATA_GATE && config.features?.virt?.metadata?.enabled !== true) {
    return {
      active: false,
      feature,
      reason: 'The metadata service is off (features.virt.metadata.enabled).',
    };
  }
  // By name, whatever the gate, as engine.shouldInstall does.
  if (name === HANGAR_NODE_AGENT && config.features?.virt?.hangar?.nodeAgent === false) {
    return {
      active: false,
      ...(feature ? { feature } : {}),
      reason: "Hangar's node agent is turned off (features.virt.hangar.nodeAgent: false).",
    };
  }
  return feature ? { active: true, feature } : { active: true };
}

/** Whether a component belongs to the feature (its gate, or one of the features that install it). */
export function belongsTo(activation: Activation, feature: Feature): boolean {
  return activation.feature === feature || !!activation.anyOf?.includes(feature);
}

// -------------------------------------------------------------- Categories

export const CATEGORIES: Record<string, string> = {
  calico: 'Networking',
  cilium: 'Networking',
  'cilium-cli': 'Networking',
  metallb: 'Networking',
  'gateway-api': 'Networking',
  nmstate: 'Networking',
  'multus-cni': 'Networking',
  'ovs-cni': 'Networking',
  'kube-vip': 'Control plane',
  'ingress-nginx': 'Ingress',
  traefik: 'Ingress',
  topolvm: 'Storage',
  'rook-ceph': 'Storage',
  'ceph-csi-drivers': 'Storage',
  'snapshot-controller': 'Storage',
  'cert-manager': 'Security',
  headlamp: 'Dashboard',
  'metrics-server': 'Monitoring',
  kubevirt: 'Virtualization',
  virtctl: 'Virtualization',
  cdi: 'Virtualization',
  'kubevirt-manager': 'Virtualization',
  hangar: 'Virtualization',
  'hangar-node-agent': 'Virtualization',
  'k4all-metadata': 'Virtualization',
  cairn: 'Storage',
  argocd: 'GitOps',
  'k4all-operator': 'Platform',
};

export function categoryOf(name: string): string {
  return CATEGORIES[name] ?? 'Other';
}

// ----------------------------------------------------------- Upgrade paths

export interface UpgradeProgress {
  /** Intermediate versions still to install, in order, then the target. */
  remaining: string[];
  /** The version the operator installs next. */
  next: string;
}

/**
 * Mirrors engine.UpgradeStep: the path versions strictly between installed
 * and target, in semver order. Null when the component is at its target or
 * the versions are not semver (fresh installs and downgrades go straight to
 * the target, which is also returned as the single remaining step).
 */
export function upgradeProgress(
  spec: ComponentSpec,
  installed: string | undefined
): UpgradeProgress | null {
  if (!installed || sameVersion(installed, spec.version)) {
    return null;
  }
  const from = parseSemver(installed);
  const to = parseSemver(spec.version);
  if (!from || !to || compareSemver(from, to) > 0) {
    return { remaining: [spec.version], next: spec.version };
  }
  const between = (spec.upgradePath ?? [])
    .map(step => ({ raw: step.version, v: parseSemver(step.version) }))
    .filter(
      (s): s is { raw: string; v: NonNullable<ReturnType<typeof parseSemver>> } =>
        s.v !== null && compareSemver(s.v, from) > 0 && compareSemver(s.v, to) < 0
    )
    .sort((a, b) => compareSemver(a.v, b.v))
    .map(s => s.raw);
  const remaining = [...between, spec.version];
  return { remaining, next: remaining[0] };
}

// ------------------------------------------------------------------- Rows

export type Tone = 'success' | 'info' | 'warning' | 'error' | 'neutral';

export interface DisplayState {
  label: string;
  tone: Tone;
  busy: boolean;
}

export function displayState(
  status: ComponentStatus | undefined,
  activation: Activation
): DisplayState {
  const state = status?.state;
  switch (state) {
    case 'Installed':
      return { label: 'Installed', tone: 'success', busy: false };
    case 'Failed':
      return { label: 'Failed', tone: 'error', busy: false };
    case 'Pending':
    case 'Installing':
    case 'Upgrading':
    case 'Uninstalling':
      return { label: state, tone: 'info', busy: true };
    case 'Skipped':
      return { label: 'Off', tone: 'neutral', busy: false };
    case 'Removed':
      return { label: 'Removed', tone: 'neutral', busy: false };
    case 'Unmanaged':
      return { label: 'Unmanaged', tone: 'warning', busy: false };
  }
  if (!activation.active) {
    return { label: 'Off', tone: 'neutral', busy: false };
  }
  return { label: 'Not reconciled yet', tone: 'info', busy: true };
}

export interface ComponentRow {
  name: string;
  spec: ComponentSpec;
  status?: ComponentStatus;
  category: string;
  activation: Activation;
  state: DisplayState;
  management: 'Managed' | 'Removed' | 'Unmanaged';
  installedVersion?: string;
  upgrade: UpgradeProgress | null;
  dependsOn: string[];
  requiredBy: string[];
  hasOverride: boolean;
  /** A force-resync for this component (or "all") is pending. */
  resyncPending: boolean;
}

export function managementOf(spec: ComponentSpec): ComponentRow['management'] {
  return spec.management === 'Removed' || spec.management === 'Unmanaged'
    ? spec.management
    : 'Managed';
}

export function buildRows(
  rm: ReleaseManifestObject | null | undefined,
  config: ClusterConfigSpec
): ComponentRow[] {
  const components = rm?.spec?.components ?? {};
  const statuses = rm?.status?.components ?? {};
  const resync = rm?.metadata.annotations?.[FORCE_RESYNC_ANNOTATION];
  const activations: Record<string, Activation> = {};
  for (const [name, spec] of Object.entries(components)) {
    activations[name] = componentActivation(name, spec, config);
  }
  const requiredBy: Record<string, string[]> = {};
  for (const [name, spec] of Object.entries(components)) {
    if (!activations[name].active) {
      continue;
    }
    for (const dep of spec.dependsOn ?? []) {
      (requiredBy[dep] = requiredBy[dep] ?? []).push(name);
    }
  }
  return Object.entries(components)
    .map(([name, spec]) => {
      const status = statuses[name];
      const activation = activations[name];
      const upgrade = activation.active ? upgradeProgress(spec, status?.installedVersion) : null;
      return {
        name,
        spec,
        status,
        category: categoryOf(name),
        activation,
        state: displayState(status, activation),
        management: managementOf(spec),
        installedVersion: status?.installedVersion,
        upgrade,
        // Dependencies on inactive components (calico vs cilium) are ignored by the operator.
        dependsOn: (spec.dependsOn ?? []).filter(dep => activations[dep]?.active),
        requiredBy: (requiredBy[name] ?? []).sort(),
        hasOverride: !!config.componentOverrides?.[name],
        resyncPending: resync === name || resync === 'all',
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/**
 * The rows the Components page lists: components with management Removed
 * (e.g. ingress-nginx from v2.4.0) are hidden unless asked for.
 */
export function visibleRows(rows: ComponentRow[], showRemoved: boolean): ComponentRow[] {
  return showRemoved ? rows : rows.filter(r => r.management !== 'Removed');
}

export interface Summary {
  total: number;
  active: number;
  installed: number;
  failed: number;
  busy: number;
  off: number;
  unmanaged: number;
  upgrading: number;
}

export function summarize(rows: ComponentRow[]): Summary {
  const s: Summary = {
    total: rows.length,
    active: 0,
    installed: 0,
    failed: 0,
    busy: 0,
    off: 0,
    unmanaged: 0,
    upgrading: 0,
  };
  for (const row of rows) {
    if (row.activation.active) {
      s.active++;
    }
    if (row.status?.state === 'Installed') {
      s.installed++;
    }
    if (row.state.tone === 'error') {
      s.failed++;
    }
    if (row.state.busy) {
      s.busy++;
    }
    if (row.management === 'Unmanaged') {
      s.unmanaged++;
    } else if (!row.activation.active) {
      s.off++;
    }
    if (row.upgrade) {
      s.upgrading++;
    }
  }
  return s;
}

// -------------------------------------------------------------- Management

/** Components the plugin refuses to set to Removed. */
export const PROTECTED_COMPONENTS: Record<string, string> = {
  'k4all-operator': 'Removing it uninstalls the operator itself.',
  headlamp: 'Removing it uninstalls this dashboard.',
};

/** Reasons a component cannot be set to Removed; empty when it can. */
export function removalBlockers(row: ComponentRow, config: ClusterConfigSpec): string[] {
  const blockers: string[] = [];
  if (PROTECTED_COMPONENTS[row.name]) {
    blockers.push(PROTECTED_COMPONENTS[row.name]);
  }
  const cni = config.networking?.cni?.type;
  if (row.name === cni) {
    blockers.push('It is the cluster CNI.');
  }
  if (row.activation.feature && row.management === 'Managed') {
    const f = row.activation.feature;
    blockers.push(`Turn off ${FEATURE_LABEL[f]} in ${FEATURE_PLACE[f]} instead.`);
  }
  if (row.requiredBy.length > 0) {
    blockers.push(`Required by ${row.requiredBy.join(', ')}.`);
  }
  return blockers;
}

/** Helm components accept value overrides; the others ignore them. */
export function acceptsValues(spec: ComponentSpec): boolean {
  return spec.type === 'helm' || spec.type === 'helm-oci';
}

/** "v2.6.0" from an osImage tag like "v2.6.0-amd64"; null for "latest" or empty. */
export function releaseVersion(rm: ReleaseManifestObject | null | undefined): string | null {
  const tag = rm?.status?.resolvedOSImageTag || rm?.spec?.osImage?.imageTag || '';
  const plain = tag.replace(/-(amd64|arm64)$/, '');
  return parseSemver(plain) ? (plain.startsWith('v') ? plain : `v${plain}`) : null;
}
