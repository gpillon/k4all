/*
 * The cluster upgrade as the Upgrades page shows it, from the ClusterUpgrade
 * "k4all" (k4all-operator v0.4.0+):
 *
 * - releasePlan: the hops to a target, as the operator plans them
 *   (availableReleases[].path), with what each hop changes;
 * - upgradeView: one headline for the whole upgrade, the graph and the
 *   Failed condition;
 * - node order, drain timer, hop and node durations, reboot/downtime estimate;
 * - nodeGuidance: what to do about a node, by its machine-readable reason;
 * - the spec changes the page sends (start, pause, resume, stop, settings).
 */

import { ChangeItem } from './changes';
import { Tone } from './components';
import {
  BARE_PODS_DOC_URL,
  DocLink,
  drainBlockAdvice,
  DRAINS_NEVER_END_DOC_URL,
  parseDrainBlock,
} from './drainBlock';
import { clone } from './objects';
import { buildSpecPatch, JsonPatchOp } from './patch';
import { compareSemver, parseSemver, SemVer } from './semver';
import {
  ClusterUpgradeObject,
  ClusterUpgradeSpec,
  Condition,
  CONDITION_FAILED,
  CONDITION_GRAPH_AVAILABLE,
  CONDITION_SUCCEEDED,
  DEFAULT_UPGRADE_GRAPH_URL,
  DrainSpec,
  Hop,
  NODE_RELEASE_ANNOTATION,
  NODE_TYPE_ANNOTATION,
  NodeConfigObject,
  NodeLike,
  NodeUpgradeStatus,
  ReleaseInfo,
} from './types';

/** The CRD default of spec.drain.timeoutMinutes. */
export const DEFAULT_DRAIN_TIMEOUT_MINUTES = 30;

/**
 * Rough time of one node's hop, drain excluded: image download and staging,
 * kubeadm when Kubernetes changes, reboot, and the node getting Ready again.
 * Shown as an estimate only.
 */
export const HOP_MINUTES_PER_NODE: [number, number] = [5, 15];

// ------------------------------------------------------------------ Versions

/** "2.7.0" → "v2.7.0"; k4all releases are written with a leading v. */
export function normalizeRelease(version: string): string {
  const v = version.trim();
  return v.startsWith('v') ? v : `v${v}`;
}

function versionKey(version: string | undefined): SemVer | null {
  return version ? parseSemver(version) : null;
}

function cmp(a: SemVer, b: SemVer): number {
  return compareSemver(a, b);
}

function sameStream(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor;
}

/** A hop is a patch inside one X.Y stream, a minor otherwise (k4all-upgrade hop_kind). */
export function hopKind(from: string, to: string): 'minor' | 'patch' {
  const a = versionKey(from);
  const b = versionKey(to);
  return a && b && sameStream(a, b) ? 'patch' : 'minor';
}

/** The release kind from the graph, or else the kind of the hop from `from`. */
export function releaseKind(rel: ReleaseInfo, from?: string): 'minor' | 'patch' {
  if (rel.kind === 'minor' || rel.kind === 'patch') {
    return rel.kind;
  }
  if (from) {
    return hopKind(from, rel.version);
  }
  return versionKey(rel.version)?.patch === 0 ? 'minor' : 'patch';
}

// ------------------------------------------------------------------ Planning

/** What a release runs: Kubernetes, Fedora, CRI-O. */
export type ReleaseFacts = Pick<ReleaseInfo, 'kubernetes' | 'fedora' | 'crio'>;

export interface HopChange {
  what: 'Kubernetes' | 'Fedora' | 'CRI-O';
  from?: string;
  to: string;
}

export interface PlannedHop {
  from: string;
  release: ReleaseInfo;
  kind: 'minor' | 'patch';
  changes: HopChange[];
}

export interface Plan {
  hops: PlannedHop[];
  /** Set when the operator has no way to the target. */
  error?: string;
}

/**
 * The hops to target, exactly as the operator plans them
 * (status.availableReleases[target].path, from currentRelease), each with
 * what it changes, starting from status.currentReleaseInfo.
 */
