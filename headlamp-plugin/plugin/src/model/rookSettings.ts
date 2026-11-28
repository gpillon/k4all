/*
 * The Rook settings of k4all v2.7.2 (k4all-operator v0.7.0), next to the
 * creation inputs of storage.ts:
 *
 * - named OSD devices, features.rook.storage.nodes (k4all#120): the only
 *   way to give Ceph a logical volume; exclusive with deviceFilter, read
 *   once when k4all creates the CephCluster;
 * - the cephcsi build, features.rook.csi.imageVariant and the RookCSIImage
 *   condition (k4all#121);
 * - the crash collector (k4all#122): a field of the CephCluster itself,
 *   which k4all seeds once and never owns, so the page reads and patches
 *   the CephCluster, never the ClusterConfig (a change made in Cairn stays);
 * - monitoring, features.rook.monitoring and the RookMonitoring condition,
 *   with the Prometheus Operator check (k4all#122);
 * - CephFS, features.rook.filesystem.enabled (k4all#122).
 */

import type { Tone } from './components';
import { setPruned } from './objects';
import { JsonPatchOp, precondition } from './patch';
import { Draft } from './settings';
import {
  CephClusterLike,
  ClusterConfigSpec,
  Condition,
  ManagedFieldsEntry,
  NODE_X86_LEVEL_ANNOTATION,
  NodeLike,
  RookStorageNode,
} from './types';
import type { Issue } from './validation';

// ----------------------------------------------------------- named devices

/** The CRD's pattern for a device of storage.nodes. */
export const DEVICE_PATH = /^\/dev\/[A-Za-z0-9._/:+-]+$/;
export const MAX_STORAGE_NODES = 64;
export const MAX_NODE_DEVICES = 32;

export const STORAGE_NODES_PATH = ['features', 'rook', 'storage', 'nodes'];

export function storageNodes(spec: ClusterConfigSpec): RookStorageNode[] {
  return spec.features?.rook?.storage?.nodes ?? [];
}

/** Writes the list; an empty one removes the field (and storage, when it was all). */
export function setStorageNodes(draft: Draft, nodes: RookStorageNode[]): Draft {
  return setPruned(draft, STORAGE_NODES_PATH, nodes.length > 0 ? nodes : undefined);
}

/** A logical volume path, /dev/<vg>/<lv> (not /dev/disk/…, /dev/mapper/…). */
export function isLogicalVolumePath(path: string): boolean {
  return /^\/dev\/(?!disk\/|mapper\/)[^/]+\/[^/]+$/.test(path);
}

/** The taint that keeps Rook's pods away from a node, as the operator's cephNodes rule reads it. */
export function awayTaint(node: NodeLike): string | undefined {
  const t = (node.spec?.taints ?? []).find(
    x =>
      !x.key.startsWith('node.kubernetes.io/') &&
      (x.effect === 'NoSchedule' || x.effect === 'NoExecute')
  );
  return t ? `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}` : undefined;
}

/** The nodes that hold OSDs: those storage.nodes names, else every schedulable one. */
export function osdHosts(spec: ClusterConfigSpec, schedulable: number): number {
  const named = storageNodes(spec);
  return named.length > 0 ? named.length : schedulable;
}

/**
 * Checks of storage.nodes. Errors are what the CRD or the operator refuse
 * (exclusive with deviceFilter, a name missing or twice, no device, a path
 * that is not one, limits); warnings are what makes the operator wait (a
 * node not in the cluster, or tainted against Rook's pods).
 */
