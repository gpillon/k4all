/*
 * Upgrade readiness and remediations (k4all-operator v0.7.0) as the pages
 * show them, read from the structured fields only (messages are quoted,
 * never parsed):
 *
 * - REMEDIATION_CATALOG: the catalog of operator v0.7.0, as a table. The
 *   operator publishes none, and the addon is pinned per release with it;
 * - FINDING_KINDS: a label and short advice per finding kind of the seed
 *   set, with commands for the common ones; findingAdvice falls back to the
 *   severity, kind and message for a kind it does not know;
 * - the answers a person gives (approvals): which option an Accept is
 *   written for, which answers exist already, the pre-approve selection and
 *   its merge into spec.approvals, and the JSON Patch that adds one answer;
 * - readinessView: the report's headline, check time and node cards; where
 *   Headlamp's pod runs, since the page goes away while it moves.
 *
 * ClusterUpgrade approvals are bound to a release, the node-settings
 * rollout's to a settings hash (ClusterConfig spec.nodes.rollout.approvals):
 * the helpers take the binding as a parameter.
 */

import { BARE_PODS_DOC_URL, DocLink, DRAINS_NEVER_END_DOC_URL } from './drainBlock';
import { clone, getIn, isPlainObject, Path, setIn, setPruned, toPointer } from './objects';
import { diffToOps, JsonPatchOp, precondition, Versioned } from './patch';
import {
  ApprovalDecision,
  ClusterConfigSpec,
  Finding,
  NodeReadiness,
  ObjectRef,
  ReadinessReport,
  RemediationApproval,
  RemediationMode,
  RemediationOption,
} from './types';
import type { Command } from './upgrades';

// ------------------------------------------------------------------ Catalog

export interface CatalogEntry {
  id: string;
  /** A short name. */
  title: string;
  /** What it does, and how k4all puts it back. */
  does: string;
  /** The risk as the catalog states it. */
  risk: 'None' | 'Downtime' | 'Disruption' | 'BuiltIn';
  /** The risk spelled out. */
  riskText: string;
  /** auto may be chosen. */
  autoAllowed: boolean;
  /** Why auto is not allowed, when it is not. */
  autoRefusal?: string;
  /** false: built in, it has no mode (ceph-wait-health). */
  hasMode: boolean;
  /** The finding kinds it is offered for. */
  forKinds: string[];
}