export function releasePlan(cu: ClusterUpgradeObject, target: string): Plan {
  const status = cu.status ?? {};
  const current = status.currentRelease ?? '';
  const wanted = normalizeRelease(target);
  const available = status.availableReleases ?? [];
  const rel = available.find(r => normalizeRelease(r.version) === wanted);
  if (!rel) {
    return { hops: [], error: `${wanted} is not among the releases this cluster can move to.` };
  }
  const path = rel.path ?? [];
  if (path.length === 0) {
    return {
      hops: [],
      error: `The upgrade graph has no way from ${
        current || 'the current release'
      } to ${wanted}: a release on the way is blocked or missing.`,
    };
  }
  const byVersion = new Map(available.map(r => [normalizeRelease(r.version), r]));
  const hops: PlannedHop[] = [];
  let from = current;
  let prev: ReleaseFacts = status.currentReleaseInfo ?? {};
  for (const version of path) {
    const info = byVersion.get(normalizeRelease(version)) ?? { version };
    hops.push({
      from,
      release: info,
      kind: releaseKind(info, from),
      changes: hopChanges(prev, info),
    });
    prev = {
      kubernetes: info.kubernetes ?? prev.kubernetes,
      fedora: info.fedora ?? prev.fedora,
      crio: info.crio ?? prev.crio,
    };
    from = normalizeRelease(version);
  }
  return { hops };
}

function plain(v: string | undefined): string | undefined {
  return v ? v.replace(/^v/, '') : undefined;
}

/** What a hop changes on the nodes: Kubernetes, Fedora, CRI-O. */
export function hopChanges(prev: ReleaseFacts, next: ReleaseFacts): HopChange[] {
  const out: HopChange[] = [];
  const k8sFrom = plain(prev.kubernetes);
  const k8sTo = plain(next.kubernetes);
  if (k8sTo && k8sTo !== k8sFrom) {
    out.push({ what: 'Kubernetes', from: k8sFrom, to: k8sTo });
  }
  if (next.fedora && next.fedora !== prev.fedora) {
    out.push({
      what: 'Fedora',
      from: prev.fedora ? String(prev.fedora) : undefined,
      to: String(next.fedora),
    });
  }
  if (next.crio && next.crio !== prev.crio) {
    out.push({ what: 'CRI-O', from: prev.crio, to: next.crio });
  }
  return out;
}

/** True when a hop moves Kubernetes to another minor. */
export function changesKubernetesMinor(change: HopChange): boolean {
  if (change.what !== 'Kubernetes' || !change.from) {
    return false;
  }
  const a = parseSemver(change.from);
  const b = parseSemver(change.to);
  return !!a && !!b && (a.major !== b.major || a.minor !== b.minor);
}

// ------------------------------------------------------------------- Nodes

const ROLE_ORDER: Record<string, number> = { bootstrap: 0, control: 1, worker: 2 };

export interface OrderedNode {
  name: string;
  role: string;
  release?: string;
}

function roleOfNode(node: NodeLike, nodeConfigs: NodeConfigObject[]): string {
  const annotated = node.metadata.annotations?.[NODE_TYPE_ANNOTATION];
  if (annotated) {
    return annotated;
  }
  const nc = nodeConfigs.find(c => (c.status?.nodeName || c.metadata.name) === node.metadata.name);
  if (nc?.status?.nodeType) {
    return nc.status.nodeType;
  }
  return 'node-role.kubernetes.io/control-plane' in (node.metadata.labels ?? {})
    ? 'control'
    : 'worker';
}

/**
 * The order the operator upgrades the nodes in, one at a time: bootstrap,
 * control planes, workers. From the ClusterUpgrade status when it lists the
 * nodes, else from the cluster's Nodes.
 */
