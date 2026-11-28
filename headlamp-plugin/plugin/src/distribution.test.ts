/*
 * The ClusterRoles of distribution/rbac.yaml: every role can read what
 * every k4all page reads (a page without the ClusterConfig says "No
 * ClusterConfig"), the writes stay where they are, and no role reads a
 * Secret.
 */

import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
  verbs?: string[];
}
interface Doc {
  kind: string;
  metadata: { name: string };
  rules?: Rule[];
}

const docs = yaml
  .loadAll(fs.readFileSync(path.resolve('../distribution/rbac.yaml'), 'utf8'))
  .filter(Boolean) as Doc[];
const role = (name: string) => {
  const r = docs.find(d => d.kind === 'ClusterRole' && d.metadata.name === name);
  expect(r).toBeTruthy();
  return r!.rules ?? [];
};
const allows = (rules: Rule[], group: string, resource: string, verb: string, name?: string) =>
  rules.some(
    r =>
      (r.apiGroups ?? []).includes(group) &&
      (r.resources ?? []).includes(resource) &&
      (r.verbs ?? []).includes(verb) &&
      (!r.resourceNames || (name !== undefined && r.resourceNames.includes(name)))
  );

const ROLES = ['k4all-viewer', 'k4all-editor', 'k4all-upgrader'];
const K4ALL = 'k4all.magesgate.com';

describe('distribution/rbac.yaml', () => {
  it.each(ROLES)('%s reads every k4all resource and the nodes', name => {
    const rules = role(name);
    for (const resource of [
      'clusterconfigs',
      'releasemanifests',
      'nodeconfigs',
      'clusterupgrades',
    ]) {
      for (const verb of ['get', 'list', 'watch']) {
        expect([resource, verb, allows(rules, K4ALL, resource, verb)]).toEqual([
          resource,
          verb,
          true,
        ]);
      }
    }
    expect(allows(rules, '', 'nodes', 'list')).toBe(true);
  });

  it('keeps the writes where they were: settings for the editor, the ClusterUpgrade k4all for the upgrader', () => {
    expect(allows(role('k4all-editor'), K4ALL, 'clusterconfigs', 'patch')).toBe(true);
    const upgrader = role('k4all-upgrader');
    expect(allows(upgrader, K4ALL, 'clusterupgrades', 'patch', 'k4all')).toBe(true);
    expect(allows(upgrader, K4ALL, 'clusterconfigs', 'patch')).toBe(false);
    expect(allows(role('k4all-viewer'), K4ALL, 'clusterconfigs', 'patch')).toBe(false);
  });

  it.each(ROLES)('%s reads no Secret and does not patch the CephCluster', name => {
    const rules = role(name);
    expect(rules.some(r => (r.resources ?? []).some(x => x === 'secrets' || x === '*'))).toBe(
      false
    );
    expect(allows(rules, 'ceph.rook.io', 'cephclusters', 'patch')).toBe(false);
  });
});