/** The remediations of k4all-operator v0.7.0 (gpillon/k4all-operator#60), in offer order. */
export const REMEDIATION_CATALOG: CatalogEntry[] = [
  {
    id: 'cnpg-disable-pdb',
    title: 'CloudNativePG: no budget for the hop',
    does:
      'Sets enablePDB: false on the CloudNativePG Cluster: CNPG deletes its PodDisruptionBudgets and the ' +
      'drain evicts the primary. Put back: enablePDB as it was; CNPG recreates the budgets.',
    risk: 'Downtime',
    riskText:
      'The database is down until its pod runs again: seconds on network storage, the whole reboot on a volume bound to the node.',
    autoAllowed: true,
    hasMode: true,
    forKinds: ['CNPGSingleInstance'],
  },
  {
    id: 'cnpg-maintenance-window',
    title: 'CloudNativePG: maintenance window',
    does:
      'Sets nodeMaintenanceWindow {inProgress: true, reusePVC: true}: CNPG drops the primary budget and its ' +
      'self-healing, and the pod waits for its node and volume. Put back: inProgress as it was.',
    risk: 'Downtime',
    riskText: 'The database is down until the node is back, on network storage too.',
    autoAllowed: true,
    hasMode: true,
    forKinds: ['CNPGSingleInstance'],
  },
  {
    id: 'cnpg-add-replica',
    title: 'CloudNativePG: a replica first',
    does:
      'Sets instances: 2 before the drain; once a replica is Ready on another node, CNPG switches over at ' +
      'the cordon. Put back: instances 1 after the node is back (CNPG removes the newest instance).',
    risk: 'None',
    riskText:
      'None, but it needs room for a second volume, and the replica takes time to catch up.',
    autoAllowed: false,
    autoRefusal: 'it creates a volume and reshapes the database cluster',
    hasMode: true,
    forKinds: ['CNPGSingleInstance'],
  },
  {
    id: 'vm-migrate-first',
    title: 'Move the VM live first',
    does: 'Migrates the VM live to another node before the drain. Nothing to put back: the VM stays where it went.',
    risk: 'None',
    riskText: 'None: the guest keeps running.',
    autoAllowed: true,
    hasMode: true,
    forKinds: ['VMShutdown'],
  },
  {
    id: 'vm-stop-start',
    title: 'Stop the VM cleanly, start it after',
    does:
      'Stops the VM cleanly (runStrategy Halted, with its own grace period) before the drain, and starts it ' +
      'after the hop, on its own node with its disks and devices.',
    risk: 'Downtime',
    riskText: 'The VM is off from before the drain until its node is done.',
    autoAllowed: true,
    hasMode: true,
    forKinds: ['VMShutdown', 'VMNotMigratable', 'SingleNodeShortStop'],
  },
  {
    id: 'pdb-scale-up',
    title: 'One replica more',
    does:
      'Adds a replica (spec.replicas + 1) when one fits on another node and nothing (an HPA, GitOps, an ' +
      'operator) owns the replica count. Put back: the saved count.',
    risk: 'None',
    riskText: 'None: one more pod runs during the hop.',
    autoAllowed: false,
    autoRefusal: "it changes a workload's size",
    hasMode: true,
    forKinds: ['PDBNeverAllows'],
  },
  {
    id: 'pdb-relax-for-node',
    title: "Relax the budget for the node's hop",
    does:
      "Sets the PodDisruptionBudget's maxUnavailable to its pods on this node, for this node's hop; never " +
      'deletes it, never on a budget with an owner. Put back: its saved spec.',
    risk: 'Downtime',
    riskText: "The budget's guarantee is off for the hop: its pods on the node go down together.",
    autoAllowed: false,
    autoRefusal: 'it turns a guarantee off',
    hasMode: true,
    forKinds: ['PDBNeverAllows', 'PDBExhausted'],
  },
  {
    id: 'acknowledge',
    title: 'Go on',
    does:
      'Changes nothing: the answer lets the drain go on and the disruption happens as reported. On pods that ' +
      'declare no controller, the drain deletes them.',
    risk: 'Disruption',
    riskText: 'The disruption as reported.',
    autoAllowed: false,
    autoRefusal: 'it is an answer, given per object',
    hasMode: true,
    forKinds: ['BarePod', 'NodeBoundVolume', 'PinnedToNode', 'NoRoomElsewhere'],
  },
  {
    id: 'ceph-wait-health',
    title: 'Wait for Ceph to be healthy',
    does: 'k4all drains no node while Ceph is not HEALTH_OK (warnings that a reboot cannot make worse aside), and never forces it.',
    risk: 'BuiltIn',
    riskText: 'Built in: none.',
    autoAllowed: false,
    autoRefusal: 'it is built in',
    hasMode: false,
    forKinds: ['CephNotHealthy'],
  },
];

export const ACKNOWLEDGE = 'acknowledge';

export function catalogEntry(id: string): CatalogEntry | undefined {
  return REMEDIATION_CATALOG.find(e => e.id === id);
}

/** The catalog's short name of a remediation, or its id. */
export function remediationTitle(id: string): string {
  return catalogEntry(id)?.title ?? id;
}

/** Modes in the order the settings offer them. */
export const MODES: RemediationMode[] = ['auto', 'ask', 'off'];

export const MODE_TEXT: Record<RemediationMode, string> = {
  auto: 'auto: k4all does it by itself',
  ask: 'ask: k4all does it once you approve it for the object',
  off: 'off: reported only',
};

/** The default of every entry of the catalog: left out means ask. */
export const DEFAULT_MODE: RemediationMode = 'ask';

/**
 * The spec with the mode of one remediation: ask (the default) removes the
 * entry, and the objects it leaves empty, so the spec only says what differs.
 */
export function withRemediationMode(
  spec: ClusterConfigSpec,
  id: string,
  mode: RemediationMode
): ClusterConfigSpec {
  return setPruned(
    spec,
    ['upgrades', 'remediations', id],
    mode === DEFAULT_MODE ? undefined : mode
  );
}