export function upgradeOrder(
  status: NodeUpgradeStatus[] | undefined,
  nodes: NodeLike[],
  nodeConfigs: NodeConfigObject[] = []
): OrderedNode[] {
  const list: OrderedNode[] =
    status && status.length > 0
      ? status.map(n => ({ name: n.name, role: n.role || 'worker', release: n.release }))
      : [...nodes]
          .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
          .map(n => ({
            name: n.metadata.name,
            role: roleOfNode(n, nodeConfigs),
            release: n.metadata.annotations?.[NODE_RELEASE_ANNOTATION],
          }));
  return list
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (ROLE_ORDER[a.n.role] ?? 3) - (ROLE_ORDER[b.n.role] ?? 3) || a.i - b.i)
    .map(({ n }) => n);
}

/** Display of a node's phase in the current hop. */
export const NODE_PHASE: Record<string, { label: string; tone: Tone; busy?: boolean }> = {
  Pending: { label: 'Waiting', tone: 'neutral' },
  Draining: { label: 'Draining', tone: 'info', busy: true },
  Upgrading: { label: 'Upgrading', tone: 'info', busy: true },
  Done: { label: 'Done', tone: 'success' },
  Failed: { label: 'Failed', tone: 'error' },
};

/** k4all-upgrade's phases of a hop (the node's upgrade-phase annotation). */
export const HOST_PHASES: Record<string, { label: string; detail: string }> = {
  PREFLIGHT: { label: 'Preflight', detail: 'Checking the node, the cluster and the disk space.' },
  BACKUP: { label: 'Backup', detail: 'Saving the node configuration and etcd.' },
  STAGE: { label: 'Staging', detail: 'Downloading the new image and staging it with bootc.' },
  PRE_REBOOT: {
    label: 'Kubernetes',
    detail: 'Running kubeadm upgrade with the new image before the reboot.',
  },
  DRAIN: { label: 'Drain', detail: 'Draining the node.' },
  REBOOT: { label: 'Rebooting', detail: 'Rebooting into the new image.' },
  SYNC: {
    label: 'Syncing',
    detail: 'Applying the release manifest to the cluster and waiting for the components.',
  },
  COMMIT: { label: 'Committing', detail: 'Recording the new release on the node.' },
  ROLLBACK_REBOOT: {
    label: 'Rolling back',
    detail: 'The new image did not come up; rebooting into the previous one.',
  },
  HOLD: { label: 'On hold', detail: 'The hop stopped and waits for you.' },
  ABANDONED: { label: 'Abandoned', detail: 'The hop was abandoned on the node.' },
};

export function hostPhaseLabel(phase: string | undefined): string | undefined {
  if (!phase) {
    return undefined;
  }
  return HOST_PHASES[phase]?.label ?? phase;
}

export interface DrainTimer {
  elapsedMs: number;
  timeoutMs: number;
  remainingMs: number;
  /** 0..1, capped. */
  fraction: number;
  overdue: boolean;
}

/** How long the node has been draining against spec.drain.timeoutMinutes. */
export function drainTimer(
  node: NodeUpgradeStatus,
  drain: DrainSpec | undefined,
  now: number
): DrainTimer | null {
  const started = node.drainStartedAt ? Date.parse(node.drainStartedAt) : NaN;
  if (Number.isNaN(started)) {
    return null;
  }
  const timeoutMs = (drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES) * 60000;
  const elapsedMs = Math.max(0, now - started);
  return {
    elapsedMs,
    timeoutMs,
    remainingMs: Math.max(0, timeoutMs - elapsedMs),
    fraction: Math.min(1, elapsedMs / timeoutMs),
    overdue: elapsedMs > timeoutMs,
  };
}

/** "4 min", "1 h 5 min", "30 s". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s} s`;
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m} min`;
  }
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

// ---------------------------------------------------------------- Estimate

export interface Estimate {
  hops: number;
  nodes: number;
  reboots: number;
  /** Rough total, drains excluded. */
  minutes: [number, number];
  singleNode: boolean;
  controlPlanes: number;
  drainTimeoutMinutes: number;
  continueOnTimeout: boolean;
  /** Plain sentences on what goes down and for how long. */
  notes: string[];
}

