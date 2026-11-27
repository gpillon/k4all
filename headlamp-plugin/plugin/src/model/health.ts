/*
 * Overall cluster state for the overview: one headline plus the banners that
 * explain it.
 */

import { componentNotices, ComponentRow, groupNotices, summarize } from './components';
import {
  ClusterConfigObject,
  Condition,
  NODE_RELEASE_ANNOTATION,
  NODE_TYPE_ANNOTATION,
  NODE_UPGRADE_PHASE_ANNOTATION,
  NodeConfigObject,
  NodeLike,
  ReleaseManifestObject,
  UPGRADE_IN_PROGRESS_ANNOTATION,
} from './types';

/** The operator requeues every 5 minutes; past this, it is probably not running. */
export const OPERATOR_STALE_MS = 15 * 60 * 1000;

export type HealthLevel = 'healthy' | 'progressing' | 'upgrading' | 'degraded' | 'unknown';

export interface Banner {
  id: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail?: string;
}

export interface Health {
  level: HealthLevel;
  headline: string;
  banners: Banner[];
}

export interface NodeUpgrade {
  node: string;
  from?: string;
  to?: string;
  raw: string;
}

/** Nodes carrying the k4all-upgrade pause annotation ("<from>-><to>"). */
export function nodeUpgrades(nodes: NodeLike[]): NodeUpgrade[] {
  return nodes
    .filter(n => n.metadata.annotations?.[UPGRADE_IN_PROGRESS_ANNOTATION] !== undefined)
    .map(n => {
      const raw = n.metadata.annotations?.[UPGRADE_IN_PROGRESS_ANNOTATION] ?? '';
      const [from, to] = raw.split('->').map(s => s.trim());
      return { node: n.metadata.name, raw, from: from || undefined, to: to || undefined };
    })
    .sort((a, b) => a.node.localeCompare(b.node));
}

export function findCondition(
  conditions: Condition[] | undefined,
  type: string
): Condition | undefined {
  return (conditions ?? []).find(c => c.type === type);
}

export interface HealthInput {
  rm: ReleaseManifestObject | null;
  cc: ClusterConfigObject | null;
  rows: ComponentRow[];
  nodes: NodeLike[];
  now: number;
}

export function clusterHealth({ rm, cc, rows, nodes, now }: HealthInput): Health {
  const banners: Banner[] = [];
  if (!rm || !cc) {
    return {
      level: 'unknown',
      headline: !cc ? 'No ClusterConfig' : 'No ReleaseManifest',
      banners: [
        {
          id: 'missing',
          severity: 'error',
          title: !cc ? 'The cluster has no ClusterConfig.' : 'The cluster has no ReleaseManifest.',
          detail:
            'k4all-operator has nothing to reconcile. They are created by deploy-operator.sh at installation.',
        },
      ],
    };
  }

  const upgrades = nodeUpgrades(nodes);
  const ready = findCondition(rm.status?.conditions, 'Ready');
  const summary = summarize(rows);

  if (upgrades.length > 0) {
    banners.push({
      id: 'upgrade',
      severity: 'info',
      title: `Upgrade in progress on ${upgrades.map(u => u.node).join(', ')}`,
      detail:
        upgrades
          .map(u => (u.from && u.to ? `${u.node}: ${u.from} → ${u.to}` : `${u.node}: ${u.raw}`))
          .join('; ') + '. k4all-operator pauses component changes until the hop is committed.',
    });
  }

  const generation = cc.metadata.generation;
  const observed = cc.status?.observedGeneration;
  if (generation !== undefined && observed !== undefined && observed < generation) {
    banners.push({
      id: 'applying',
      severity: 'info',
      title: 'Applying settings',
      detail: `The operator has not finished a reconcile of the latest settings yet (generation ${generation}, applied ${observed}).`,
    });
  }

  const last = cc.status?.lastReconcileTime ? Date.parse(cc.status.lastReconcileTime) : NaN;
  if (!Number.isNaN(last) && now - last > OPERATOR_STALE_MS && upgrades.length === 0) {
    banners.push({
      id: 'stale',
      severity: 'warning',
      title: 'k4all-operator looks idle',
      detail: `The last reconcile was ${Math.round(
        (now - last) / 60000
      )} minutes ago; it normally runs every 5 minutes. Check the k4all-operator-system namespace.`,
    });
  }

  if (ready?.status === 'False') {
    switch (ready.reason) {
      case 'ClusterConfigNotFound':
      case 'DependencyCycle':
        banners.push({
          id: 'ready',
          severity: 'error',
          title: ready.reason,
          detail: ready.message,
        });
        break;
    }
  }

  // Operator v0.5.7+: a component kept installed though it should go
  // ("uninstall refused: "), v0.6.0: one that waits ("waiting: ").
  // A held group (#96) carries one message on every member: name it once.
  const notices = componentNotices(rm);
  const banner = (
    kind: 'refused' | 'waiting' | 'queued',
    severity: Banner['severity'],
    title: (names: string) => string,
    tail = ''
  ) => {
    const list = notices.filter(n => n.kind === kind);
    if (list.length === 0) {
      return;
    }
    banners.push({
      id: kind,
      severity,
      title: title(list.map(n => n.name).join(', ')),
      detail:
        groupNotices(list)
          .map(g => g.label)
          .join('; ') + tail.replace('$', list.length === 1 ? 'it' : 'them'),
    });
  };
  banner(
    'refused',
    'warning',
    names => `k4all-operator keeps ${names} installed`,
    '. It removes $ once that is gone.'
  );
  banner('queued', 'info', names => `Uninstalling in order: ${names}`);
  banner('waiting', 'info', names => `Waiting: ${names}`);

  // Node settings (operator v0.6.0), from status.nodes.
  const rollout = cc.status?.nodes?.rollout;
  const phase = rollout?.phase;
  if (phase === 'Rolling' || phase === 'Paused' || phase === 'Blocked') {
    const hash = cc.status?.nodes?.settingsHash;
    const perNode = cc.status?.nodes?.perNode ?? [];
    const done = perNode.filter(n => !!hash && n.appliedHash === hash).length;
    banners.push({
      id: 'nodeSettings',
      severity: phase === 'Rolling' ? 'info' : 'warning',
      title:
        phase === 'Rolling'
          ? `Node settings rollout${rollout?.currentNode ? ` on ${rollout.currentNode}` : ''}`
          : `Node settings rollout ${phase === 'Paused' ? 'paused' : 'blocked'}`,
      detail:
        `${done} of ${perNode.length} nodes have the settings.` +
        (rollout?.message ? ` ${rollout.message}` : ''),
    });
  }

  if (summary.failed > 0) {
    const failed = rows.filter(r => r.state.tone === 'error').map(r => r.name);
    banners.push({
      id: 'failed',
      severity: 'error',
      title: `${failed.length} component${failed.length > 1 ? 's' : ''} failed`,
      detail: failed.join(', '),
    });
  }

  let level: HealthLevel = 'healthy';
  let headline = 'Healthy';
  if (summary.failed > 0 || banners.some(b => b.severity === 'error')) {
    level = 'degraded';
    headline = 'Needs attention';
  } else if (upgrades.length > 0 || ready?.reason === 'UpgradeInProgress') {
    level = 'upgrading';
    headline = 'Upgrading';
  } else if (
    summary.busy > 0 ||
    banners.some(b => b.id === 'applying') ||
    phase === 'Rolling' ||
    ready?.status !== 'True'
  ) {
    level = 'progressing';
    headline = 'Reconciling';
  }
  return { level, headline, banners };
}

