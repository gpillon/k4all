/*
 * Node settings (spec.nodes, k4all v2.7.0 / operator v0.6.0): what a change
 * makes the nodes do, the plan the plugin shows before saving, the checks
 * against the nodes' capacity, and the rollout as status.nodes reports it.
 *
 * The operator rolls a change out one node at a time. The action class comes
 * from the fields that change (spec §6.1-6.2):
 *   restart       kubelet.maxPods only: kubelet restarts, no drain;
 *   drain-restart CPU manager, reserved CPUs, topology manager: drain, kubelet
 *                 restarts with a fresh CPU manager state;
 *   drain-reboot  hugepages, IOMMU (kernel arguments): drain, reboot.
 * A single node is only cordoned (nothing to move the pods to).
 */

import { findCondition, nodeRows } from './health';
import { getIn, jsonEqual, setPruned } from './objects';
import { compareSemver, parseSemver } from './semver';
import {
  ClusterConfigObject,
  ClusterConfigSpec,
  Condition,
  CONDITION_NODE_SETTINGS_ROLLOUT,
  NodeConfigObject,
  NodeLike,
  NodesConfig,
} from './types';
import type { Issue } from './validation';

// ------------------------------------------------------------- Quantities

const BINARY: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};
const DECIMAL: Record<string, number> = {
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/** A Kubernetes quantity ("16303412Ki", "8", "1500m") as a number; null if unparsable. */
export function parseQuantity(q: string | undefined): number | null {
  const m = q?.trim().match(/^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]{0,2})$/);
  if (!m) {
    return null;
  }
  const factor = BINARY[m[2]] ?? DECIMAL[m[2]];
  return factor === undefined ? null : Number(m[1]) * factor;
}