export function estimate(hops: number, order: OrderedNode[], drain?: DrainSpec): Estimate {
  const nodes = Math.max(order.length, 1);
  const reboots = hops * nodes;
  const singleNode = nodes === 1;
  const controlPlanes = order.filter(n => n.role === 'bootstrap' || n.role === 'control').length;
  const drainTimeoutMinutes = drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES;
  const continueOnTimeout = drain?.continueOnTimeout === true;
  const notes: string[] = [];
  if (singleNode) {
    notes.push(
      `The node is only cordoned, not drained: its pods have nowhere to go. Every workload, the Kubernetes API and this dashboard are down while it reboots, ${hops} time${
        hops === 1 ? '' : 's'
      }.`
    );
  } else {
    notes.push(
      'Pods move to the other nodes before each reboot; workloads with a single replica restart elsewhere and are briefly unavailable.'
    );
    if (controlPlanes === 1) {
      notes.push(
        'With one control-plane node, the Kubernetes API (and this dashboard) is unreachable while it reboots.'
      );
    } else if (controlPlanes === 2) {
      notes.push(
        'With two control-plane nodes, each control-plane reboot loses the etcd quorum: the Kubernetes API is unreachable meanwhile.'
      );
    }
  }
  return {
    hops,
    nodes,
    reboots,
    minutes: [reboots * HOP_MINUTES_PER_NODE[0], reboots * HOP_MINUTES_PER_NODE[1]],
    singleNode,
    controlPlanes,
    drainTimeoutMinutes,
    continueOnTimeout,
    notes,
  };
}

/** What happens when a node is drained, in words. */
export function drainBehaviour(
  e: Pick<Estimate, 'singleNode' | 'drainTimeoutMinutes' | 'continueOnTimeout'>
): string {
  if (e.singleNode) {
    return 'Single node: it is cordoned before its hop, not drained.';
  }
  return (
    `Before its hop each node is cordoned and drained: its pods are evicted, respecting PodDisruptionBudgets, for at most ${e.drainTimeoutMinutes} minutes. ` +
    (e.continueOnTimeout
      ? 'If the drain is not done by then, the hop runs anyway and the pods left on the node stop at its reboot.'
      : 'If the drain is not done by then, the node fails and the upgrade waits until you retry.')
  );
}

// -------------------------------------------------------------------- View

export type UpgradeStage =
  | 'waiting'
  | 'graphUnavailable'
  | 'upToDate'
  | 'available'
  | 'progressing'
  | 'pausing'
  | 'paused'
  | 'failed'
  | 'succeeded';

/** The upgrade graph as the operator last read it (condition GraphAvailable). */
export interface GraphState {
  /** null when the operator has not said (no condition yet). */
  available: boolean | null;
  /** The read error when not available. */
  error?: string;
  url?: string;
}

export interface UpgradeView {
  stage: UpgradeStage;
  tone: Tone;
  busy: boolean;
  label: string;
  current?: string;
  /** The graph's entry for the current release (Kubernetes, Fedora, CRI-O). */
  currentInfo?: ReleaseInfo;
  target?: string;
  /** Newest release the cluster can move to. */
  latest?: ReleaseInfo;
  available: ReleaseInfo[];
  path: Hop[];
  /** 1-based index of the hop in progress, 0 when none. */
  hopIndex: number;
  nodesDone: number;
  nodesTotal: number;
  /** 0..1 over all hops and nodes. */
  progress: number;
  /** The operator has not processed the latest spec yet. */
  stale: boolean;
  /** An upgrade is under way (progressing, pausing, paused or failed). */
  active: boolean;
  graph: GraphState;
  /** Reason of the Failed condition: a node reason, NoPath, Downgrade or NodeNotReported. */
  failedReason?: string;
  /** When the upgrade succeeded (Succeeded condition). */
  succeededAt?: string;
}

export function findUpgradeCondition(
  cu: ClusterUpgradeObject,
  type: string
): Condition | undefined {
  return (cu.status?.conditions ?? []).find(c => c.type === type);
}