export interface ModeRow {
  id: string;
  entry?: CatalogEntry;
  /** As in the spec; undefined: left out (ask). */
  mode?: string;
  /** auto on an entry that does not allow it: the operator reads it as ask. */
  autoRefused: boolean;
}

/** The catalog with the modes of the spec, then the ids of the spec the catalog does not know. */
export function modeRows(spec: ClusterConfigSpec | undefined): ModeRow[] {
  const set = spec?.upgrades?.remediations ?? {};
  const rows: ModeRow[] = REMEDIATION_CATALOG.map(entry => ({
    id: entry.id,
    entry,
    mode: set[entry.id],
    autoRefused: set[entry.id] === 'auto' && !entry.autoAllowed,
  }));
  for (const id of Object.keys(set).sort()) {
    if (!catalogEntry(id)) {
      rows.push({ id, mode: set[id], autoRefused: false });
    }
  }
  return rows;
}

// -------------------------------------------------------------- Objects

/** "VirtualMachine lab/gpu-01", "Node w-1". */
export function refText(ref: ObjectRef): string {
  return `${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ''}${ref.name}`;
}

export function refKey(ref: ObjectRef): string {
  return [ref.group ?? '', ref.kind, ref.namespace ?? '', ref.name].join('/');
}

export function sameRef(a: ObjectRef, b: ObjectRef): boolean {
  return refKey(a) === refKey(b);
}

/** The kubectl resource of a reference: "pod", "virtualmachine.kubevirt.io". */
export function kubectlResource(ref: ObjectRef): string {
  const kind = ref.kind.toLowerCase();
  return ref.group ? `${kind}.${ref.group}` : kind;
}

function kubectlGet(ref: ObjectRef, extra = '-o yaml'): Command {
  const ns = ref.namespace ? ` -n ${ref.namespace}` : '';
  return {
    command: `kubectl get${ns} ${kubectlResource(ref)} ${ref.name}${extra ? ` ${extra}` : ''}`,
    where: 'with kubectl',
  };
}

// --------------------------------------------------------- Finding kinds

export const SEVERITY_ORDER: Record<string, number> = { Blocks: 0, Disrupts: 1, Info: 2 };

export const SEVERITY_TEXT: Record<string, string> = {
  Blocks: 'stops the drain',
  Disrupts: 'disrupts',
  Info: 'to know',
};

/** Blocks first, then Disrupts, then Info; the operator's order within each. */
export function sortFindings(findings: Finding[] | undefined): Finding[] {
  return (findings ?? [])
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.f.severity] ?? 3) - (SEVERITY_ORDER[b.f.severity] ?? 3) || a.i - b.i
    )
    .map(({ f }) => f);
}

export interface KindInfo {
  label: string;
  /** What it means and what to do, in a sentence or two. */
  advice: string;
  commands?: (f: Finding, node?: string) => Command[];
  links?: DocLink[];
}

const DRAINS_NEVER_END: DocLink = {
  label: 'Drains that never end (docs/upgrades.md)',
  href: DRAINS_NEVER_END_DOC_URL,
};
const BARE_PODS: DocLink = {
  label: 'Pods that declare no controller (docs/upgrades.md)',
  href: BARE_PODS_DOC_URL,
};

function podsOn(node?: string): Command[] {
  return node
    ? [
        {
          command: `kubectl get pods -A -o wide --field-selector spec.nodeName=${node}`,
          where: 'with kubectl',
        },
      ]
    : [];
}

