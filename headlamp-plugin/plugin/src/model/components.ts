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

export interface Activation {
  active: boolean;
  /** Why an inactive component is not installed. */
  reason?: string;
  /** The ClusterConfig feature that turns it on, when there is one. */
  feature?: 'virt' | 'argocd' | 'ovsCni';
}

const FEATURE_LABEL: Record<string, string> = {
  virt: 'Virtualization',
  argocd: 'Argo CD',
  ovsCni: 'OVS secondary networks',
};

function featureEnabled(feature: string, config: ClusterConfigSpec): boolean {
  switch (feature) {
    case 'virt':
      return config.features?.virt?.enabled === true;
    case 'argocd':
      return config.features?.argocd?.enabled === true;
    case 'ovsCni':
      return config.features?.ovsCni?.enabled === true;
  }
  return false;
}

/** The feature that gates a component: its featureGate, or the operator's name-based fallback. */
export function componentFeature(
  name: string,
  spec: ComponentSpec
): Activation['feature'] | undefined {
  if (spec.featureGate) {
    return ['virt', 'argocd', 'ovsCni'].includes(spec.featureGate)
      ? (spec.featureGate as Activation['feature'])
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
    return { active: false, reason: 'Removed: the operator uninstalls it.' };
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
  if (spec.featureGate) {
    const feature = componentFeature(name, spec);
    if (!feature) {
      return { active: false, reason: `Unknown feature gate "${spec.featureGate}".` };
    }
    return featureEnabled(feature, config)
      ? { active: true, feature }
      : { active: false, feature, reason: `${FEATURE_LABEL[feature]} is off.` };
  }
  const feature = componentFeature(name, spec);
  if (feature) {
    return featureEnabled(feature, config)
      ? { active: true, feature }
      : { active: false, feature, reason: `${FEATURE_LABEL[feature]} is off.` };
  }
  return { active: true };
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
  'cert-manager': 'Security',
  headlamp: 'Dashboard',
  'metrics-server': 'Monitoring',
  kubevirt: 'Virtualization',
  virtctl: 'Virtualization',
  cdi: 'Virtualization',
  'kubevirt-manager': 'Virtualization',
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
 * (e.g. ingress-nginx from v2.6.0) are hidden unless asked for.
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
    blockers.push(`Turn off ${FEATURE_LABEL[row.activation.feature]} in Settings instead.`);
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

/** "v2.7.0" from an osImage tag like "v2.7.0-amd64"; null for "latest" or empty. */
export function releaseVersion(rm: ReleaseManifestObject | null | undefined): string | null {
  const tag = rm?.status?.resolvedOSImageTag || rm?.spec?.osImage?.imageTag || '';
  const plain = tag.replace(/-(amd64|arm64)$/, '');
  return parseSemver(plain) ? (plain.startsWith('v') ? plain : `v${plain}`) : null;
}