export function sortedReleases(releases: ReleaseInfo[] | undefined): ReleaseInfo[] {
  return [...(releases ?? [])]
    .filter(r => versionKey(r.version))
    .sort((a, b) => cmp(versionKey(a.version)!, versionKey(b.version)!));
}

export function upgradeView(cu: ClusterUpgradeObject): UpgradeView {
  const status = cu.status ?? {};
  const spec = cu.spec ?? {};
  const available = sortedReleases(status.availableReleases);
  const path = status.path ?? [];
  const nodes = status.nodes ?? [];
  const hopIdx = path.findIndex(h => h.phase === 'InProgress');
  const hopsDone = path.filter(h => h.phase === 'Done').length;
  const nodesDone = hopIdx >= 0 ? nodes.filter(n => n.phase === 'Done').length : 0;
  const total = path.length * Math.max(nodes.length, 1);
  const done = hopsDone * Math.max(nodes.length, 1) + nodesDone;
  const generation = cu.metadata.generation;
  const observed = status.observedGeneration;
  const graphCond = findUpgradeCondition(cu, CONDITION_GRAPH_AVAILABLE);
  const failed = findUpgradeCondition(cu, CONDITION_FAILED);
  const succeeded = findUpgradeCondition(cu, CONDITION_SUCCEEDED);
  const base = {
    current: status.currentRelease || undefined,
    currentInfo: status.currentReleaseInfo,
    target: spec.targetRelease || undefined,
    latest: available[available.length - 1],
    available,
    path,
    hopIndex: hopIdx >= 0 ? hopIdx + 1 : 0,
    nodesDone,
    nodesTotal: nodes.length,
    progress: total > 0 ? Math.min(1, done / total) : 0,
    stale: generation !== undefined && observed !== undefined && observed < generation,
    graph: {
      available: graphCond ? graphCond.status === 'True' : null,
      error: graphCond?.status === 'False' ? graphCond.message : undefined,
      url: status.graphUrl || undefined,
    },
    failedReason: failed?.status === 'True' ? failed.reason : undefined,
    succeededAt: succeeded?.status === 'True' ? succeeded.lastTransitionTime : undefined,
  };
  const make = (stage: UpgradeStage, tone: Tone, label: string, busy = false): UpgradeView => ({
    ...base,
    stage,
    tone,
    label,
    busy,
    active: ['progressing', 'pausing', 'paused', 'failed'].includes(stage),
  });
  switch (status.phase) {
    case 'Progressing':
      if (!spec.paused) {
        return make('progressing', 'info', 'Upgrading', true);
      }
      // Paused with a node still mid-hop: it finishes first. Without one
      // (e.g. the graph cannot be read), nothing moves: paused.
      return nodes.some(n => n.phase === 'Draining' || n.phase === 'Upgrading')
        ? make('pausing', 'warning', 'Pausing', true)
        : make('paused', 'warning', 'Paused');
    case 'Paused':
      return make('paused', 'warning', 'Paused');
    case 'Failed':
      return make('failed', 'error', 'Needs attention');
    case 'Succeeded':
    case 'Idle':
      // An unreadable graph lists no release: not the same as up to date.
      if (base.graph.available === false) {
        return make('graphUnavailable', 'warning', 'Upgrade graph unreadable');
      }
      if (available.length) {
        return make(
          status.phase === 'Succeeded' ? 'succeeded' : 'available',
          'info',
          'Upgrade available'
        );
      }
      return make(status.phase === 'Succeeded' ? 'succeeded' : 'upToDate', 'success', 'Up to date');
  }
  return make('waiting', 'neutral', 'Waiting for k4all-operator', true);
}

/** What a Failed condition reason means when no node failed (the plan failed). */
export const PLAN_FAILURE: Record<string, string> = {
  NoPath:
    'The upgrade graph has no way from the current release to the target. Choose another target, or Stop.',
  Downgrade:
    'The target is older than the release the cluster runs. Choose a newer target, or Stop.',
  NodeNotReported:
    'A node has no release or node-type annotation, so k4all-upgrade v2.4.0 or later is not running there yet.',
};

// --------------------------------------------------------------- Durations