/** The finding kinds of the seed set (gpillon/k4all-operator#58), by kind. */
export const FINDING_KINDS: Record<string, KindInfo> = {
  PDBNeverAllows: {
    label: 'Budget that never allows',
    advice:
      'A PodDisruptionBudget allows no disruption although every pod it expects is healthy: waiting changes nothing. ' +
      'Approve a fix, or relax the budget or move the workload yourself.',
    commands: f => [kubectlGet(f.object)],
    links: [DRAINS_NEVER_END],
  },
  CNPGSingleInstance: {
    label: 'Single-instance CloudNativePG',
    advice:
      "A CloudNativePG cluster with one instance: its primary's budget never lets the drain evict it. Approve one " +
      'of its fixes, or patch the cluster yourself for the hop.',
    commands: f => [kubectlGet(f.object)],
    links: [DRAINS_NEVER_END],
  },
  PDBExhausted: {
    label: 'Budget runs out on this node',
    advice:
      'More pods of a budget are on this node than it lets go, and one of them can only come back here (a volume ' +
      'bound to the node, or pinned): after the first evictions the rest wait for ever.',
    commands: f => [kubectlGet(f.object)],
    links: [DRAINS_NEVER_END],
  },
  PDBSequential: {
    label: 'Pods leave one by one',
    advice:
      'More pods of a budget are here than it lets go at once; they can run elsewhere, so the drain is only slower.',
  },
  VMNotMigratable: {
    label: 'VM that cannot move live',
    advice:
      'The VM asks to be moved live (evictionStrategy LiveMigrate or External) but cannot be: KubeVirt refuses its ' +
      'eviction for ever. Stop it cleanly for the hop, or fix what keeps it from migrating.',
    commands: f => [kubectlGet({ ...f.object, kind: 'VirtualMachineInstance' })],
  },
  VMShutdown: {
    label: 'VM shuts down',
    advice:
      'The drain shuts the guest down (evictionStrategy None, or it cannot move live). The message says where it ' +
      'starts again.',
  },
  VMLiveMigrates: {
    label: 'VM moves live',
    advice: 'KubeVirt migrates it live to another node: the guest keeps running.',
  },
  NodeBoundVolume: {
    label: 'Volume bound to this node',
    advice:
      "Its volume exists only on this node (TopoLVM, a local volume): the pod's replacement waits until the node is back.",
  },
  PinnedToNode: {
    label: 'Pinned to this node',
    advice:
      'Its node selector or affinity admits only this node: it is down until the node is back.',
  },
  NoRoomElsewhere: {
    label: 'No room elsewhere',
    advice:
      'Every replica runs here and no other node fits its requests: it is down until the node is back.',
  },
  BarePod: {
    label: 'Pod that declares no controller',
    advice:
      'Nothing recreates it after the drain, so the drain would delete it for good. Go on to let the drain ' +
      'delete it, or delete it, or recreate it under a controller (a Deployment, a StatefulSet, a Job) yourself.',
    commands: f =>
      f.object.kind === 'Pod'
        ? [
            {
              command: `kubectl delete pod -n ${f.object.namespace || 'default'} ${f.object.name}`,
              where: 'with kubectl',
            },
          ]
        : [],
    links: [BARE_PODS],
  },
  Capacity: {
    label: 'Room on the other nodes',
    advice:
      'What moves off this node, against what the other schedulable nodes have free (CPU, memory, devices). ' +
      'Short: some pods stay Pending until the node is back.',
  },
  AllReplicasHere: {
    label: 'All replicas here',
    advice:
      'Every replica of the workload runs here, with no budget: it is down while it restarts elsewhere.',
  },
  EmptyDir: {
    label: 'emptyDir data',
    advice: 'emptyDir volumes are lost with the eviction.',
  },
  StopsAtReboot: {
    label: 'Stops at the reboot',
    advice: 'DaemonSet and static pods stay on the node and stop at its reboot.',
  },
  SingleNodeShortStop: {
    label: 'Stops with the single node',
    advice:
      'A single node is not drained: every pod, VMs included, stops at the reboot with its grace period, at most ' +
      'podStopMaxSeconds (300 s by default).',
  },
  OperatorHere: {
    label: 'k4all-operator runs here',
    advice: 'The node goes last in its role, and the operator moves itself off it last.',
  },
  CephNotHealthy: {
    label: 'Ceph not healthy',
    advice:
      'Ceph is not HEALTH_OK (warnings a reboot cannot make worse aside): no node is drained until it is, and ' +
      'it is never forced.',
    commands: f => [kubectlGet(f.object, "-o jsonpath='{.status.ceph}'")],
  },
  CephHealthy: {
    label: 'Ceph healthy',
    advice: 'Ceph is HEALTH_OK, or has only warnings a reboot cannot make worse.',
  },
  CephDaemonsHere: {
    label: 'Ceph daemons here',
    advice:
      "Ceph's mons, OSDs, mgr or MDS on this node stop until it is back; Ceph runs degraded meanwhile.",
  },
  CephBelowMinSize: {
    label: 'Ceph pool below min_size',
    advice: 'A pool cannot keep its min_size with this node down: its I/O stops for the reboot.',
  },
  CephNoRedundancy: {
    label: 'Ceph without redundancy',
    advice: 'A pool of size 1, or too few OSD hosts: its I/O stops for the reboot.',
  },
  NodeNotReady: {
    label: 'Node not Ready',
    advice: 'A node is not Ready: the upgrade waits for it.',
    commands: f => [{ command: `kubectl describe node ${f.object.name}`, where: 'with kubectl' }],
  },
  PDBShort: {
    label: 'Budget short of pods',
    advice:
      'A budget lacks healthy pods (they are starting): the next node waits for them, up to the settle time.',
  },
  EvictionRefused: {
    label: 'Eviction refused',
    advice:
      'An eviction of the running drain was refused (a budget, or a webhook): the drain keeps trying, up to its ' +
      'timeout.',
    commands: (_f, node) => [
      ...podsOn(node),
      { command: 'kubectl get pdb -A', where: 'with kubectl' },
    ],
    links: [DRAINS_NEVER_END],
  },
  RemediationFailed: {
    label: 'A fix failed',
    advice:
      "A remediation's change or its readiness check failed, and k4all put back what it set. The message says why.",
    commands: f => [kubectlGet(f.object)],
  },
};

