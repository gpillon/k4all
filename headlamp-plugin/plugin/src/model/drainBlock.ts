/*
 * A drain k4all-operator will not start or finish, for the upgrades and the
 * node-settings rollout alike (k4all-operator internal/drain, from v0.5.8):
 *
 * - before the cordon, drain.BlockedMessage: "cannot be drained: PDB <pdb>
 *   allows no disruption of pod <pod>[; …] (…Drains that never end)" and/or
 *   "runs pods that declare no controller: <pods> (…Pods that declare no
 *   controller)", then "; the node is not cordoned" (k4all#87, k4all#99);
 * - while it evicts, drain.Drain: "<n> pods left: …; not evicted, they
 *   declare no controller: <pods> (…)".
 *
 * The operator gives no machine-readable reason for these (ClusterUpgrade
 * nodes[].reason has no value for them), so this is the one place the plugin
 * reads a message: only the shared drain's own phrases, never free text.
 */

import type { Command } from './upgrades';

export const DOCS_UPGRADES_URL = 'https://github.com/gpillon/k4all/blob/main/docs/upgrades.md';
export const BARE_PODS_DOC_URL = `${DOCS_UPGRADES_URL}#pods-that-declare-no-controller`;
export const DRAINS_NEVER_END_DOC_URL = `${DOCS_UPGRADES_URL}#drains-that-never-end`;

export interface DrainBlock {
  /** Budgets that allow no disruption although every pod they expect is healthy. */
  pdbs: { pdb: string; pod: string }[];
  /** How many more the operator left unnamed. */
  pdbMore: number;
  /** Pods (namespace/name) that declare no controller: a drain would delete them for good. */
  bare: string[];
  bareMore: number;
  /** Blocked before the cordon (drain.BlockedMessage), not during a drain. */
  notCordoned: boolean;
}

export interface DocLink {
  label: string;
  href: string;
}

const NOT_CORDONED = '; the node is not cordoned';

function names(list: string): { named: string[]; more: number } {
  const named: string[] = [];
  let more = 0;
  for (const part of list.split(/,\s*|;\s*/)) {
    const m = part.trim().match(/^and (\d+) more$/);
    if (m) {
      more = Number(m[1]);
    } else if (part.trim()) {
      named.push(part.trim());
    }
  }
  return { named, more };
}

/** The drain block a node's (or the rollout's) message reports; null for any other message. */
export function parseDrainBlock(message: string | undefined): DrainBlock | null {
  if (!message) {
    return null;
  }
  const block: DrainBlock = {
    pdbs: [],
    pdbMore: 0,
    bare: [],
    bareMore: 0,
    notCordoned: message.endsWith(NOT_CORDONED),
  };
  const pdb = message.match(/cannot be drained: (.*?) \(a single-instance CloudNativePG/);
  if (pdb) {
    for (const part of pdb[1].split(/;\s*/)) {
      const m = part.match(/^PDB (\S+) allows no disruption of pod (\S+)$/);
      const more = part.match(/^and (\d+) more$/);
      if (m) {
        block.pdbs.push({ pdb: m[1], pod: m[2] });
      } else if (more) {
        block.pdbMore = Number(more[1]);
      }
    }
  }
  const bare = message.match(
    /(?:runs pods that declare no controller|not evicted, they declare no controller): (.*?) \(/
  );
  if (bare) {
    const { named, more } = names(bare[1]);
    block.bare = named;
    block.bareMore = more;
  }
  return block.pdbs.length || block.pdbMore || block.bare.length || block.bareMore ? block : null;
}

export interface DrainBlockAdvice {
  severity: 'info' | 'warning';
  title: string;
  text: string;
  commands: Command[];
  links: DocLink[];
}

const plus = (more: number) => (more ? ` and ${more} more` : '');

function splitName(ref: string): [string, string] {
  const i = ref.indexOf('/');
  return i < 0 ? ['default', ref] : [ref.slice(0, i), ref.slice(i + 1)];
}

/** What to do about a blocked drain on node: what to delete or relax, the commands, the docs. */
export function drainBlockAdvice(block: DrainBlock, node: string): DrainBlockAdvice {
  const kubectl = 'with kubectl';
  const commands: Command[] = [
    {
      command: `kubectl get pods -A -o wide --field-selector spec.nodeName=${node}`,
      where: kubectl,
    },
  ];
  const text: string[] = [];
  const links: DocLink[] = [];
  if (block.pdbs.length || block.pdbMore) {
    const named = block.pdbs.map(p => `${p.pdb} allows no disruption of ${p.pod}`).join('; ');
    text.push(
      `A PodDisruptionBudget ${named}${plus(block.pdbMore)}, although every pod it expects is ` +
        'healthy: waiting changes nothing (a single-instance database such as CloudNativePG). ' +
        'Relax or delete the budget, or move the workload, and k4all-operator goes on.'
    );
    for (const p of block.pdbs) {
      const [ns, name] = splitName(p.pdb);
      commands.push({ command: `kubectl get pdb -n ${ns} ${name} -o yaml`, where: kubectl });
    }
    links.push({
      label: 'Drains that never end (docs/upgrades.md)',
      href: DRAINS_NEVER_END_DOC_URL,
    });
  }
  if (block.bare.length || block.bareMore) {
    text.push(
      `Pods that declare no controller (${block.bare.join(', ')}${plus(
        block.bareMore
      )}): a drain ` +
        'would delete them for good: nothing recreates them. Delete them, or recreate them under a ' +
        'controller (a Deployment, a StatefulSet, a Job…), and k4all-operator goes on.' +
        (block.notCordoned ? '' : ' The drain waits for them; it evicts the other pods meanwhile.')
    );
    for (const ref of block.bare) {
      const [ns, name] = splitName(ref);
      commands.push({ command: `kubectl delete pod -n ${ns} ${name}`, where: kubectl });
    }
    links.push({
      label: 'Pods that declare no controller (docs/upgrades.md)',
      href: BARE_PODS_DOC_URL,
    });
  }
  if (block.notCordoned) {
    text.push(`${node} is not cordoned meanwhile.`);
  }
  const pdbOnly = !(block.bare.length || block.bareMore);
  const bareOnly = !(block.pdbs.length || block.pdbMore);
  return {
    severity: block.notCordoned ? 'warning' : 'info',
    title: bareOnly
      ? `${node} runs pods that declare no controller`
      : pdbOnly || block.notCordoned
      ? `${node} cannot be drained`
      : `${node} cannot be drained yet`,
    text: text.join(' '),
    commands,
    links,
  };
}