export interface Span {
  ms: number;
  /** Still running: measured up to now. */
  running: boolean;
}

/** completedAt - startedAt, or now - startedAt while running; null without a start. */
export function span(
  startedAt: string | undefined,
  completedAt: string | undefined,
  now: number
): Span | null {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isNaN(start)) {
    return null;
  }
  const end = completedAt ? Date.parse(completedAt) : NaN;
  return Number.isNaN(end)
    ? { ms: Math.max(0, now - start), running: true }
    : { ms: Math.max(0, end - start), running: false };
}

/** "took 9 min" / "running for 3 min". */
export function formatSpan(s: Span | null): string | undefined {
  if (!s) {
    return undefined;
  }
  return s.running ? `running for ${formatDuration(s.ms)}` : `took ${formatDuration(s.ms)}`;
}

// --------------------------------------------------------------- Guidance

export interface Command {
  command: string;
  /** Where to run it. */
  where: string;
}

export interface Guidance {
  node: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  text: string;
  commands: Command[];
  /** The retry annotation acts on this node (reason DrainTimeout or Abandoned). */
  retry: boolean;
  /** Sections of the k4all docs that explain it. */
  links?: DocLink[];
}

/** Node reasons the retry annotation acts on. */
export const RETRYABLE_REASONS = ['DrainTimeout', 'Abandoned'];

/**
 * What the user can do about a node, by the operator's machine-readable
 * reason (nodes[].reason) and the host phase. Never from message texts: the
 * message is only quoted. One exception, for want of a reason: a node the
 * operator does not cordon, or cannot finish draining, because of a budget
 * that allows no disruption or pods that declare no controller (operator
 * v0.5.8, k4all#87/#99), read from the shared drain's own phrases
 * (drainBlock.ts).
 */