export interface FindingAdvice {
  label: string;
  /** A kind this addon does not know: only its severity, kind and message. */
  unknown: boolean;
  advice?: string;
  commands: Command[];
  links: DocLink[];
}

/** A label and what to do for a finding; an unknown kind shows its severity, kind and message. */
export function findingAdvice(f: Finding, node?: string): FindingAdvice {
  const info = FINDING_KINDS[f.kind];
  if (!info) {
    return { label: f.kind, unknown: true, commands: [], links: [] };
  }
  return {
    label: info.label,
    unknown: false,
    advice: info.advice,
    commands: info.commands?.(f, node) ?? [],
    links: info.links ?? [],
  };
}

// ---------------------------------------------------------------- Answers

/** What an approval is bound to: a ClusterUpgrade's release, or the rollout's settings hash. */
export type Binding = { release: string } | { settingsHash: string };

/** An approval of either kind. */
export interface AnyApproval {
  remediation: string;
  target: ObjectRef;
  node?: string;
  decision?: ApprovalDecision | string;
  release?: string;
  settingsHash?: string;
}

/** Apply, also when the decision is left out (the operator reads it so). */
export function effectiveDecision(a: AnyApproval): ApprovalDecision {
  return a.decision === 'Accept' ? 'Accept' : 'Apply';
}

function bound(a: AnyApproval, b: Binding): boolean {
  return 'release' in b ? a.release === b.release : a.settingsHash === b.settingsHash;
}

export function approvalKey(a: AnyApproval): string {
  return [
    a.remediation,
    refKey(a.target),
    a.node ?? '',
    effectiveDecision(a),
    a.release ?? '',
    a.settingsHash ?? '',
  ].join('|');
}

/** One answer to a finding of one node. */
export interface Answer {
  remediation: string;
  target: ObjectRef;
  decision: ApprovalDecision;
  /** Accept is written for the node's drain only; Apply for every node of the operation. */
  node?: string;
}

/** The answer as an approval with its binding. */
export function toApproval(answer: Answer, binding: Binding): AnyApproval {
  const a: AnyApproval = {
    remediation: answer.remediation,
    target: clone(answer.target),
    decision: answer.decision,
    ...binding,
  };
  if (answer.node) {
    a.node = answer.node;
  }
  return a;
}

export function applyAnswer(option: RemediationOption): Answer {
  return { remediation: option.remediation, target: option.target, decision: 'Apply' };
}

export interface FindingChoices {
  /** Options in mode auto: k4all applies them by itself. */
  auto: RemediationOption[];
  /** Options a person may approve (mode ask). */
  fixes: RemediationOption[];
  /** Options in mode off: reported only. */
  off: RemediationOption[];
  /** The option an Accept is written for: acknowledge when offered, else the first. */
  accept?: RemediationOption;
}

