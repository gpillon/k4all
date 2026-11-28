/*
 * Turns a settings diff into the list the review dialog shows: what changes,
 * in words, and what it does to the cluster.
 */

import { Capabilities, CAPABILITY_RELEASE, CAPABILITY_SINCE } from './capabilities';
import { belongsTo, componentActivation, Feature, FEATURE_LABEL } from './components';
import { fieldForPath, FIELDS } from './fields';
import { wantedGates } from './gates';
import {
  actionFor,
  changedNodeFields,
  clearedKubeletValue,
  KubeletPrior,
  NodeAction,
} from './nodeSettings';
import { dottedPath, getIn, isPlainObject, jsonEqual, Path } from './objects';
import { catalogEntry, DEFAULT_MODE } from './readiness';
import { formatLabels, formatStorageNodes } from './rookSettings';
import { activeIngress, effectiveIngress, INGRESS_LABEL } from './settings';
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

/**
 * Components of the feature that the change installs (enabled) or removes:
 * active on one side only, from the ReleaseManifest. A component another
 * feature keeps (the snapshot controller with virt or Rook) is not named.
 */
function componentsOf(
  feature: Feature,
  components: Record<string, ComponentSpec>,
  before: ClusterConfigSpec,
  after: ClusterConfigSpec
): string[] {
  return Object.entries(components)
    .filter(([name, spec]) => {
      const a = componentActivation(name, spec, before);
      const b = componentActivation(name, spec, after);
      return (belongsTo(a, feature) || belongsTo(b, feature)) && a.active !== b.active;
    })
    .map(([name]) => name)
    .sort();
}

const FEATURE_OFF: Record<string, string> = {
  argocd:
    'Argo CD stops syncing. Applications it deployed keep running but are no longer reconciled.',
  ovsCni:
    'Pods and VMs attached to OVS secondary networks lose those interfaces when they restart.',
  rook:
    'k4all-operator keeps them installed while a CephCluster exists, and the Storage page says so: ' +
    'delete what lives on Ceph and the CephCluster first (Cairn). k4all never wipes disks: before ' +
    'turning Rook on again, wipe /var/lib/rook and the OSD disks by hand.',
};

/**
 * What turning the feature off does to its components (list), with the
 * installed operator: from v0.5.7 k4all-operator keeps virtualization while
 * VMs and their disks exist, before it deleted it from under them. It names
 * kubevirt-manager only where the release still installs it (k4all v2.6.x;
 * v2.7.0 removes it).
 */
export function featureOffConsequence(feature: Feature, list: string, caps?: Capabilities): string {
  if (feature !== 'virt') {
    return `Uninstalls ${list}. ${FEATURE_OFF[feature]}`;
  }
  if (caps?.virtUninstallGuard) {
    const kept = list.split(', ').includes('kubevirt-manager')
      ? 'KubeVirt and kubevirt-manager'
      : 'KubeVirt';
    return (
      `Uninstalls ${list} once nothing runs on them: k4all-operator keeps ${kept} ` +
      'while VirtualMachines or VirtualMachineInstances exist, and CDI while ' +
      'DataVolumes or PVCs made by CDI exist, and this switch shows what is left. Back up the VM ' +
      'disks you need, then delete the VMs and DataVolumes.'
    );
  }
  return (
    `Uninstalls ${list} at once, even while VMs run: KubeVirt and CDI are deleted from under ` +
    'them, and the VMs and DataVolumes are left with nothing to manage them. Back up the VM disks ' +
    'you need and delete the VMs and DataVolumes first, or upgrade to k4all-operator ' +
    `${CAPABILITY_SINCE.virtUninstallGuard} (k4all ${CAPABILITY_RELEASE.virtUninstallGuard}) ` +
    'first: it keeps them while VMs and their disks exist.'
  );
}