export function nodeGuidance(node: NodeUpgradeStatus, spec: ClusterUpgradeSpec): Guidance | null {
  const onNode = `on ${node.name}`;
  const quoted = node.message ? ` k4all-upgrade says: "${node.message}"` : '';
  const holdCommands: Command[] = [
    { command: 'sudo k4all-upgrade status', where: onNode },
    { command: 'sudo k4all-upgrade clear-hold && sudo k4all-upgrade resume', where: onNode },
    { command: 'sudo k4all-upgrade clear-hold --abandon', where: onNode },
  ];
  switch (node.reason) {
    case 'HostHold':
      return {
        node: node.name,
        severity: 'warning',
        title: `${node.name} is on hold`,
        text:
          `The hop stopped on the node and waits for you.${quoted} ` +
          'Log in to the node, find the cause with the first command, fix it, then clear the hold: the node resumes the hop and the upgrade goes on by itself. ' +
          'To give up the hop instead and keep the node on its release, run the last command, then Retry or Stop here.',
        commands: holdCommands,
        retry: false,
      };
    case 'TargetRejected':
      return {
        node: node.name,
        severity: 'warning',
        title: `${node.name} refused the hop`,
        text:
          `k4all-upgrade on the node cannot plan this hop from its upgrade graph.${quoted} ` +
          'The ClusterUpgrade graph and the graph in /etc/k4all-upgrade.yaml on the node must be the same; the node tries again every minute, so fixing the graph is enough.',
        commands: [{ command: 'sudo k4all-upgrade plan', where: onNode }],
        retry: false,
      };
    case 'RollbackRebooted':
      return {
        node: node.name,
        severity: 'warning',
        title: `${node.name} rolled back`,
        text:
          `The new image did not come up, so the node rebooted into its previous image and holds the hop.${quoted} ` +
          'Find the cause with the first command; to try the hop again clear the hold and resume, or give it up with the last command, then Retry or Stop here.',
        commands: holdCommands,
        retry: false,
      };
    case 'Abandoned':
      return {
        node: node.name,
        severity: 'error',
        title: `The hop was abandoned on ${node.name}`,
        text:
          `The hop was given up on the node (or its request removed before it was done); the node stays on ${
            node.release ?? 'its release'
          }.${quoted} ` +
          'Retry drains the node again and asks it for the hop. Stop ends the upgrade with the nodes on different releases.',
        commands: [],
        retry: true,
      };
    case 'DrainTimeout': {
      const minutes = spec.drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES;
      return {
        node: node.name,
        severity: 'error',
        title: `Draining ${node.name} did not finish`,
        text:
          'A PodDisruptionBudget, a pod that cannot be evicted, or a pod that declares no controller ' +
          `(the drain never evicts those: delete them, or recreate them under a controller) held the drain back past the timeout.${
            node.message ? ` (${node.message})` : ''
          } ` +
          'Find the pods left on the node, move or delete them (or relax their PodDisruptionBudget), then Retry. ' +
          `Or turn on "continue when the drain times out" in the upgrade settings, then Retry. Retry drains again, for up to ${minutes} minutes.`,
        commands: [
          {
            command: `kubectl get pods -A -o wide --field-selector spec.nodeName=${node.name}`,
            where: 'with kubectl',
          },
          { command: 'kubectl get pdb -A', where: 'with kubectl' },
        ],
        retry: true,
        links: [
          { label: 'Drains that never end (docs/upgrades.md)', href: DRAINS_NEVER_END_DOC_URL },
          { label: 'Pods that declare no controller (docs/upgrades.md)', href: BARE_PODS_DOC_URL },
        ],
      };
    }
    case 'NodeNotReady':
      return {
        node: node.name,
        severity: 'info',
        title: `Waiting for ${node.name} to be Ready`,
        text: 'The next node starts once every node is Ready. Right after a reboot this takes a few minutes; if it lasts, look at the node.',
        commands: [{ command: `kubectl describe node ${node.name}`, where: 'with kubectl' }],
        retry: false,
      };
  }
  const block = node.phase !== 'Failed' ? parseDrainBlock(node.message) : null;
  if (block) {
    const advice = drainBlockAdvice(block, node.name);
    return {
      node: node.name,
      severity: advice.severity,
      title: advice.title,
      text: advice.text,
      commands: advice.commands,
      retry: false,
      links: advice.links,
    };
  }
  if (node.hostPhase === 'ROLLBACK_REBOOT') {
    return {
      node: node.name,
      severity: 'warning',
      title: `${node.name} is rolling back`,
      text: `The new image did not come up, so the node reboots into its previous image. It then holds the hop for you to look at.${quoted}`,
      commands: [{ command: 'sudo k4all-upgrade status', where: onNode }],
      retry: false,
    };
  }
  if (node.phase === 'Failed') {
    return {
      node: node.name,
      severity: 'error',
      title: `${node.name} failed`,
      text: `${node.message || 'The hop failed on this node.'} Check the node.`,
      commands: [{ command: 'sudo k4all-upgrade status', where: onNode }],
      retry: false,
    };
  }
  return null;
}

/**
 * Whether Retry does something: the operator runs again a node that failed
 * with reason DrainTimeout or Abandoned, and nothing else.
 */
export function canRetry(cu: ClusterUpgradeObject): boolean {
  return (cu.status?.nodes ?? []).some(
    n => n.phase === 'Failed' && RETRYABLE_REASONS.includes(n.reason ?? '')
  );
}

// ------------------------------------------------------------- Spec writes

export type UpgradeIntent =
  | { kind: 'start'; target: string; drain?: DrainSpec }
  | { kind: 'settings'; drain: DrainSpec; graphUrl: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' };

function setOrDrop<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined) {
  if (value === undefined || value === '' || value === false) {
    delete obj[key];
  } else {
    obj[key] = value;
  }
}

function withDrain(spec: ClusterUpgradeSpec, drain: DrainSpec): ClusterUpgradeSpec {
  const next: DrainSpec = { ...(spec.drain ?? {}) };
  if (drain.timeoutMinutes !== undefined) {
    next.timeoutMinutes = drain.timeoutMinutes;
  }
  if (drain.continueOnTimeout !== undefined) {
    setOrDrop(next, 'continueOnTimeout', drain.continueOnTimeout);
  }
  return { ...spec, drain: next };
}

