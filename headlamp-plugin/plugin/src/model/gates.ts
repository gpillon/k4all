/*
 * KubeVirt feature gates as k4all owns them (k4all v2.7.0, operator v0.6.0):
 *
 * - k4all's lists are features.virt.kubevirt.featureGates (on) and
 *   .disabledFeatureGates (off) in the ClusterConfig;
 * - the operator folds them into the KubeVirt CR with the merge of spec
 *   §7.2 (mergeGates), and records what it added in the CR annotations
 *   k4all.magesgate.com/feature-gates and .../disabled-feature-gates;
 * - a gate in the CR that the annotations do not name was set elsewhere
 *   (Hangar, an admin) and stays theirs.
 *
 * Maturity per KubeVirt minor comes from Hangar's tables (gateTables.ts, a
 * generated copy), read with KubeVirt's rules (pkg/virt-config/featuregate):
 * GA is always on and cannot be turned off; Alpha and Deprecated are on only
 * when listed; Beta is on by default from v1.9 (off unless listed before);
 * a Discontinued gate does nothing. The operator has no maturity tables: the
 * plugin refuses a GA gate in the off list before saving.
 */

import { GATE_TABLES } from './gateTables';
import { setIn } from './objects';
import {
  ClusterConfigSpec,
  KUBEVIRT_DISABLED_GATES_ANNOTATION,
  KUBEVIRT_GATES_ANNOTATION,
  KubeVirtLike,
  KubeVirtSettings,
} from './types';
import type { Issue } from './validation';

export type Maturity = 'GA' | 'Beta' | 'Alpha' | 'Deprecated' | 'Discontinued';

/** One KubeVirt minor's gates (the shape of Hangar's gateTables.ts). */
export interface GateTable {
  /** KubeVirt minor version the table describes ("v1.9" covers v1.9.x). */
  version: string;
  /** Where the table comes from. */
  source: string;
  /** Beta gates are on unless listed in disabledFeatureGates (v1.9 on); before, off unless listed. */
  betaOnByDefault: boolean;
  /** The KubeVirt resource has developerConfiguration.disabledFeatureGates (v1.8 on). */
  disabledList: boolean;
  gates: Record<string, Maturity>;
}

export { GATE_TABLES };

export const HOTPLUG_OLD = 'HotplugVolumes';
export const HOTPLUG_DECLARATIVE = 'DeclarativeHotplugVolumes';

/** The other gate of the exclusive hot-plug pair, if name is one of them. */
export function hotplugRival(name: string): string | undefined {
  return name === HOTPLUG_OLD
    ? HOTPLUG_DECLARATIVE
    : name === HOTPLUG_DECLARATIVE
    ? HOTPLUG_OLD
    : undefined;
}