/** The CPU ids of a cpuset ("0-1,4"), sorted; null when it is not one. */
export function parseCpuSet(text: string | undefined): number[] | null {
  const parts = (text ?? '').split(',').map(p => p.trim());
  if (parts.length === 0 || parts.some(p => p === '')) {
    return null;
  }
  const ids = new Set<number>();
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) {
      return null;
    }
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (to < from) {
      return null;
    }
    for (let i = from; i <= to; i++) {
      ids.add(i);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

// ------------------------------------------------------------- Actions

export type NodeAction = 'restart' | 'drain-restart' | 'drain-reboot';

const RANK: Record<NodeAction, number> = { restart: 1, 'drain-restart': 2, 'drain-reboot': 3 };

/** The node-level fields of spec.nodes and the action a change of each one takes. */
export const NODE_FIELD_ACTION: Record<string, NodeAction> = {
  'kubelet.maxPods': 'restart',
  'kubelet.cpuManagerPolicy': 'drain-restart',
  'kubelet.reservedSystemCPUs': 'drain-restart',
  'kubelet.topologyManagerPolicy': 'drain-restart',
  'kubelet.topologyManagerScope': 'drain-restart',
  'hugepages.1Gi': 'drain-reboot',
  'hugepages.2Mi': 'drain-reboot',
  iommu: 'drain-reboot',
};

/** The node-level fields (dotted, below spec.nodes) that differ; rollout.paused is not one. */
export function changedNodeFields(
  base: NodesConfig | undefined,
  draft: NodesConfig | undefined
): string[] {
  const sizes = new Set([
    ...Object.keys(base?.hugepages ?? {}),
    ...Object.keys(draft?.hugepages ?? {}),
    '1Gi',
    '2Mi',
  ]);
  const fields = [
    'kubelet.maxPods',
    'kubelet.cpuManagerPolicy',
    'kubelet.reservedSystemCPUs',
    'kubelet.topologyManagerPolicy',
    'kubelet.topologyManagerScope',
    ...[...sizes].sort().map(s => `hugepages.${s}`),
    'iommu',
  ];
  return fields.filter(f => {
    const dot = f.indexOf('.');
    const path = dot < 0 ? [f] : [f.slice(0, dot), f.slice(dot + 1)];
    return !jsonEqual(getIn(base, path), getIn(draft, path));
  });
}

/** The strongest action of the changed fields; null when none. */
export function actionFor(fields: string[]): NodeAction | null {
  let best: NodeAction | null = null;
  for (const f of fields) {
    const a = NODE_FIELD_ACTION[f] ?? (f.startsWith('hugepages.') ? 'drain-reboot' : undefined);
    if (a && (!best || RANK[a] > RANK[best])) {
      best = a;
    }
  }
  return best;
}

export const ACTION_LABEL: Record<NodeAction, string> = {
  restart: 'kubelet restart, no drain',
  'drain-restart': 'drain, kubelet restart',
  'drain-reboot': 'drain, reboot',
};

// ------------------------------------------------------------- The plan

/** The first k4all release whose node agent applies node settings. */
export const NODE_SETTINGS_RELEASE = 'v2.7.0';

export interface PlanStep {
  node: string;
  role: string;
  ready: boolean;
  /** drain: evict with PodDisruptionBudgets; cordon: single node, nothing can move. */
  drain: 'none' | 'drain' | 'cordon';
  restart: 'kubelet' | 'reboot';
  /** The node's release has no node-settings agent: it gets the settings after its hop. */
  skipped: boolean;
  note?: string;
}

export interface RolloutPlan {
  action: NodeAction | null;
  fields: string[];
  steps: PlanStep[];
  singleNode: boolean;
  /** What happens, in words. */
  summary: string;
  /** What stops, in words. */
  downtime: string;
}

const SUMMARY: Record<NodeAction, string> = {
  restart: 'kubelet restarts on each node in turn, without a drain: running pods keep running.',
  'drain-restart':
    'Each node in turn is cordoned and drained (PodDisruptionBudgets respected), kubelet ' +
    'restarts with a fresh CPU manager state, then the node is uncordoned and the next one starts.',
  'drain-reboot':
    'Each node in turn is cordoned and drained (PodDisruptionBudgets respected), reboots with ' +
    'the new kernel arguments (a few minutes), then is uncordoned and the next one starts.',
};

function olderThan(release: string | undefined, than: string): boolean {
  const r = parseSemver(release);
  const t = parseSemver(than);
  return !!r && !!t && compareSemver(r, t) < 0;
}

/**
 * The plan of a change of spec.nodes, before it is saved: the action, and
 * the nodes in the order the operator goes (bootstrap, control planes,
 * workers, by name; the node running k4all-operator last, as with upgrades).
 */
export function rolloutPlan(input: {
  base: ClusterConfigSpec;
  draft: ClusterConfigSpec;
  nodes: NodeLike[];
  nodeConfigs?: NodeConfigObject[];
  /** The node k4all-operator's pod runs on, when known. */
  operatorNode?: string;
}): RolloutPlan {
  const fields = changedNodeFields(input.base.nodes, input.draft.nodes);
  const action = actionFor(fields);
  if (!action) {
    return { action, fields, steps: [], singleNode: false, summary: '', downtime: '' };
  }
  const rows = nodeRows(input.nodes, input.nodeConfigs ?? []);
  const singleNode = rows.length === 1;
  const ordered = [
    ...rows.filter(r => r.name !== input.operatorNode),
    ...rows.filter(r => r.name === input.operatorNode),
  ];
  const steps = ordered.map((r): PlanStep => {
    const skipped = olderThan(r.release, NODE_SETTINGS_RELEASE);
    const notes: string[] = [];
    if (skipped) {
      notes.push(
        `Runs ${r.release}: it gets the settings after its ${NODE_SETTINGS_RELEASE} upgrade.`
      );
    }
    if (r.name === input.operatorNode && !singleNode) {
      notes.push('Last: it runs k4all-operator, which moves to another node first.');
    }
    if (!r.ready) {
      notes.push('Not Ready: the rollout waits for it.');
    }
    return {
      node: r.name,
      role: r.role,
      ready: r.ready,
      drain: action === 'restart' ? 'none' : singleNode ? 'cordon' : 'drain',
      restart: action === 'drain-reboot' ? 'reboot' : 'kubelet',
      skipped,
      note: notes.length ? notes.join(' ') : undefined,
    };
  });
  let downtime: string;
  if (action === 'restart') {
    downtime = 'Nothing stops: a kubelet restart leaves the containers running.';
  } else if (singleNode) {
    downtime =
      action === 'drain-reboot'
        ? 'Single node: it is only cordoned, and the workloads stop while it reboots, this dashboard and the API server included.'
        : 'Single node: it is only cordoned (there is no other node), and workloads stop while kubelet restarts with the new CPU settings.';
  } else {
    downtime =
      'Pods move to other nodes during each drain; workloads without a second replica are down while their node ' +
      (action === 'drain-reboot' ? 'drains and reboots.' : 'drains.');
  }
  return { action, fields, steps, singleNode, summary: SUMMARY[action], downtime };
}

// ----------------------------------------------------------- Capacity

export const HUGEPAGE_WARN_PERCENT = 50;
export const HUGEPAGE_REFUSE_PERCENT = 80;

const HUGEPAGE_BYTES: Record<string, number> = { '1Gi': 2 ** 30, '2Mi': 2 ** 21 };

export interface HugepageNode {
  node: string;
  memoryBytes: number | null;
  hugepageBytes: number;
  percent: number | null;
  level: 'ok' | 'warning' | 'error' | 'unknown';
}

/** Memory the hugepages take per node: from capacity.memory, warning above 50 %, refused above 80 %. */
export function hugepageMath(
  hugepages: NodesConfig['hugepages'] | undefined,
  nodes: NodeLike[]
): HugepageNode[] {
  const bytes = Object.entries(hugepages ?? {}).reduce(
    (sum, [size, count]) => sum + (HUGEPAGE_BYTES[size] ?? 0) * Math.max(0, Number(count) || 0),
    0
  );
  return nodes.map(n => {
    const memory = parseQuantity(n.status?.capacity?.memory);
    if (memory === null || memory <= 0) {
      return {
        node: n.metadata.name,
        memoryBytes: null,
        hugepageBytes: bytes,
        percent: null,
        level: 'unknown',
      };
    }
    const percent = (bytes / memory) * 100;
    return {
      node: n.metadata.name,
      memoryBytes: memory,
      hugepageBytes: bytes,
      percent,
      level:
        percent > HUGEPAGE_REFUSE_PERCENT
          ? 'error'
          : percent > HUGEPAGE_WARN_PERCENT
          ? 'warning'
          : 'ok',
    };
  });
}

/** Logical CPUs of a node (capacity.cpu); null when unknown. */
export function nodeCpus(node: NodeLike): number | null {
  const cpus = parseQuantity(node.status?.capacity?.cpu);
  return cpus === null ? null : Math.floor(cpus);
}

function fmtPercent(p: number): string {
  return `${Math.round(p * 10) / 10} %`;
}

/** Checks of spec.nodes against the CRD and the nodes; errors block saving. */
export function nodeSettingsIssues(spec: ClusterConfigSpec, ctx: { nodes: NodeLike[] }): Issue[] {
  const issues: Issue[] = [];
  const add = (field: string, severity: Issue['severity'], message: string) =>
    issues.push({ field, severity, message });
  const kubelet = spec.nodes?.kubelet ?? {};

  if (kubelet.maxPods !== undefined) {
    const n = kubelet.maxPods;
    if (!Number.isInteger(n) || n < 10 || n > 1000) {
      add('maxPods', 'error', 'Max pods is 10 to 1000.');
    } else if (spec.networking?.cni?.type === 'cilium' && n > 250) {
      add('maxPods', 'error', 'Cilium gives each node a /24 of pod addresses: at most 250 pods.');
    }
  }

  const reserved = kubelet.reservedSystemCPUs;
  if (kubelet.cpuManagerPolicy === 'static' && !reserved) {
    add('reservedSystemCPUs', 'error', 'The static CPU manager needs reserved CPUs.');
  }
  if (reserved) {
    const ids = parseCpuSet(reserved);
    if (!ids) {
      add('reservedSystemCPUs', 'error', `"${reserved}" is not a CPU list such as 0-1 or 0,2.`);
    } else {
      for (const n of ctx.nodes) {
        const cpus = nodeCpus(n);
        if (cpus === null) {
          continue;
        }
        const missing = ids.filter(id => id >= cpus);
        if (missing.length) {
          add(
            'reservedSystemCPUs',
            'error',
            `${n.metadata.name} has ${cpus} CPUs (0-${cpus - 1}): CPUs ${missing.join(
              ', '
            )} do not exist there.`
          );
        } else if (ids.length >= cpus) {
          add(
            'reservedSystemCPUs',
            'error',
            `${n.metadata.name} has ${cpus} CPUs: reserving all of them leaves none for pods.`
          );
        }
      }
    }
  }

  if (
    kubelet.topologyManagerPolicy &&
    kubelet.topologyManagerPolicy !== 'none' &&
    kubelet.cpuManagerPolicy !== 'static'
  ) {
    add(
      'topologyManagerPolicy',
      'info',
      'Without the static CPU manager the topology manager only aligns devices (and hugepages), not CPUs.'
    );
  }

  const hugepages = spec.nodes?.hugepages;
  if (hugepages) {
    if (Object.values(hugepages).some(c => !Number.isInteger(c) || (c as number) < 0)) {
      add('hugepages', 'error', 'Hugepage counts are whole numbers, 0 or more.');
    } else {
      const worst = hugepageMath(hugepages, ctx.nodes)
        .filter(r => r.percent !== null)
        .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
      if (worst?.level === 'error') {
        add(
          'hugepages',
          'error',
          `Hugepages take ${fmtPercent(worst.percent!)} of the memory of ${
            worst.node
          }: k4all-operator refuses more than ${HUGEPAGE_REFUSE_PERCENT} %.`
        );
      } else if (worst?.level === 'warning') {
        add(
          'hugepages',
          'warning',
          `Hugepages take ${fmtPercent(worst.percent!)} of the memory of ${
            worst.node
          }: keep them at ${HUGEPAGE_WARN_PERCENT} % or less, or pods run short of memory.`
        );
      }
    }
  }
  return issues;
}

// ------------------------------------------------------------- The rollout

export interface RolloutNodeRow {
  name: string;
  phase?: string;
  message?: string;
  /** The node reported the current settings hash applied. */
  applied: boolean;
  current: boolean;
}

export interface RolloutView {
  phase: string;
  currentNode?: string;
  message?: string;
  /** spec.nodes.rollout.paused. */
  paused: boolean;
  /** The operator has not processed the latest spec yet. */
  stale: boolean;
  done: number;
  total: number;
  nodes: RolloutNodeRow[];
  condition?: Condition;
}

/** The rollout of spec.nodes, from status.nodes and the NodeSettingsRollout condition. */
export function rolloutView(cc: ClusterConfigObject): RolloutView {
  const status = cc.status?.nodes;
  const hash = status?.settingsHash;
  const current = status?.rollout?.currentNode;
  const nodes = (status?.perNode ?? []).map(n => ({
    name: n.name,
    phase: n.phase,
    message: n.message,
    applied: !!hash && n.appliedHash === hash,
    current: n.name === current,
  }));
  const generation = cc.metadata.generation;
  const observed = cc.status?.observedGeneration;
  return {
    phase: status?.rollout?.phase || 'Idle',
    currentNode: current || undefined,
    message: status?.rollout?.message || undefined,
    paused: cc.spec?.nodes?.rollout?.paused === true,
    stale: generation !== undefined && observed !== undefined && observed < generation,
    done: nodes.filter(n => n.applied).length,
    total: nodes.length,
    nodes,
    condition: findCondition(cc.status?.conditions, CONDITION_NODE_SETTINGS_ROLLOUT),
  };
}

/** The spec with spec.nodes.rollout.paused set (true) or removed (false), no empty object left. */
export function withRolloutPaused(spec: ClusterConfigSpec, paused: boolean): ClusterConfigSpec {
  return setPruned(spec, ['nodes', 'rollout', 'paused'], paused ? true : undefined);
}