/** How a finding's options can be answered. */
export function findingChoices(f: Finding): FindingChoices {
  const options = f.remediations ?? [];
  const choices: FindingChoices = { auto: [], fixes: [], off: [] };
  for (const o of options) {
    if (o.remediation === ACKNOWLEDGE) {
      continue;
    }
    if (o.mode === 'auto') {
      choices.auto.push(o);
    } else if (o.mode === 'off') {
      choices.off.push(o);
    } else {
      choices.fixes.push(o);
    }
  }
  if (f.severity !== 'Info') {
    choices.accept = options.find(o => o.remediation === ACKNOWLEDGE) ?? options[0];
  }
  return choices;
}

export function acceptAnswer(f: Finding, node: string): Answer | null {
  const o = findingChoices(f).accept;
  return o ? { remediation: o.remediation, target: o.target, decision: 'Accept', node } : null;
}

/** The existing approval that answers this option on node: same remediation and target, for node or every node. */
export function existingApproval<T extends AnyApproval>(
  approvals: T[] | undefined,
  option: Pick<RemediationOption, 'remediation' | 'target'>,
  binding: Binding,
  node: string,
  decision?: ApprovalDecision
): T | undefined {
  return (approvals ?? []).find(
    a =>
      bound(a, binding) &&
      a.remediation === option.remediation &&
      sameRef(a.target, option.target) &&
      (!a.node || a.node === node) &&
      (decision === undefined || effectiveDecision(a) === decision)
  );
}

export interface FindingAnswers {
  /** Remediations with an Apply. */
  applied: string[];
  /** An Accept of any of its options. */
  accepted: boolean;
}

/** What a finding of node has been answered with already. */
export function findingAnswers(
  approvals: AnyApproval[] | undefined,
  f: Finding,
  binding: Binding,
  node: string
): FindingAnswers {
  const options = f.remediations ?? [];
  return {
    applied: options
      .filter(
        o =>
          o.remediation !== ACKNOWLEDGE && !!existingApproval(approvals, o, binding, node, 'Apply')
      )
      .map(o => o.remediation),
    accepted: options.some(o => !!existingApproval(approvals, o, binding, node, 'Accept')),
  };
}

/**
 * The JSON Patch that adds one answer to the approvals at path (spec.approvals
 * of the ClusterUpgrade, spec.nodes.rollout.approvals of the ClusterConfig).
 * An existing list gets an `add .../-`: an append keeps what others wrote
 * meanwhile, so it needs no precondition. A missing list is created, guarded
 * by the generation. Empty when the same approval is there already.
 */
export function addApprovalOps(
  obj: Versioned & { spec?: unknown },
  path: Path,
  approval: AnyApproval
): JsonPatchOp[] {
  const list = getIn(obj, path);
  if (Array.isArray(list)) {
    if ((list as AnyApproval[]).some(a => approvalKey(a) === approvalKey(approval))) {
      return [];
    }
    return [{ op: 'add', path: `${toPointer(path)}/-`, value: clone(approval) }];
  }
  const spec = isPlainObject(obj.spec) ? obj.spec : {};
  const desired = setIn(spec, path.slice(1), [clone(approval)]);
  const ops =
    obj.spec === undefined
      ? [{ op: 'add' as const, path: '/spec', value: desired }]
      : diffToOps(obj.spec, desired, ['spec']);
  return [precondition(obj), ...ops];
}

// ------------------------------------------------------ Pre-approve choices

/** Identifies a finding of a node across report refreshes. */
export function findingKey(node: string, f: Finding): string {
  return `${node}|${f.kind}|${refKey(f.object)}`;
}

/** The answers chosen for one finding: fixes to apply, and whether to go on without one. */
export interface Choice {
  apply: string[];
  accept: boolean;
}

/** By findingKey. */
export type Selection = Record<string, Choice>;

/** Findings that can be answered: Blocks and Disrupts with an option. */
export function answerable(f: Finding): boolean {
  return f.severity !== 'Info' && (f.remediations ?? []).length > 0;
}