// ------------------------------------------------------------------- Nodes

export interface NodeRow {
  name: string;
  role: string;
  ready: boolean;
  kubelet?: string;
  osImage?: string;
  runtime?: string;
  internalIP?: string;
  upgrade?: NodeUpgrade;
  schedulable: boolean;
  /** The k4all release the node runs (k4all-upgrade's release annotation, v2.4.0+). */
  release?: string;
  /** k4all-upgrade's phase of a hop on the node (upgrade-phase annotation). */
  hostPhase?: string;
}

function roleOf(node: NodeLike, nc: NodeConfigObject | undefined): string {
  const annotated = node.metadata.annotations?.[NODE_TYPE_ANNOTATION];
  if (annotated) {
    return annotated;
  }
  if (nc?.status?.nodeType) {
    return nc.status.nodeType;
  }
  const labels = node.metadata.labels ?? {};
  if ('node-role.kubernetes.io/control-plane' in labels) {
    return 'control';
  }
  return 'worker';
}

export function nodeRows(nodes: NodeLike[], nodeConfigs: NodeConfigObject[]): NodeRow[] {
  const upgrades = new Map(nodeUpgrades(nodes).map(u => [u.node, u]));
  const byNode = new Map(nodeConfigs.map(nc => [nc.status?.nodeName || nc.metadata.name, nc]));
  const order: Record<string, number> = { bootstrap: 0, control: 1, worker: 2 };
  return nodes
    .map(node => ({
      name: node.metadata.name,
      role: roleOf(node, byNode.get(node.metadata.name)),
      ready: findCondition(node.status?.conditions, 'Ready')?.status === 'True',
      kubelet: node.status?.nodeInfo?.kubeletVersion,
      osImage: node.status?.nodeInfo?.osImage,
      runtime: node.status?.nodeInfo?.containerRuntimeVersion,
      internalIP: node.status?.addresses?.find(a => a.type === 'InternalIP')?.address,
      upgrade: upgrades.get(node.metadata.name),
      schedulable: !node.spec?.unschedulable,
      release: node.metadata.annotations?.[NODE_RELEASE_ANNOTATION],
      hostPhase: node.metadata.annotations?.[NODE_UPGRADE_PHASE_ANNOTATION],
    }))
    .sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3) || a.name.localeCompare(b.name));
}

/** The Kubernetes versions the kubelets run, newest first ("v1.36.2"). */
export function kubeletVersions(nodes: NodeLike[]): string[] {
  const versions = new Set<string>();
  for (const n of nodes) {
    if (n.status?.nodeInfo?.kubeletVersion) {
      versions.add(n.status.nodeInfo.kubeletVersion);
    }
  }
  return [...versions].sort().reverse();
}
