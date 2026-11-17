import { defaultClusterConfig } from './fixtures';
import { JsonObject, setIn } from './objects';
import { rebase, resolveConflicts } from './rebase';

const base = () => defaultClusterConfig().spec as JsonObject;

describe('rebase', () => {
  it('replays non-overlapping changes on top of the newer server spec', () => {
    const mine = setIn(base(), ['features', 'argocd', 'enabled'], true);
    const theirs = setIn(base(), ['ingress', 'cilium', 'dedicatedIP'], '192.168.1.50');
    const result = rebase(base(), mine, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual(
      setIn(
        setIn(base(), ['features', 'argocd', 'enabled'], true),
        ['ingress', 'cilium', 'dedicatedIP'],
        '192.168.1.50'
      )
    );
  });

  it('accepts the same change made on both sides', () => {
    const mine = setIn(base(), ['features', 'virt', 'enabled'], true);
    const result = rebase(base(), mine, mine);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual(mine);
  });

  it('reports a conflict when both sides changed the same field differently', () => {
    const mine = setIn(base(), ['ingress', 'traefik', 'dedicatedIP'], '192.168.1.240');
    const theirs = setIn(base(), ['ingress', 'traefik', 'dedicatedIP'], '192.168.1.241');
    const result = rebase(base(), mine, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      label: 'ingress.traefik.dedicatedIP',
      base: '',
      theirs: '192.168.1.241',
      mine: '192.168.1.240',
    });
    expect(resolveConflicts(result, 'mine')).toEqual(mine);
    expect(resolveConflicts(result, 'theirs')).toEqual(theirs);
  });

  it('treats a server-side removal of the parent as a conflict', () => {
    const mine = setIn(base(), ['ingress', 'traefik', 'isDefault'], false);
    const theirs = setIn(base(), ['ingress', 'traefik'], undefined);
    const result = rebase(base(), mine, theirs);
    expect(result.conflicts.map(c => c.label)).toEqual(['ingress.traefik.isDefault']);
  });

  it('detects an added subtree colliding with a nested change', () => {
    const start = setIn(base(), ['componentOverrides'], {});
    const mine = setIn(start, ['componentOverrides', 'traefik'], { helmArgs: ['--set a=1'] });
    const theirs = setIn(start, ['componentOverrides', 'traefik', 'values'], { b: 2 });
    expect(rebase(start, mine, theirs).conflicts.map(c => c.label)).toEqual([
      'componentOverrides.traefik',
    ]);
  });
});
