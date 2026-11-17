/*
 * Turns a settings diff into the list the review dialog shows: what changes,
 * in words, and what it does to the cluster.
 */

import { componentActivation } from './components';
import { fieldForPath, FIELDS } from './fields';
import { dottedPath, getIn, isPlainObject, jsonEqual, Path } from './objects';
import { effectiveTraefik } from './settings';
import { ClusterConfigSpec, ComponentSpec } from './types';

export type ChangeSeverity = 'info' | 'warning' | 'danger';

export interface ChangeItem {
  key: string;
  label: string;
  from: string;
  to: string;
  severity: ChangeSeverity;
  consequence?: string;
}

export function formatValue(value: unknown, fallback = 'not set'): string {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : 'none';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Components a feature installs, from the ReleaseManifest. */
function componentsOf(
  feature: 'virt' | 'argocd' | 'ovsCni',
  components: Record<string, ComponentSpec>,
  config: ClusterConfigSpec
): string[] {
  const on: ClusterConfigSpec = {
    ...config,
    features: {
      ...config.features,
      [feature]: { ...(config.features?.[feature] ?? {}), enabled: true },
    },
  };
  return Object.entries(components)
    .filter(([name, spec]) => {
      const a = componentActivation(name, spec, on);
      return a.feature === feature && a.active;
    })
    .map(([name]) => name)
    .sort();
}

const FEATURE_OFF: Record<string, string> = {
  virt: 'Virtual machines stop and are deleted with the KubeVirt resources. Back up VM disks you need first.',
  argocd:
    'Argo CD stops syncing. Applications it deployed keep running but are no longer reconciled.',
  ovsCni:
    'Pods and VMs attached to OVS secondary networks lose those interfaces when they restart.',
};

function featureChange(
  feature: 'virt' | 'argocd' | 'ovsCni',
  label: string,
  enabled: boolean,
  components: Record<string, ComponentSpec>,
  base: ClusterConfigSpec
): ChangeItem {
  const names = componentsOf(feature, components, base);
  const list = names.length ? names.join(', ') : 'its components';
  return {
    key: `features.${feature}.enabled`,
    label,
    from: enabled ? 'off' : 'on',
    to: enabled ? 'on' : 'off',
    severity: enabled ? 'info' : 'danger',
    consequence: enabled
      ? `Installs ${list}. This takes a few minutes.`
      : `Uninstalls ${list}. ${FEATURE_OFF[feature]}`,
  };
}

/** Leaf paths where base and draft differ, descending into objects added or removed whole. */
export function leafChanges(base: unknown, draft: unknown, path: Path = []): Path[] {
  if (jsonEqual(base, draft)) {
    return [];
  }
  const bObj = isPlainObject(base) || base === undefined;
  const dObj = isPlainObject(draft) || draft === undefined;
  if (bObj && dObj && (isPlainObject(base) || isPlainObject(draft))) {
    const b = (base ?? {}) as Record<string, unknown>;
    const d = (draft ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(d)])].sort();
    const out: Path[] = [];
    for (const key of keys) {
      out.push(...leafChanges(b[key], d[key], [...path, key]));
    }
    return out;
  }
  return [path];
}