/** The selection the existing approvals of the binding make for the report. */
export function initialSelection(
  report: ReadinessReport | undefined,
  approvals: AnyApproval[] | undefined,
  binding: Binding
): Selection {
  const sel: Selection = {};
  for (const n of report?.nodes ?? []) {
    for (const f of n.findings ?? []) {
      if (!answerable(f)) {
        continue;
      }
      const ans = findingAnswers(approvals, f, binding, n.name);
      const fixes = findingChoices(f).fixes.map(o => o.remediation);
      const apply = ans.applied.filter(id => fixes.includes(id));
      if (apply.length || ans.accepted) {
        sel[findingKey(n.name, f)] = {
          apply: f.severity === 'Blocks' ? apply.slice(0, 1) : apply,
          accept: ans.accepted && !(f.severity === 'Blocks' && apply.length > 0),
        };
      }
    }
  }
  return sel;
}

/**
 * "Approve all safe fixes": every fix with risk None, the first one for a
 * finding that blocks (one choice each). Go on (acknowledge) is never safe:
 * the disruption happens, and on bare pods the drain deletes them.
 */
export function safeSelection(report: ReadinessReport | undefined, from: Selection): Selection {
  const sel: Selection = { ...from };
  for (const n of report?.nodes ?? []) {
    for (const f of n.findings ?? []) {
      if (!answerable(f)) {
        continue;
      }
      const safe = findingChoices(f)
        .fixes.filter(o => o.risk === 'None')
        .map(o => o.remediation);
      if (safe.length === 0) {
        continue;
      }
      const key = findingKey(n.name, f);
      const cur = sel[key] ?? { apply: [], accept: false };
      sel[key] =
        f.severity === 'Blocks'
          ? { apply: [safe[0]], accept: false }
          : { apply: [...new Set([...cur.apply, ...safe])], accept: false };
    }
  }
  return sel;
}

export interface PreApproval {
  /** The release being started. */
  release: string;
  /** The answers chosen in the review. */
  answers: Answer[];
  /** The options the review showed, per node: approvals answering them are replaced. */
  shown: { node: string; remediation: string; target: ObjectRef }[];
}

/** The answers of a selection, for the report's findings. */
export function selectionAnswers(
  report: ReadinessReport | undefined,
  selection: Selection
): PreApproval['answers'] {
  const out: Answer[] = [];
  for (const n of report?.nodes ?? []) {
    for (const f of n.findings ?? []) {
      const choice = selection[findingKey(n.name, f)];
      if (!choice || !answerable(f)) {
        continue;
      }
      const options = f.remediations ?? [];
      for (const id of choice.apply) {
        const o = options.find(x => x.remediation === id);
        if (o) {
          out.push(applyAnswer(o));
        }
      }
      const acc = choice.accept ? acceptAnswer(f, n.name) : null;
      if (acc) {
        out.push(acc);
      }
    }
  }
  return out;
}

/** The options a review of the report shows, per node. */
export function shownOptions(report: ReadinessReport | undefined): PreApproval['shown'] {
  const out: PreApproval['shown'] = [];
  for (const n of report?.nodes ?? []) {
    for (const f of n.findings ?? []) {
      if (!answerable(f)) {
        continue;
      }
      for (const o of f.remediations ?? []) {
        out.push({ node: n.name, remediation: o.remediation, target: o.target });
      }
    }
  }
  return out;
}

/**
 * spec.approvals after a pre-approve: the approvals of the release that
 * answer an option the review showed are replaced by the chosen answers (an
 * unchanged answer keeps its approval as it was); every other approval stays.
 */
export function mergePreApproval(
  existing: RemediationApproval[] | undefined,
  pre: PreApproval
): RemediationApproval[] {
  const binding = { release: pre.release };
  const covers = (a: RemediationApproval) =>
    a.release === pre.release &&
    pre.shown.some(
      s =>
        s.remediation === a.remediation &&
        sameRef(s.target, a.target) &&
        (!a.node || a.node === s.node)
    );
  const covered = (existing ?? []).filter(covers);
  const kept = (existing ?? []).filter(a => !covers(a));
  const out: RemediationApproval[] = [...kept];
  const seen = new Set(out.map(approvalKey));
  for (const ans of pre.answers) {
    const same = covered.find(
      a =>
        a.remediation === ans.remediation &&
        sameRef(a.target, ans.target) &&
        effectiveDecision(a) === ans.decision &&
        (!a.node || !ans.node || a.node === ans.node)
    );
    const approval = (same ?? toApproval(ans, binding)) as RemediationApproval;
    const key = approvalKey(approval);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clone(approval));
    }
  }
  return out;
}