/** The spec an intent asks for, from the stored one. Fields it does not touch are kept. */
export function desiredSpec(cu: ClusterUpgradeObject, intent: UpgradeIntent): ClusterUpgradeSpec {
  let spec: ClusterUpgradeSpec = clone(cu.spec ?? {});
  switch (intent.kind) {
    case 'start':
      spec.targetRelease = normalizeRelease(intent.target);
      delete spec.paused; // starting means going: a pause left from before is lifted
      if (intent.drain) {
        spec = withDrain(spec, intent.drain);
      }
      break;
    case 'settings':
      spec = withDrain(spec, intent.drain);
      setOrDrop(
        spec,
        'graphUrl',
        intent.graphUrl.trim() === DEFAULT_UPGRADE_GRAPH_URL ? '' : intent.graphUrl.trim()
      );
      break;
    case 'pause':
      spec.paused = true;
      break;
    case 'resume':
      delete spec.paused;
      break;
    case 'stop':
      delete spec.targetRelease;
      delete spec.paused;
      break;
  }
  return spec;
}

/** JSON Patch for an intent, guarded by the generation; empty when nothing changes. */
export function intentOps(cu: ClusterUpgradeObject, intent: UpgradeIntent): JsonPatchOp[] {
  return buildSpecPatch(cu, desiredSpec(cu, intent));
}

/** The spec changes an intent makes, in words, for the review. */
export function describeUpgradeChanges(
  before: ClusterUpgradeSpec,
  after: ClusterUpgradeSpec
): ChangeItem[] {
  const items: ChangeItem[] = [];
  if ((before.targetRelease ?? '') !== (after.targetRelease ?? '')) {
    items.push({
      key: 'spec.targetRelease',
      label: 'Target release',
      from: before.targetRelease || 'none',
      to: after.targetRelease || 'none',
      severity: after.targetRelease ? 'danger' : 'warning',
      consequence: after.targetRelease
        ? 'k4all-operator starts moving the nodes to this release, one node at a time. Every node reboots once per hop.'
        : 'The upgrade stops after the node in progress. Nodes already upgraded stay on their release.',
    });
  }
  if (!!before.paused !== !!after.paused) {
    items.push({
      key: 'spec.paused',
      label: 'Paused',
      from: before.paused ? 'yes' : 'no',
      to: after.paused ? 'yes' : 'no',
      severity: 'info',
      consequence: after.paused
        ? 'No new node starts its hop; a node already upgrading finishes it.'
        : 'The upgrade goes on with the next node.',
    });
  }
  const tBefore = before.drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES;
  const tAfter = after.drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES;
  if (tBefore !== tAfter) {
    items.push({
      key: 'spec.drain.timeoutMinutes',
      label: 'Drain timeout',
      from: `${tBefore} min`,
      to: `${tAfter} min`,
      severity: 'info',
    });
  }
  if (!!before.drain?.continueOnTimeout !== !!after.drain?.continueOnTimeout) {
    items.push({
      key: 'spec.drain.continueOnTimeout',
      label: 'Continue when the drain times out',
      from: before.drain?.continueOnTimeout ? 'yes' : 'no',
      to: after.drain?.continueOnTimeout ? 'yes' : 'no',
      severity: after.drain?.continueOnTimeout ? 'warning' : 'info',
      consequence: after.drain?.continueOnTimeout
        ? 'A node whose drain times out is upgraded anyway; the pods left on it stop at its reboot.'
        : 'A node whose drain times out fails and waits for a retry.',
    });
  }
  if ((before.graphUrl ?? '') !== (after.graphUrl ?? '')) {
    items.push({
      key: 'spec.graphUrl',
      label: 'Upgrade graph',
      from: before.graphUrl || 'k4all releases (default)',
      to: after.graphUrl || 'k4all releases (default)',
      severity: 'warning',
      consequence:
        'The path is planned on this graph. The nodes must read the same graph (graphUrl in /etc/k4all-upgrade.yaml), or they refuse the hops.',
    });
  }
  return items;
}