export function describeChanges(
  base: ClusterConfigSpec,
  draft: ClusterConfigSpec,
  components: Record<string, ComponentSpec> = {}
): ChangeItem[] {
  const items: ChangeItem[] = [];
  const seen = new Set<string>();
  const add = (item: ChangeItem) => {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      items.push(item);
    }
  };

  const features: ['virt' | 'argocd' | 'ovsCni', string][] = [
    ['virt', FIELDS.virtEnabled.label],
    ['argocd', FIELDS.argocdEnabled.label],
    ['ovsCni', FIELDS.ovsCniEnabled.label],
  ];
  for (const [feature, label] of features) {
    const before = base.features?.[feature]?.enabled === true;
    const after = draft.features?.[feature]?.enabled === true;
    if (before !== after) {
      add(featureChange(feature, label, after, components, base));
    }
  }

  const tBase = effectiveTraefik(base);
  const tDraft = effectiveTraefik(draft);
  if (tBase.dedicatedIP !== tDraft.dedicatedIP) {
    add({
      key: 'ingress.traefik.dedicatedIP',
      label: 'Traefik address',
      from: tBase.dedicatedIP || 'node address',
      to: tDraft.dedicatedIP || 'node address',
      severity: 'warning',
      consequence:
        'Traefik is re-deployed on the new address: routes are down for a few seconds, and DNS records ' +
        'pointing at the old address must be updated. The dashboard nip.io route is generated on the nodes ' +
        'from /etc/k4all-config.yaml and keeps the old address: reach Headlamp through its FQDN route or ' +
        'NodePort 32323 afterwards.',
    });
  }
  if (tBase.isDefault !== tDraft.isDefault) {
    add({
      key: 'ingress.traefik.isDefault',
      label: 'Traefik is the default IngressClass',
      from: tBase.isDefault ? 'yes' : 'no',
      to: tDraft.isDefault ? 'yes' : 'no',
      severity: 'warning',
      consequence: tDraft.isDefault
        ? 'Ingresses without an ingressClassName are served by Traefik.'
        : 'Ingresses without an ingressClassName are no longer served by Traefik.',
    });
  }
  if (tBase.source !== 'traefik' && tDraft.source === 'traefik') {
    add({
      key: 'ingress.traefik',
      label: 'Ingress settings key',
      from: 'spec.ingress.nginx (before v2.6.0)',
      to: 'spec.ingress.traefik',
      severity: 'info',
      consequence: 'The Traefik settings get their own key; the values are the same.',
    });
  }

  for (const path of leafChanges(base, draft)) {
    const key = dottedPath(path);
    if (
      key.startsWith('ingress.traefik') ||
      key.startsWith('ingress.nginx') ||
      /^features\.(virt|argocd|ovsCni)\.enabled$/.test(key)
    ) {
      continue; // described above
    }
    if (path[0] === 'componentOverrides') {
      const component = String(path[1]);
      add({
        key: `componentOverrides.${component}`,
        label: `Overrides of ${component}`,
        from: getIn(base, ['componentOverrides', component]) ? 'set' : 'none',
        to: getIn(draft, ['componentOverrides', component]) ? 'changed' : 'none',
        severity: 'warning',
        consequence: `${component} is applied again (helm upgrade) with the new values.`,
      });
      continue;
    }
    const info = fieldForPath(path);
    const before = getIn(base, info?.path ?? path);
    const after = getIn(draft, info?.path ?? path);
    if (jsonEqual(before, after)) {
      continue;
    }
    const isCilium = key.startsWith('networking.cni.cilium');
    add({
      key: info ? dottedPath(info.path) : key,
      label: info?.label ?? key,
      from: formatValue(before, info?.fallback),
      to: formatValue(after, info?.fallback),
      severity: info && info.mode !== 'live' ? 'danger' : isCilium ? 'warning' : 'info',
      consequence: isCilium
        ? 'Cilium is upgraded with the new options: its agents restart one node at a time, with a short network interruption on each.'
        : key === 'ingress.cilium.dedicatedIP'
        ? 'The MetalLB address pool is updated.'
        : key === 'features.virt.emulation'
        ? 'KubeVirt is reconfigured; running VMs keep their mode until they restart.'
        : info?.mode === 'install' || info?.mode === 'node'
        ? info.why
        : undefined,
    });
  }
  return items;
}

export function needsAcknowledgement(items: ChangeItem[]): boolean {
  return items.some(i => i.severity === 'danger');
}

export interface Adjustment {
  path: string;
  sent: unknown;
  stored: unknown;
}

/**
 * Where the API server's dry-run result differs from the draft that was sent:
 * CRD defaults it filled in, or fields it dropped (unknown to the installed
 * CRD version when strict validation is not available).
 */
export function serverAdjustments(
  sent: ClusterConfigSpec,
  stored: ClusterConfigSpec | undefined
): Adjustment[] {
  return leafChanges(sent, stored ?? {}).map(path => ({
    path: dottedPath(path),
    sent: getIn(sent, path),
    stored: getIn(stored, path),
  }));
}

/**
 * Components with an operator hook (internal/controller/hooks/registry.go):
 * their appliedHash includes the whole ClusterConfig spec except
 * componentOverrides, so any settings change re-applies them.
 */
export const HOOKED_COMPONENTS = [
  'calico',
  'cilium',
  'headlamp',
  'ingress-nginx',
  'kubevirt',
  'metallb',
  'nmstate',
  'topolvm',
  'traefik',
];

/** The installed components k4all-operator applies again after this change. */
export function reappliedComponents(
  base: ClusterConfigSpec,
  draft: ClusterConfigSpec,
  components: Record<string, ComponentSpec>
): string[] {
  const withoutOverrides = (spec: ClusterConfigSpec) => ({
    ...spec,
    componentOverrides: undefined,
  });
  const settingsChanged = leafChanges(withoutOverrides(base), withoutOverrides(draft)).length > 0;
  const names = new Set<string>();
  for (const [name, spec] of Object.entries(components)) {
    const activeBefore = componentActivation(name, spec, base).active;
    const activeAfter = componentActivation(name, spec, draft).active;
    if (!activeBefore || !activeAfter) {
      continue; // installs and removals are listed as changes already
    }
    if (settingsChanged && HOOKED_COMPONENTS.includes(name)) {
      names.add(name);
    }
    if (!jsonEqual(base.componentOverrides?.[name], draft.componentOverrides?.[name])) {
      names.add(name);
    }
  }
  return [...names].sort();
}