export function namedDeviceIssues(spec: ClusterConfigSpec, nodes: NodeLike[]): Issue[] {
  const named = storageNodes(spec);
  if (named.length === 0) {
    return [];
  }
  const issues: Issue[] = [];
  const add = (severity: Issue['severity'], message: string) =>
    issues.push({ field: 'rookStorageNodes', severity, message });
  if (spec.features?.rook?.storage?.deviceFilter) {
    add('error', 'Disks for Ceph and Named devices are exclusive: clear one of them.');
  }
  if (named.length > MAX_STORAGE_NODES) {
    add('error', `At most ${MAX_STORAGE_NODES} nodes can be named (${named.length} now).`);
  }
  const byName = new Map(nodes.map(n => [n.metadata.name, n]));
  const seen = new Set<string>();
  named.forEach((entry, i) => {
    const name = entry.name.trim();
    const who = name ? `Node ${name}` : `Entry ${i + 1}`;
    if (!name) {
      add('error', `${who}: choose a node.`);
    } else if (seen.has(name)) {
      add('error', `Node ${name} is named twice.`);
    } else {
      const node = byName.get(name);
      if (!node) {
        add(
          'warning',
          `Node ${name} is not in the cluster: k4all creates the Ceph cluster once every named node is.`
        );
      } else {
        const taint = awayTaint(node);
        if (taint) {
          add(
            'warning',
            `Node ${name} has a taint that keeps Rook's pods away (${taint}): k4all waits until it goes.`
          );
        }
      }
    }
    seen.add(name);
    const devices = entry.devices ?? [];
    if (devices.length === 0) {
      add('error', `${who}: name at least one device.`);
    }
    if (devices.length > MAX_NODE_DEVICES) {
      add('error', `${who}: at most ${MAX_NODE_DEVICES} devices (${devices.length} now).`);
    }
    const paths = new Set<string>();
    for (const d of devices) {
      if (!DEVICE_PATH.test(d.name)) {
        add(
          'error',
          d.name
            ? `${who}: "${d.name}" is not a device path (/dev/<vg>/<lv>, /dev/disk/by-id/<id> or /dev/<name>).`
            : `${who}: a device path is empty.`
        );
      } else if (paths.has(d.name)) {
        add('error', `${who}: ${d.name} is named twice.`);
      }
      paths.add(d.name);
    }
  });
  return issues;
}

/** The named devices as one line, for read-only facts and the review. */
export function formatStorageNodes(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return 'none';
  }
  return (value as RookStorageNode[])
    .map(n => `${n.name}: ${(n.devices ?? []).map(d => d.name).join(', ')}`)
    .join('; ');
}

// ----------------------------------------------------------- cephcsi build

export type CsiVariant = 'Auto' | 'Standard' | 'OlderCPUs';

export const CSI_VARIANT_PATH = ['features', 'rook', 'csi', 'imageVariant'];

export function csiVariant(spec: ClusterConfigSpec): CsiVariant {
  const v = spec.features?.rook?.csi?.imageVariant;
  return v === 'Standard' || v === 'OlderCPUs' ? v : 'Auto';
}

/** Auto is written as absent, so the release default keeps applying. */
export function setCsiVariant(draft: Draft, variant: CsiVariant): Draft {
  return setPruned(draft, CSI_VARIANT_PATH, variant === 'Auto' ? undefined : variant);
}

export const CSI_VARIANT_LABEL: Record<CsiVariant, string> = {
  Auto: 'Auto: from the nodes’ CPUs',
  Standard: 'Standard build (x86-64-v3)',
  OlderCPUs: 'Build for older CPUs',
};

export interface ConditionView {
  title: string;
  severity: 'success' | 'info' | 'warning' | 'error';
  /** The operator's message, as written. */
  message?: string;
  /** What to do or to know, in words. */
  hint?: string;
}

/** RookCSIImage in words: which build runs, and why. */
export function csiImageView(cond: Condition | undefined): ConditionView | null {
  if (!cond) {
    return null;
  }
  const message = cond.message;
  const unknown = { title: `cephcsi build: ${cond.reason ?? cond.status}`, message };
  switch (cond.reason) {
    case 'StandardImage':
      return {
        title: 'The standard cephcsi build: every amd64 node runs x86-64-v3 or later',
        severity: 'success',
        message,
      };
    case 'OlderCPUNode':
      return {
        title: 'The cephcsi build for older CPUs: a node reports a CPU below x86-64-v3',
        severity: 'info',
        message,
        hint:
          'The same ceph-csi version, built on Rocky Linux 9 (upstream tests it less than the ' +
          'standard build). One such node is enough: every node runs the same CSI plugin.',
      };
    case 'NodeLevelUnknown':
      return {
        title: "The cephcsi build for older CPUs: a node's CPU level is unknown",
        severity: 'info',
        message,
        hint:
          'A node on a k4all release before v2.7.2 (or not installed by k4all) reports no level. ' +
          'Once every amd64 node says x86-64-v3 or later, the drivers move to the standard build ' +
          'after 10 minutes.',
      };
    case 'NodeLevelPending':
      return {
        title: 'The cephcsi build is kept: a node has not reported its CPU level yet',
        severity: 'info',
        message,
        hint: 'A node that just joined or rebooted reports within minutes; k4all waits at most 5.',
      };
    case 'Override':
      return cond.status === 'False'
        ? {
            title: 'The forced cephcsi build does not fit a node',
            severity: 'warning',
            message,
            hint:
              'The standard build cannot start on a CPU below x86-64-v3: choose Auto or the ' +
              'build for older CPUs, or the Ceph volumes of that node stop working.',
          }
        : { title: 'The cephcsi build the setting below forces', severity: 'info', message };
    case 'ComponentOverride':
      return {
        title: 'A component override sets the cephcsi image: k4all sets none',
        severity: 'info',
        message,
        hint: message?.includes('you can drop the override')
          ? 'Auto would choose the same image: remove the override (Components, rook-ceph or ' +
            'ceph-csi-drivers) and k4all keeps the build right as nodes come and go.'
          : 'While the override is set, the setting below does nothing.',
      };
    case 'CheckFailed':
      return {
        title: 'k4all-operator could not check which cephcsi build fits',
        severity: 'warning',
        message,
      };
  }
  return { ...unknown, severity: cond.status === 'False' ? 'warning' : 'info' };
}