function minorOf(version: string | undefined): [number, number] | null {
  const m = version?.match(/^v?(\d+)\.(\d+)(\.|$|-)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The running KubeVirt version, from the KubeVirt CR. */
export function kubevirtVersion(kv: KubeVirtLike | null | undefined): string | undefined {
  return kv?.status?.observedKubeVirtVersion || kv?.status?.targetKubeVirtVersion || undefined;
}

/** The table of the KubeVirt minor of version, or null (unknown or unparsable version). */
export function gateTableFor(version: string | undefined): GateTable | null {
  const m = minorOf(version);
  return m ? GATE_TABLES.find(t => t.version === `v${m[0]}.${m[1]}`) ?? null : null;
}

/** KubeVirt has developerConfiguration.disabledFeatureGates from v1.8. */
export function hasDisabledList(version: string | undefined): boolean {
  const m = minorOf(version);
  return !!m && (m[0] > 1 || (m[0] === 1 && m[1] >= 8));
}

export interface GateLists {
  featureGates: string[];
  disabledFeatureGates: string[];
}

const EMPTY: GateLists = { featureGates: [], disabledFeatureGates: [] };

/** The gate lists of the KubeVirt CR. */
export function liveGates(kv: KubeVirtLike | null | undefined): GateLists {
  const dev = kv?.spec?.configuration?.developerConfiguration;
  return {
    featureGates: [...(dev?.featureGates ?? [])],
    disabledFeatureGates: [...(dev?.disabledFeatureGates ?? [])],
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** What k4all-operator added to the KubeVirt CR last time (its annotations). */
export function appliedGates(kv: KubeVirtLike | null | undefined): GateLists {
  const a = kv?.metadata.annotations ?? {};
  return {
    featureGates: splitList(a[KUBEVIRT_GATES_ANNOTATION]),
    disabledFeatureGates: splitList(a[KUBEVIRT_DISABLED_GATES_ANNOTATION]),
  };
}

/** k4all's lists in the ClusterConfig. */
export function wantedGates(spec: ClusterConfigSpec): GateLists {
  const k = spec.features?.virt?.kubevirt;
  return {
    featureGates: [...(k?.featureGates ?? [])],
    disabledFeatureGates: [...(k?.disabledFeatureGates ?? [])],
  };
}

const minus = (a: string[], b: string[]) => a.filter(x => !b.includes(x));
const union = (...lists: string[][]) => [...new Set(lists.flat())];

/**
 * The lists the operator writes into the KubeVirt CR (spec §7.2), from the
 * live lists L/LD, what k4all added last time A/AD and the ClusterConfig E/D:
 *
 *   featureGates         = ((L − (A − E)) ∪ E) − D
 *   disabledFeatureGates = ((LD − (AD − D)) ∪ D) − E     (KubeVirt 1.8 and later)
 *
 * and never both hot-plug gates: the one already live wins.
 */
export function mergeGates(
  live: GateLists,
  applied: GateLists,
  wanted: GateLists,
  disabledList: boolean
): GateLists {
  const E = wanted.featureGates;
  const D = wanted.disabledFeatureGates;
  let featureGates = minus(union(minus(live.featureGates, minus(applied.featureGates, E)), E), D);
  const disabledFeatureGates = disabledList
    ? minus(union(minus(live.disabledFeatureGates, minus(applied.disabledFeatureGates, D)), D), E)
    : [...live.disabledFeatureGates];
  if (featureGates.includes(HOTPLUG_OLD) && featureGates.includes(HOTPLUG_DECLARATIVE)) {
    const oldLive = live.featureGates.includes(HOTPLUG_OLD);
    const declLive = live.featureGates.includes(HOTPLUG_DECLARATIVE);
    if (oldLive !== declLive) {
      featureGates = featureGates.filter(g => g !== (oldLive ? HOTPLUG_DECLARATIVE : HOTPLUG_OLD));
    }
  }
  return { featureGates, disabledFeatureGates };
}

/** A gate's state as KubeVirt computes it from the lists, without the hot-plug precedence. */
function rawOn(table: GateTable | null, lists: GateLists, name: string): boolean | null {
  const listed = lists.featureGates.includes(name);
  const disabled = lists.disabledFeatureGates.includes(name);
  if (!table) {
    return listed ? true : disabled ? false : null;
  }
  switch (table.gates[name]) {
    case 'GA':
      return true;
    case 'Discontinued':
    case undefined:
      return false;
    case 'Beta':
      return listed || (table.betaOnByDefault && !disabled);
    default:
      return listed;
  }
}

/**
 * Whether KubeVirt runs the gate with these lists (featuregate.IsEnabled);
 * null when there is no table and the lists do not say. Declarative hot-plug
 * is off while HotplugVolumes is on: KubeVirt's VM controller skips it.
 */
export function gateOn(table: GateTable | null, lists: GateLists, name: string): boolean | null {
  const on = rawOn(table, lists, name);
  if (name === HOTPLUG_DECLARATIVE && on && rawOn(table, lists, HOTPLUG_OLD)) {
    return false;
  }
  return on;
}

/** Who sets a gate: k4all (the ClusterConfig), someone else (in the CR, not in the annotations), nobody. */
export type GateOwner = 'k4all' | 'elsewhere' | 'none';

export interface GateRow {
  name: string;
  /** null: no table for this KubeVirt version, or a gate the table does not know. */
  maturity: Maturity | null;
  /** On without being listed (GA; Beta from v1.9); null without a table. */
  defaultOn: boolean | null;
  owner: GateOwner;
  /** k4all's setting in the ClusterConfig given. */
  k4all?: 'on' | 'off';
  /** The ClusterConfig differs from what the annotations say k4all applied: the operator has yet to apply it. */
  pending: boolean;
  /** On in the running KubeVirt; null without a KubeVirt CR or when it cannot be told. */
  onNow: boolean | null;
  /** On once the operator applied this ClusterConfig (the §7.2 merge). */
  onAfter: boolean | null;
  /** GA gates cannot be turned off. */
  canDisable: boolean;
}

export interface GateContext {
  kv: KubeVirtLike | null | undefined;
  /** KubeVirt version to use without a KubeVirt CR (the release's kubevirt component). */
  version?: string;
}

function contextOf(ctx: GateContext) {
  const version = kubevirtVersion(ctx.kv) ?? ctx.version;
  return { version, table: gateTableFor(version), disabledList: hasDisabledList(version) };
}

/** Every gate to show: the version's table, the CR's lists, the annotations and the ClusterConfig's, by name. */
export function gateRows(ctx: GateContext & { spec: ClusterConfigSpec }): GateRow[] {
  const { table, disabledList } = contextOf(ctx);
  const live = ctx.kv ? liveGates(ctx.kv) : EMPTY;
  const applied = ctx.kv ? appliedGates(ctx.kv) : EMPTY;
  const wanted = wantedGates(ctx.spec);
  const after = mergeGates(live, applied, wanted, disabledList);
  const names = union(
    Object.keys(table?.gates ?? {}),
    live.featureGates,
    live.disabledFeatureGates,
    applied.featureGates,
    applied.disabledFeatureGates,
    wanted.featureGates,
    wanted.disabledFeatureGates
  ).sort((a, b) => a.localeCompare(b));
  return names.map(name => {
    const maturity = table?.gates[name] ?? null;
    const k4all = wanted.featureGates.includes(name)
      ? 'on'
      : wanted.disabledFeatureGates.includes(name)
      ? 'off'
      : undefined;
    const elsewhere =
      (live.featureGates.includes(name) && !applied.featureGates.includes(name)) ||
      (live.disabledFeatureGates.includes(name) && !applied.disabledFeatureGates.includes(name));
    const pending =
      !!ctx.kv &&
      (wanted.featureGates.includes(name) !== applied.featureGates.includes(name) ||
        wanted.disabledFeatureGates.includes(name) !== applied.disabledFeatureGates.includes(name));
    return {
      name,
      maturity,
      defaultOn: !table
        ? null
        : maturity === 'GA' || (maturity === 'Beta' && table.betaOnByDefault),
      owner: k4all ? 'k4all' : elsewhere ? 'elsewhere' : 'none',
      k4all,
      pending,
      onNow: ctx.kv ? gateOn(table, live, name) : null,
      onAfter: gateOn(table, after, name),
      canDisable: maturity !== 'GA',
    };
  });
}

function withLists(spec: ClusterConfigSpec, lists: GateLists): ClusterConfigSpec {
  const kubevirt: KubeVirtSettings = { ...(spec.features?.virt?.kubevirt ?? {}) };
  delete kubevirt.featureGates;
  delete kubevirt.disabledFeatureGates;
  if (lists.featureGates.length) {
    kubevirt.featureGates = lists.featureGates;
  }
  if (lists.disabledFeatureGates.length) {
    kubevirt.disabledFeatureGates = lists.disabledFeatureGates;
  }
  // Absent means "k4all owns none of them": leave no empty object behind.
  return setIn(
    spec,
    ['features', 'virt', 'kubevirt'],
    Object.keys(kubevirt).length ? kubevirt : undefined
  );
}

/**
 * k4all's setting for one gate: on (featureGates), off (disabledFeatureGates)
 * or not owned (neither). Turning one hot-plug gate on turns the other off,
 * as Hangar does: it leaves k4all's on list, and goes to the off list when
 * it would still be on (set elsewhere, or Beta on by default). `also` names
 * the other gates the change touched.
 */
export function setK4allGate(
  spec: ClusterConfigSpec,
  name: string,
  value: 'on' | 'off' | undefined,
  ctx: GateContext
): { spec: ClusterConfigSpec; also: string[] } {
  const { table, disabledList } = contextOf(ctx);
  const wanted = wantedGates(spec);
  let E = wanted.featureGates.filter(g => g !== name);
  let D = wanted.disabledFeatureGates.filter(g => g !== name);
  if (value === 'on') {
    E.push(name);
  } else if (value === 'off') {
    D.push(name);
  }
  const also: string[] = [];
  const rival = hotplugRival(name);
  if (value === 'on' && rival) {
    const wasOn = E.includes(rival);
    E = E.filter(g => g !== rival);
    D = D.filter(g => g !== rival);
    const live = ctx.kv ? liveGates(ctx.kv) : EMPTY;
    const applied = ctx.kv ? appliedGates(ctx.kv) : EMPTY;
    const after = mergeGates(
      live,
      applied,
      { featureGates: E, disabledFeatureGates: D },
      disabledList
    );
    if (rawOn(table, after, rival)) {
      D.push(rival);
      also.push(rival);
    } else if (wasOn) {
      also.push(rival);
    }
  }
  return { spec: withLists(spec, { featureGates: E, disabledFeatureGates: D }), also };
}

/** Problems with k4all's gate lists: errors block saving. */
export function gateIssues(spec: ClusterConfigSpec, ctx: GateContext): Issue[] {
  const { table } = contextOf(ctx);
  const v = table?.version;
  const { featureGates: E, disabledFeatureGates: D } = wantedGates(spec);
  const live = ctx.kv ? liveGates(ctx.kv) : EMPTY;
  const applied = ctx.kv ? appliedGates(ctx.kv) : EMPTY;
  const issues: Issue[] = [];
  const add = (severity: Issue['severity'], message: string) =>
    issues.push({ field: 'kubevirtGates', severity, message });
  for (const g of E.filter(x => D.includes(x))) {
    add('error', `${g} cannot be both on and off.`);
  }
  if (E.includes(HOTPLUG_OLD) && E.includes(HOTPLUG_DECLARATIVE)) {
    add('error', `${HOTPLUG_OLD} turns ${HOTPLUG_DECLARATIVE} off: set one.`);
  }
  for (const g of D) {
    if (table?.gates[g] === 'GA') {
      add('error', `${g} is GA in KubeVirt ${v}: always on, it cannot be turned off.`);
    }
  }
  for (const g of union(E, D)) {
    const m = table?.gates[g];
    if (!table) {
      continue;
    }
    if (m === 'GA' && E.includes(g)) {
      add('warning', `${g} is GA in KubeVirt ${v}: always on, the entry does nothing.`);
    } else if (m === 'Discontinued') {
      add('warning', `${g} was removed from KubeVirt: the entry does nothing.`);
    } else if (m === undefined) {
      add('warning', `KubeVirt ${v} does not know ${g}: the entry does nothing.`);
    }
  }
  for (const g of E) {
    const rival = hotplugRival(g);
    if (
      rival &&
      live.featureGates.includes(rival) &&
      !applied.featureGates.includes(rival) &&
      !D.includes(rival)
    ) {
      add(
        'warning',
        `${rival} is on in the KubeVirt CR (set elsewhere): k4all-operator does not add ${g} ` +
          `while it is there. Turn ${rival} off here too.`
      );
    }
  }
  return issues;
}

export const CPU_MANAGER_GATE = 'CPUManager';

/**
 * Whether the Node settings page says that VMs with dedicated CPUs
 * (dedicatedCpuPlacement) need KubeVirt's CPUManager gate (k4all#111): the
 * static CPU manager alone is not enough, because virt-handler labels the
 * nodes cpumanager=true only with the gate, and on KubeVirt 1.9 it is Alpha,
 * off unless listed.
 *
 * True with the static policy in the draft (saved, or being edited),
 * Virtualization on, and the KubeVirt CR read without the gate on, read as
 * the Virtualization page reads it (gateOn with the version's table). No CR
 * (none, or it cannot be read), or a KubeVirt whose table does not know the
 * gate or has it Discontinued: false, nothing to say.
 */
export function cpuManagerGateMissing(
  spec: ClusterConfigSpec,
  ctx: { kv: KubeVirtLike | null | undefined; version?: string }
): boolean {
  if (
    spec.nodes?.kubelet?.cpuManagerPolicy !== 'static' ||
    spec.features?.virt?.enabled !== true ||
    !ctx.kv
  ) {
    return false;
  }
  const { table } = contextOf(ctx);
  const maturity = table?.gates[CPU_MANAGER_GATE];
  if (table && (maturity === undefined || maturity === 'Discontinued')) {
    return false;
  }
  return gateOn(table, liveGates(ctx.kv), CPU_MANAGER_GATE) !== true;
}