// ------------------------------------------------------------------ View

/** Headlamp's own namespace on k4all, and the label of its pod (the Headlamp chart). */
export const HEADLAMP_NAMESPACE = 'headlamp';
export const HEADLAMP_POD_SELECTOR = 'app.kubernetes.io/name=headlamp';

/** The kubectl commands to follow the upgrade while this page is gone. */
export const FOLLOW_COMMANDS: Command[] = [
  { command: 'kubectl get clusterupgrade k4all -w', where: 'with kubectl' },
  {
    command: 'kubectl get events --field-selector involvedObject.name=k4all',
    where: 'with kubectl',
  },
];

export interface NodeCard extends NodeReadiness {
  findings: Finding[];
  /** This page goes away while this node drains: Headlamp's pod runs here. */
  headlamp?: 'moves' | 'pinned';
}

export interface ReadinessView {
  report: ReadinessReport;
  /** status.readiness.message, else built from the summary. */
  headline: string;
  /** hops > 1: the counts are per hop. */
  perHop: boolean;
  hops: number;
  checkedAt?: string;
  dryRun: boolean;
  release?: string;
  /** The report is for another release than the one asked about. */
  otherRelease?: string;
  cluster: Finding[];
  nodes: NodeCard[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A headline from the counts, for a report without a message. */
export function summaryHeadline(report: ReadinessReport): string {
  const s = report.summary ?? {};
  const parts: string[] = [];
  if (s.blocks) {
    parts.push(`${plural(s.blocks, 'thing')} will stop the upgrade`);
  }
  if (s.vmShutdowns) {
    parts.push(
      `${plural(s.vmShutdowns, 'VM')} will shut down${
        s.vmsDownUntilNodeBack ? `, ${s.vmsDownUntilNodeBack} until their node is back` : ''
      }`
    );
  }
  if (s.disrupts) {
    parts.push(`${plural(s.disrupts, 'disruption')}`);
  }
  return parts.length ? parts.join(', ') : 'Nothing stops or disrupts the upgrade';
}

/** Is Headlamp's pod pinned to this node (a PinnedToNode finding in Headlamp's namespace)? */
function headlampPinned(findings: Finding[]): boolean {
  return findings.some(f => f.kind === 'PinnedToNode' && f.object.namespace === HEADLAMP_NAMESPACE);
}

/**
 * The report as the page shows it. `release` is the release being started
 * (the review), or the target of the running upgrade; `headlampNode` the
 * node Headlamp's pod runs on, when known.
 */
export function readinessView(
  report: ReadinessReport,
  opts: { release?: string; headlampNode?: string } = {}
): ReadinessView {
  const hops = report.hops ?? 1;
  const nodes = (report.nodes ?? []).map((n): NodeCard => {
    const findings = sortFindings(n.findings);
    const pinned = headlampPinned(findings);
    return {
      ...n,
      findings,
      headlamp: pinned ? 'pinned' : opts.headlampNode === n.name ? 'moves' : undefined,
    };
  });
  return {
    report,
    headline: report.message || summaryHeadline(report),
    perHop: hops > 1,
    hops,
    checkedAt: report.checkedAt,
    dryRun: report.dryRun === true,
    release: report.release,
    otherRelease:
      opts.release && report.release && report.release !== opts.release
        ? report.release
        : undefined,
    cluster: sortFindings(report.cluster),
    nodes,
  };
}

// ---------------------------------------------------------------- Records

export const RECORD_PHASE: Record<
  string,
  { label: string; tone: 'success' | 'info' | 'warning' | 'error' | 'neutral'; busy?: boolean }
> = {
  Applying: { label: 'Applying', tone: 'info', busy: true },
  Applied: { label: 'Applied', tone: 'warning' },
  Restoring: { label: 'Putting back', tone: 'info', busy: true },
  Restored: { label: 'Put back', tone: 'success' },
  Superseded: { label: 'Changed by someone else', tone: 'neutral' },
  Failed: { label: 'Failed', tone: 'error' },
};

/** Put back now acts on a record that still holds a change: not Restored, Restoring or Superseded. */
export function canRestore(phase: string | undefined): boolean {
  return phase === 'Applying' || phase === 'Applied' || phase === 'Failed';
}