export interface NodeCpuLevel {
  name: string;
  arch: string;
  /** "v1" to "v4"; null when the node reports none (or is not amd64). */
  level: string | null;
}

/** The x86-64 level each node reports (k4all.magesgate.com/x86-64-level), by name. */
export function nodeCpuLevels(nodes: NodeLike[]): NodeCpuLevel[] {
  return nodes
    .map(n => {
      const raw = n.metadata.annotations?.[NODE_X86_LEVEL_ANNOTATION];
      return {
        name: n.metadata.name,
        arch: n.status?.nodeInfo?.architecture ?? 'unknown',
        level: raw && /^v[1-4]$/.test(raw) ? raw : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function belowV3(level: string | null): boolean {
  return level === 'v1' || level === 'v2';
}

/** A forced standard build on a node that reports a CPU below x86-64-v3. */
export function csiIssues(spec: ClusterConfigSpec, nodes: NodeLike[]): Issue[] {
  if (csiVariant(spec) !== 'Standard') {
    return [];
  }
  const below = nodeCpuLevels(nodes).filter(n => n.arch === 'amd64' && belowV3(n.level));
  return below.length === 0
    ? []
    : [
        {
          field: 'rookCSIImageVariant',
          severity: 'warning',
          message: `${below
            .map(n => `${n.name} reports x86-64-${n.level}`)
            .join(
              ', '
            )}: the standard build cannot start there, and its Ceph volumes stop working.`,
        },
      ];
}

// --------------------------------------------------------- crash collector

export const CRASH_COLLECTOR_PATH = ['spec', 'crashCollector', 'disable'];

export interface CrashCollectorView {
  /** Rook runs the collector: spec.crashCollector.disable is not true. */
  on: boolean;
  /** spec.crashCollector is in the CephCluster (absent: Rook's default, on). */
  set: boolean;
  daysToRetain?: number;
  /** The field managers of spec.crashCollector.disable. */
  managers: string[];
}

function ownsPath(fields: unknown, path: string[]): boolean {
  let cur = fields as Record<string, unknown> | undefined;
  for (const key of path) {
    const next = cur?.[`f:${key}`];
    if (next === undefined || next === null || typeof next !== 'object') {
      return false;
    }
    cur = next as Record<string, unknown>;
  }
  return true;
}

/** Who wrote a field of obj, from metadata.managedFields (spec, not status). */
export function fieldManagersOf(
  managed: ManagedFieldsEntry[] | undefined,
  path: string[]
): string[] {
  return (managed ?? [])
    .filter(m => !m.subresource && m.manager && ownsPath(m.fieldsV1, path))
    .map(m => m.manager as string);
}

export function crashCollectorOf(cluster: CephClusterLike): CrashCollectorView {
  const cc = cluster.spec?.crashCollector;
  return {
    on: cc?.disable !== true,
    set: cc !== undefined,
    daysToRetain: cc?.daysToRetain,
    managers: fieldManagersOf(cluster.metadata.managedFields, CRASH_COLLECTOR_PATH),
  };
}

/** A field manager in words. */
export function managerLabel(manager: string): string {
  switch (manager) {
    case 'k4all-operator-seed':
      return 'k4all, when it created the cluster';
    case 'k4all-operator':
      return 'k4all-operator';
    case 'k4all-headlamp':
      return 'the k4all addon';
  }
  return manager;
}

/**
 * The JSON Patch that turns the CephCluster's crash collector on or off,
 * like Cairn's edits: guarded by a test of the value read (a change made
 * meanwhile in Cairn is refused, not overwritten), so Rook's status writes
 * do not get in the way. Only spec.crashCollector.disable changes.
 */
export function crashCollectorPatch(cluster: CephClusterLike, on: boolean): JsonPatchOp[] {
  const cur = cluster.spec?.crashCollector;
  if (cur !== undefined) {
    return [
      { op: 'test', path: '/spec/crashCollector', value: cur },
      { op: 'add', path: '/spec/crashCollector/disable', value: !on },
    ];
  }
  return [
    precondition(cluster),
    { op: 'add', path: '/spec/crashCollector', value: { disable: !on } },
  ];
}

// -------------------------------------------------------------- monitoring

export const MAX_MONITORING_LABELS = 8;
export const MONITORING_ENABLED_PATH = ['features', 'rook', 'monitoring', 'enabled'];
export const MONITORING_LABELS_PATH = ['features', 'rook', 'monitoring', 'labels'];

/** What the cluster serves of the Prometheus Operator's API (monitoring.coreos.com/v1). */
export interface PrometheusOperatorApis {
  serviceMonitors: boolean;
  prometheusRules: boolean;
}

/** From the APIResourceList of monitoring.coreos.com/v1. */
export function prometheusOperatorApis(
  list: {
    resources?: { name: string }[];
  } | null
): PrometheusOperatorApis {
  const names = new Set((list?.resources ?? []).map(r => r.name));
  return {
    serviceMonitors: names.has('servicemonitors'),
    prometheusRules: names.has('prometheusrules'),
  };
}

export function prometheusOperatorServed(apis: PrometheusOperatorApis): boolean {
  return apis.serviceMonitors && apis.prometheusRules;
}

export const PROMETHEUS_OPERATOR_MISSING =
  'monitoring.coreos.com ServiceMonitor and PrometheusRule are not served: install a Prometheus ' +
  'Operator (k4all ships none). Until then k4all creates nothing.';

const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** A Kubernetes label key: [prefix/]name. */
export function labelKeyProblem(key: string): string | undefined {
  if (!key) {
    return 'a label key is empty';
  }
  const parts = key.split('/');
  if (parts.length > 2) {
    return `"${key}" is not a label key`;
  }
  const [prefix, name] = parts.length === 2 ? parts : [undefined, parts[0]];
  if (prefix !== undefined && (prefix.length > 253 || !DNS_SUBDOMAIN.test(prefix))) {
    return `"${key}": the prefix must be a DNS subdomain`;
  }
  if (!LABEL_NAME.test(name)) {
    return `"${key}" is not a label key (at most 63 letters, digits, -, _ or ., starting and ending with a letter or digit)`;
  }
  return undefined;
}

export function labelValueProblem(key: string, value: string): string | undefined {
  return value === '' || LABEL_NAME.test(value)
    ? undefined
    : `the value of ${
        key || 'a label'
      } is not a label value (at most 63 letters, digits, -, _ or ., starting and ending with a letter or digit)`;
}

/**
 * Checks of features.rook.monitoring: the labels (at most 8, valid keys and
 * values) and, once the switch is on, the Prometheus Operator's APIs (null:
 * not known yet).
 */
export function monitoringIssues(
  spec: ClusterConfigSpec,
  apis: PrometheusOperatorApis | null
): Issue[] {
  const m = spec.features?.rook?.monitoring;
  const issues: Issue[] = [];
  const labels = Object.entries(m?.labels ?? {});
  if (labels.length > MAX_MONITORING_LABELS) {
    issues.push({
      field: 'rookMonitoringLabels',
      severity: 'error',
      message: `At most ${MAX_MONITORING_LABELS} labels (${labels.length} now).`,
    });
  }
  for (const [key, value] of labels) {
    const problem = labelKeyProblem(key) ?? labelValueProblem(key, value);
    if (problem) {
      issues.push({
        field: 'rookMonitoringLabels',
        severity: 'error',
        message: problem.charAt(0).toUpperCase() + problem.slice(1) + '.',
      });
    }
  }
  if (m?.enabled === true && apis && !prometheusOperatorServed(apis)) {
    issues.push({
      field: 'rookMonitoringEnabled',
      severity: 'warning',
      message: PROMETHEUS_OPERATOR_MISSING,
    });
  }
  return issues;
}

/** RookMonitoring in words. */
export function monitoringView(cond: Condition | undefined): ConditionView | null {
  if (!cond) {
    return null;
  }
  const message = cond.message;
  switch (cond.reason) {
    case 'Enabled':
      return {
        title: "Ceph metrics on: Rook's ServiceMonitors and k4all's alert rules exist",
        severity: 'success',
        message,
      };
    case 'Disabled':
      return { title: 'Ceph metrics off', severity: 'info', message };
    case 'PrometheusOperatorMissing':
      return {
        title: 'No Prometheus Operator: k4all created nothing',
        severity: 'warning',
        message,
        hint: 'Install a Prometheus Operator (kube-prometheus-stack, for example); k4all ships none. The metrics follow by themselves.',
      };
    case 'CheckFailed':
      return {
        title: 'k4all-operator could not check for a Prometheus Operator',
        severity: 'warning',
        message,
      };
  }
  return {
    title: `Ceph metrics: ${cond.reason ?? cond.status}`,
    severity: cond.status === 'False' ? 'warning' : 'info',
    message,
  };
}

export function formatLabels(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return 'none';
  }
  const entries = Object.entries(value as Record<string, string>);
  return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

// ------------------------------------------------------------------ CephFS

export type FilesystemMode = 'default' | 'on' | 'off';

export const FILESYSTEM_PATH = ['features', 'rook', 'filesystem', 'enabled'];

/** The StorageClass and the filesystem k4all creates (seeds, then Cairn's). */
export const CEPHFS_STORAGE_CLASS = 'ceph-cephfs';
export const CEPHFS_FILESYSTEM = 'rook-ceph/cephfs';

export function filesystemMode(spec: ClusterConfigSpec): FilesystemMode {
  const v = spec.features?.rook?.filesystem?.enabled;
  return v === true ? 'on' : v === false ? 'off' : 'default';
}

export function setFilesystemMode(draft: Draft, mode: FilesystemMode): Draft {
  return setPruned(
    draft,
    FILESYSTEM_PATH,
    mode === 'on' ? true : mode === 'off' ? false : undefined
  );
}

export const FILESYSTEM_MODE_TEXT: Record<FilesystemMode, string> = {
  default:
    'Not set: CephFS comes with a Ceph cluster k4all creates (k4all v2.7.2 and later). A cluster ' +
    'created before stays without it until you choose On.',
  on: 'On: k4all creates CephFS now if it is missing, once; from then on it is managed in Cairn.',
  off: 'Off: k4all never creates CephFS. It deletes nothing either: a filesystem that exists stays.',
};

export const CEPHFS_SELINUX =
  'Pods that share a CephFS volume need the same securityContext.seLinuxOptions.level: every pod ' +
  'gets its own SELinux categories, and CephFS keeps per-pod labels (a mount option does not ' +
  'change that). One pod per volume, or VMs that live-migrate, need nothing.';

// ------------------------------------------------------------ RookReady

/** What to do for the RookReady reasons of named devices (operator v0.7.0, op#78). */
export function rookReadyHint(cond: Condition | undefined): string | undefined {
  switch (cond?.reason) {
    case 'StorageNodesUnusable':
      return (
        'Nothing is created until every named node is in the cluster without a taint that keeps ' +
        "Rook's pods away, and every device is a /dev path named once: fix Named devices below, " +
        'or the node.'
      );
    case 'NamedDevicesWithoutOSD':
      return (
        'Rook refused a named device: see the log of the rook-ceph-osd-prepare job of that node ' +
        '(Cairn, Hosts and OSDs). A logical volume must exist, be thick (not in a thin pool, as ' +
        "TopoLVM's are) and carry no signature: lvcreate -L <size> -n <lv> --wipesignatures y " +
        "--zero y <vg>. Once the device is fixed, Rook's next OSD preparation takes it."
      );
  }
  return undefined;
}

/** A tone for a condition view, for pills. */
export function viewTone(view: ConditionView): Tone {
  return view.severity === 'success'
    ? 'success'
    : view.severity === 'warning'
    ? 'warning'
    : view.severity === 'error'
    ? 'error'
    : 'info';
}