function featureChange(
  feature: Feature,
  label: string,
  enabled: boolean,
  components: Record<string, ComponentSpec>,
  base: ClusterConfigSpec,
  draft: ClusterConfigSpec,
  caps?: Capabilities
): ChangeItem {
  const names = componentsOf(feature, components, base, draft);
  const list = names.length ? names.join(', ') : 'its components';
  return {
    key: `features.${feature}.enabled`,
    label,
    from: enabled ? 'off' : 'on',
    to: enabled ? 'on' : 'off',
    severity: enabled ? 'info' : 'danger',
    consequence: enabled
      ? `Installs ${list}. This takes a few minutes.`
      : featureOffConsequence(feature, list, caps),
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

/**
 * Install-time fields that a newer operator can change live (fields.ts
 * liveWith): what the change does to a running cluster. They can only reach
 * the review when the installed operator has the capability.
 */
const LIVE_DANGER: Record<string, string> = {
  'networking.cni.type':
    'k4all-operator migrates the pod network to the other CNI, node by node. Every pod loses its ' +
    'network until it is restarted, and NetworkPolicies written for one CNI may not apply to the other.',
  'features.ovsBridge.enabled':
    'k4all-operator moves each node address between its interface and the ovs-bridge bridge. ' +
    'Each node loses connectivity for a few seconds; VMs and pods on OVS networks need the bridge.',
};

/** Cluster state the change texts can use when the page has it. */
export interface ChangeContext {
  /** What each kubelet field had before k4all wrote it (kube-system/kubelet-config's record). */
  kubeletPrior?: KubeletPrior | null;
}

export function describeChanges(
  base: ClusterConfigSpec,
  draft: ClusterConfigSpec,
  components: Record<string, ComponentSpec> = {},
  /** What the installed k4all-operator can do; unknown: nothing optional. */
  caps?: Capabilities,
  ctx: ChangeContext = {}
): ChangeItem[] {
  const items: ChangeItem[] = [];
  const seen = new Set<string>();
  const add = (item: ChangeItem) => {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      items.push(item);
    }
  };

  const features: [Feature, string][] = [
    ['virt', FIELDS.virtEnabled.label],
    ['argocd', FIELDS.argocdEnabled.label],
    ['ovsCni', FIELDS.ovsCniEnabled.label],
    ['rook', FEATURE_LABEL.rook],
  ];
  for (const [feature, label] of features) {
    const before = base.features?.[feature]?.enabled === true;
    const after = draft.features?.[feature]?.enabled === true;
    if (before !== after) {
      add(featureChange(feature, label, after, components, base, draft, caps));
    }
  }

  // KubeVirt gates k4all owns: one item per gate, from k4all's two lists.
  const gatesBefore = wantedGates(base);
  const gatesAfter = wantedGates(draft);
  const gateState = (l: typeof gatesBefore, g: string) =>
    l.featureGates.includes(g) ? 'on' : l.disabledFeatureGates.includes(g) ? 'off' : undefined;
  const gateNames = [
    ...new Set([
      ...gatesBefore.featureGates,
      ...gatesBefore.disabledFeatureGates,
      ...gatesAfter.featureGates,
      ...gatesAfter.disabledFeatureGates,
    ]),
  ].sort((a, b) => a.localeCompare(b));
  for (const gate of gateNames) {
    const from = gateState(gatesBefore, gate);
    const to = gateState(gatesAfter, gate);
    if (from !== to) {
      add({
        key: `features.virt.kubevirt.gates.${gate}`,
        label: `Feature gate ${gate}`,
        from: from ?? NOT_OWNED,
        to: to ?? NOT_OWNED,
        severity: to === 'off' ? 'warning' : 'info',
        consequence: GATE_EFFECT[to ?? 'none'](gate),
      });
    }
  }

  const nodeAction = actionFor(changedNodeFields(base.nodes, draft.nodes));

  const controller = activeIngress(components, base);
  const name = INGRESS_LABEL[controller];
  const key = controller === 'nginx' ? 'ingress.nginx' : 'ingress.traefik';
  const tBase = effectiveIngress(base, controller);
  const tDraft = effectiveIngress(draft, controller);
  if (tBase.dedicatedIP !== tDraft.dedicatedIP) {
    add({
      key: `${key}.dedicatedIP`,
      label: `${name} address`,
      from: tBase.dedicatedIP || 'node address',
      to: tDraft.dedicatedIP || 'node address',
      severity: 'warning',
      consequence:
        `${name} is re-deployed on the new address: routes are down for a few seconds, and DNS records ` +
        'pointing at the old address must be updated. The dashboard nip.io route is generated on the nodes ' +
        'from /etc/k4all-config.yaml and keeps the old address: reach Headlamp through its FQDN route or ' +
        'NodePort 32323 afterwards.',
    });
  }
  if (tBase.isDefault !== tDraft.isDefault) {
    add({
      key: `${key}.isDefault`,
      label: `${name} is the default IngressClass`,
      from: tBase.isDefault ? 'yes' : 'no',
      to: tDraft.isDefault ? 'yes' : 'no',
      severity: 'warning',
      consequence: tDraft.isDefault
        ? `Ingresses without an ingressClassName are served by ${name}.`
        : `Ingresses without an ingressClassName are no longer served by ${name}.`,
    });
  }
  if (controller === 'traefik' && tBase.source !== 'traefik' && tDraft.source === 'traefik') {
    add({
      key: 'ingress.traefik',
      label: 'Traefik settings',
      from: 'inherited',
      to: 'spec.ingress.traefik',
      severity: 'info',
      consequence: 'Traefik keeps the same values; from now on they are its own.',
    });
  }

  for (const path of leafChanges(base, draft)) {
    const leaf = dottedPath(path);
    if (
      leaf.startsWith('ingress.traefik') ||
      leaf.startsWith('ingress.nginx') ||
      /^features\.(virt|argocd|ovsCni|rook)\.enabled$/.test(leaf) ||
      /^features\.virt\.kubevirt\.(featureGates|disabledFeatureGates)$/.test(leaf)
    ) {
      continue; // described above
    }
    if (path[0] === 'upgrades' && path[1] === 'remediations' && path.length === 3) {
      add(remediationModeChange(String(path[2]), getIn(base, path), getIn(draft, path)));
      continue;
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
    const isCilium = leaf.startsWith('networking.cni.cilium');
    const fieldKey = info ? dottedPath(info.path) : leaf;
    const fmt = (v: unknown) => FIELD_FORMAT[fieldKey]?.(v) ?? formatValue(v, info?.fallback);
    let effect =
      path[0] === 'nodes' && path[1] !== 'rollout' && nodeAction
        ? NODE_ACTION_EFFECT[nodeAction]
        : FIELD_EFFECT[fieldKey]?.(after);
    // A cleared kubelet field gets back what kubelet-config had before k4all.
    const cleared =
      effect && path[0] === 'nodes' && path[1] === 'kubelet' && after === undefined
        ? clearedKubeletValue(String(path[2]), ctx.kubeletPrior)
        : undefined;
    if (effect && cleared) {
      effect = { ...effect, consequence: `${cleared.text} ${effect.consequence}` };
    }
    if (effect) {
      add({
        key: fieldKey,
        label: info?.label ?? leaf,
        from: fmt(before),
        to: cleared ? cleared.label : fmt(after),
        ...effect,
      });
      continue;
    }
    add({
      key: fieldKey,
      label: info?.label ?? leaf,
      from: fmt(before),
      to: fmt(after),
      severity:
        (info && info.mode !== 'live') || LIVE_DANGER[fieldKey]
          ? 'danger'
          : isCilium
          ? 'warning'
          : 'info',
      consequence:
        LIVE_DANGER[fieldKey] ??
        (isCilium
          ? 'Cilium is upgraded with the new options: its agents restart one node at a time, with a short network interruption on each.'
          : leaf === 'ingress.cilium.dedicatedIP'
          ? 'The MetalLB address pool is updated.'
          : leaf === 'features.virt.emulation'
          ? 'KubeVirt is reconfigured; running VMs keep their mode until they restart.'
          : info?.mode === 'install' || info?.mode === 'node'
          ? info.why
          : undefined),
    });
  }
  return items;
}

/** A change of one remediation's mode (spec.upgrades.remediations, operator v0.7.0). */
function remediationModeChange(id: string, before: unknown, after: unknown): ChangeItem {
  const entry = catalogEntry(id);
  const mode = (v: unknown) => (v === undefined ? `${DEFAULT_MODE} (default)` : String(v));
  const to = after === undefined ? DEFAULT_MODE : String(after);
  const consequence: Record<string, string> = {
    auto:
      'k4all applies it by itself, without asking, on every drain that offers it (upgrades and the ' +
      `node-settings rollout).${entry ? ` Risk: ${entry.riskText}` : ''}`,
    ask: 'k4all applies it once you approve it for the object (Upgrades page).',
    off:
      'k4all only reports it. A finding that stops a drain still holds the node until you fix it ' +
      'or accept; one that only disrupts does not wait.',
  };
  return {
    key: `upgrades.remediations.${id}`,
    label: `Mode of ${entry?.title ?? id}`,
    from: mode(before),
    to: mode(after),
    severity: to === 'auto' && entry?.risk === 'Downtime' ? 'warning' : 'info',
    consequence: consequence[to] ?? (entry ? undefined : 'An id this addon does not know.'),
  };
}

/** How a gate, a field, k4all does not own reads in the review. */
const NOT_OWNED = 'not set by k4all';

const GATE_EFFECT: Record<'on' | 'off' | 'none', (gate: string) => string> = {
  on: gate =>
    `k4all-operator adds ${gate} to the featureGates of the KubeVirt CR; KubeVirt reconfigures ` +
    'its components, running VMs keep running.',
  off: gate =>
    `k4all-operator removes ${gate} from the featureGates of the KubeVirt CR and, on KubeVirt 1.8 ` +
    'and later, lists it in disabledFeatureGates, even where Hangar or an admin set it.',
  none: gate =>
    `k4all stops owning ${gate}: the operator removes only the entry it added, and a value set ` +
    'in Hangar or by an admin stays.',
};

interface Effect {
  severity: ChangeSeverity;
  consequence: string;
}

/** What the nodes do, by the strongest action of the node settings that change. */
const NODE_ACTION_EFFECT: Record<NodeAction, Effect> = {
  restart: {
    severity: 'warning',
    consequence:
      'kubelet restarts on every node, one at a time, without a drain: running pods keep running.',
  },
  'drain-restart': {
    severity: 'danger',
    consequence:
      'Every node, one at a time, is drained and its kubelet restarts with a fresh CPU manager ' +
      'state. The plan above lists the order.',
  },
  'drain-reboot': {
    severity: 'danger',
    consequence:
      'Every node, one at a time, is drained and reboots with the new kernel arguments. The plan ' +
      'above lists the order.',
  },
};

const NEXT_START = 'Applies to the VM pods created from now on (VM starts and live migrations).';

const CREATION_INPUT =
  'Read once, when k4all creates the Ceph cluster; once the cluster exists it does nothing ' +
  '(manage the cluster in Cairn).';

/** How a field's value reads in the review, where formatValue would not do (lists of objects, maps). */
const FIELD_FORMAT: Record<string, (value: unknown) => string> = {
  'features.rook.storage.nodes': formatStorageNodes,
  'features.rook.monitoring.labels': formatLabels,
  'features.rook.csi.imageVariant': v => (v === undefined ? 'Auto' : String(v)),
  'features.rook.filesystem.enabled': v =>
    v === true ? 'on' : v === false ? 'off' : 'not set (with a new Ceph cluster)',
};

/** Effects of the k4all v2.7.0 fields, by their path; `after` is the new value. */
const FIELD_EFFECT: Record<string, (after: unknown) => Effect> = {
  'features.virt.hangar.nodeAgent': after =>
    after === false
      ? {
          severity: 'warning',
          consequence:
            "Uninstalls hangar-node-agent: Hangar's Hardware tab and PCI passthrough stop working. " +
            'Devices already bound to vfio-pci stay bound.',
        }
      : {
          severity: 'info',
          consequence:
            'Installs hangar-node-agent, a privileged DaemonSet in hangar-system that only acts on ' +
            "what Hangar's passthrough ConfigMap asks.",
        },
  'features.virt.kubevirt.vmStateStorageClass': after =>
    after === undefined
      ? {
          severity: 'warning',
          consequence:
            'k4all stops owning it: the operator removes the value it wrote from the KubeVirt CR, and ' +
            'KubeVirt falls back to the default StorageClass (or what Hangar sets there).',
        }
      : {
          severity: 'info',
          consequence:
            'KubeVirt creates the persistent state of new VMs there; existing state volumes stay where they are.',
        },
  'features.virt.metadata.enabled': after =>
    after === true
      ? {
          severity: 'info',
          consequence:
            'Installs k4all-metadata: the VMs of the scope get 169.254.169.254 from their next start or migration.',
        }
      : {
          severity: 'warning',
          consequence:
            'Uninstalls k4all-metadata: 169.254.169.254 stops answering at once, running VMs included, and a VM ' +
            'that restarts gets no k4all MAC or metadata server. VMs without a cloud-init disk then boot without ' +
            'SSH keys or user-data.',
        },
  'features.virt.metadata.scope': after =>
    after === 'All'
      ? {
          severity: 'warning',
          consequence:
            'Every VM in a namespace whose PodSecurity allows it gets the metadata server at its next start, labelled or not.',
        }
      : { severity: 'info', consequence: NEXT_START },
  'features.virt.metadata.tokens.audiences': () => ({ severity: 'info', consequence: NEXT_START }),
  'features.virt.metadata.tokens.expirationSeconds': () => ({
    severity: 'info',
    consequence: NEXT_START,
  }),
  'features.virt.metadata.vendorDataConfigMap': () => ({
    severity: 'info',
    consequence: NEXT_START,
  }),
  'features.virt.hangar.guestBridge': after =>
    after === false
      ? {
          severity: 'warning',
          consequence:
            "Uninstalls hangar-guest-bridge, its APIService first: Hangar's Guest and Files tabs " +
            'stop working. The VMs and their guest agents are untouched.',
        }
      : {
          severity: 'info',
          consequence:
            'Installs hangar-guest-bridge: the API subresources.hangar.magesgate.com and one pod per ' +
            "node in hangar-system, for Hangar's Guest and Files tabs.",
        },
  'features.rook.storage.deviceFilter': () => ({ severity: 'info', consequence: CREATION_INPUT }),
  'features.rook.storage.nodes': () => ({
    severity: 'info',
    consequence: `${CREATION_INPUT} Only the named devices become OSDs, one each.`,
  }),
  'features.rook.csi.imageVariant': after =>
    after === 'Standard'
      ? {
          severity: 'warning',
          consequence:
            'Forces the standard cephcsi build: on a node below x86-64-v3 the Ceph CSI plugins cannot ' +
            'start, and the Ceph volumes of that node stop working. A different build restarts the ' +
            'plugins one node at a time; mounted volumes stay mounted.',
        }
      : after === 'OlderCPUs'
      ? {
          severity: 'info',
          consequence:
            'Forces the cephcsi build for older CPUs (the same ceph-csi version on Rocky Linux 9, which ' +
            'upstream tests less). A different build restarts the plugins one node at a time; mounted ' +
            'volumes stay mounted.',
        }
      : {
          severity: 'info',
          consequence:
            "k4all picks the cephcsi build from the nodes' CPUs (the RookCSIImage condition says which " +
            'and why). A different build restarts the plugins one node at a time; mounted volumes stay ' +
            'mounted.',
        },
  'features.rook.monitoring.enabled': after =>
    after === true
      ? {
          severity: 'info',
          consequence:
            "Turns on Rook's ServiceMonitors (mgr, ceph-exporter) and the PrometheusRule " +
            'rook-ceph/k4all-ceph-alerts. k4all then owns spec.monitoring and spec.labels.monitoring ' +
            'of the CephCluster (Cairn shows them read-only). Without a Prometheus Operator nothing is ' +
            'created.',
        }
      : {
          severity: 'info',
          consequence:
            'k4all deletes its PrometheusRule, turns the ServiceMonitors off and gives back the two ' +
            'CephCluster fields it owned.',
        },
  'features.rook.monitoring.labels': () => ({
    severity: 'info',
    consequence: 'The ServiceMonitors and the PrometheusRule get these labels.',
  }),
  'features.rook.filesystem.enabled': after =>
    after === true
      ? {
          severity: 'warning',
          consequence:
            'Creates CephFS now if it is missing: two pools, two MDS daemons (up to 1 GiB of memory ' +
            'each), the StorageClass ceph-cephfs and its snapshot class. Once created they are ' +
            "Cairn's.",
        }
      : after === false
      ? {
          severity: 'info',
          consequence:
            'k4all never creates CephFS; a filesystem that exists stays (k4all deletes none).',
        }
      : {
          severity: 'info',
          consequence:
            'Back to the default: CephFS comes with a Ceph cluster k4all creates; one that exists ' +
            'stays.',
        },
  'features.rook.smallCluster': after =>
    after === 'Allow'
      ? {
          severity: 'warning',
          consequence: `${CREATION_INPUT} Below 3 nodes the cluster has no redundancy.`,
        }
      : { severity: 'info', consequence: CREATION_INPUT },
  'nodes.rollout.paused': after =>
    after === true
      ? {
          severity: 'info',
          consequence: 'The rollout stops before the next node; the node in progress finishes.',
        }
      : { severity: 'info', consequence: 'The rollout goes on with the next node.' },
};

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
  'cdi',
  'ceph-csi-drivers',
  'cilium',
  'headlamp',
  'ingress-nginx',
  'k4all-metadata',
  'kubevirt',
  'kubevirt-manager',
  'metallb',
  'nmstate',
  'rook-ceph',
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
