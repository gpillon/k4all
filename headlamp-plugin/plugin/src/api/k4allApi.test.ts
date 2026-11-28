/*
 * The ClusterUpgrade writes as they reach the API server: path, query
 * (field manager, strict validation, dry run), content type and body.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { vi } from 'vitest';
import {
  addClusterUpgradeApproval,
  addNodeRolloutApproval,
  checkClusterUpgradeReadiness,
  patchClusterUpgrade,
  restoreRemediation,
  retryClusterUpgrade,
  setNodeRolloutPaused,
} from './k4allApi';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn(async () => ({})) } }));
vi.mock('./resources', () => ({
  apiPath: (resource: string, name: string) =>
    `/apis/k4all.magesgate.com/v1alpha1/${resource}/${encodeURIComponent(name)}`,
}));

const request = vi.mocked(ApiProxy.request);

describe('ClusterUpgrade writes', () => {
  beforeEach(() => request.mockClear());

  it('sends a JSON Patch to clusterupgrades/k4all with the plugin field manager', async () => {
    const ops = [
      { op: 'test' as const, path: '/metadata/generation', value: 1 },
      { op: 'add' as const, path: '/spec/targetRelease', value: 'v2.7.0' },
    ];
    await patchClusterUpgrade(ops, true);
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/apis/k4all.magesgate.com/v1alpha1/clusterupgrades/k4all?fieldManager=k4all-headlamp&fieldValidation=Strict&dryRun=All'
    );
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json-patch+json'
    );
    expect(JSON.parse(init.body as string)).toEqual(ops);
  });

  it('asks for a retry with a merge patch on the retry annotation only', async () => {
    await retryClusterUpgrade(new Date('2026-11-17T12:00:00Z'));
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /clusterupgrades\/k4all\?fieldManager=k4all-headlamp&fieldValidation=Strict$/
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/merge-patch+json'
    );
    expect(JSON.parse(init.body as string)).toEqual({
      metadata: { annotations: { 'k4all.magesgate.com/retry': '2026-11-17T12:00:00.000Z' } },
    });
  });
});

describe('node-settings rollout pause', () => {
  beforeEach(() => request.mockReset());

  const cc = (generation: number, nodes?: unknown) => ({
    metadata: { name: 'k4all-cluster-config', generation },
    spec: { nodes },
  });

  it('patches spec.nodes.rollout.paused on the latest ClusterConfig, guarded by its generation', async () => {
    request.mockResolvedValueOnce(cc(4, { iommu: true })).mockResolvedValueOnce(cc(5));
    await setNodeRolloutPaused('k4all-cluster-config', true);
    expect(request.mock.calls[0][0]).toBe(
      '/apis/k4all.magesgate.com/v1alpha1/clusterconfigs/k4all-cluster-config'
    );
    const [url, init] = request.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(/clusterconfigs\/k4all-cluster-config\?fieldManager=k4all-headlamp/);
    expect(JSON.parse(init.body as string)).toEqual([
      { op: 'test', path: '/metadata/generation', value: 4 },
      { op: 'add', path: '/spec/nodes/rollout', value: { paused: true } },
    ]);
  });

  it('retries once on the newer object after a conflict, then gives up', async () => {
    const conflict = Object.assign(new Error('testing value /metadata/generation failed'), {
      status: 422,
    });
    request
      .mockResolvedValueOnce(cc(4, { rollout: { paused: true } }))
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(cc(6, { iommu: true, rollout: { paused: true } }))
      .mockResolvedValueOnce(cc(7));
    await setNodeRolloutPaused('k4all-cluster-config', false);
    expect(JSON.parse((request.mock.calls[3][1] as RequestInit).body as string)).toEqual([
      { op: 'test', path: '/metadata/generation', value: 6 },
      { op: 'remove', path: '/spec/nodes/rollout' },
    ]);
    request
      .mockResolvedValueOnce(cc(4, {}))
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(cc(5, {}))
      .mockRejectedValueOnce(conflict);
    await expect(setNodeRolloutPaused('k4all-cluster-config', true)).rejects.toBe(conflict);
  });

  it('sends nothing when the rollout is already in that state', async () => {
    request.mockResolvedValueOnce(cc(4, { rollout: { paused: true } }));
    await setNodeRolloutPaused('k4all-cluster-config', true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('upgrade readiness writes (operator v0.7.0)', () => {
  beforeEach(() => request.mockReset());

  const body = (i: number) => JSON.parse((request.mock.calls[i][1] as RequestInit).body as string);
  const contentType = (i: number) =>
    ((request.mock.calls[i][1] as RequestInit).headers as Record<string, string>)['Content-Type'];

  it('asks for a new check with a merge patch on the check-readiness annotation only', async () => {
    request.mockResolvedValueOnce({});
    await checkClusterUpgradeReadiness(new Date('2026-11-17T12:00:00Z'));
    expect(request.mock.calls[0][0]).toMatch(
      /clusterupgrades\/k4all\?fieldManager=k4all-headlamp&fieldValidation=Strict$/
    );
    expect(contentType(0)).toBe('application/merge-patch+json');
    expect(body(0)).toEqual({
      metadata: {
        annotations: { 'k4all.magesgate.com/check-readiness': '2026-11-17T12:00:00.000Z' },
      },
    });
  });

  it('puts one record back with the restore annotation set to its id', async () => {
    request.mockResolvedValueOnce({});
    await restoreRemediation('rm-4c1f9a');
    expect(contentType(0)).toBe('application/merge-patch+json');
    expect(body(0)).toEqual({
      metadata: { annotations: { 'k4all.magesgate.com/restore': 'rm-4c1f9a' } },
    });
  });

  const approval = {
    remediation: 'cnpg-disable-pdb',
    target: { group: 'postgresql.cnpg.io', kind: 'Cluster', namespace: 'db', name: 'app-pg' },
    decision: 'Apply',
    release: 'v2.6.0',
  };

  it('adds one approval: an append on the latest ClusterUpgrade', async () => {
    request
      .mockResolvedValueOnce({
        metadata: { name: 'k4all', generation: 3 },
        spec: { targetRelease: 'v2.6.0', approvals: [{ ...approval, remediation: 'x' }] },
      })
      .mockResolvedValueOnce({});
    await addClusterUpgradeApproval(approval);
    expect(request.mock.calls[0][0]).toBe(
      '/apis/k4all.magesgate.com/v1alpha1/clusterupgrades/k4all'
    );
    expect(contentType(1)).toBe('application/json-patch+json');
    expect(request.mock.calls[1][0]).toMatch(/fieldManager=k4all-headlamp&fieldValidation=Strict$/);
    expect(body(1)).toEqual([{ op: 'add', path: '/spec/approvals/-', value: approval }]);
  });

  it('creates the list under a generation test, and rebuilds once on a conflict', async () => {
    const conflict = Object.assign(new Error('testing value /metadata/generation failed'), {
      status: 422,
    });
    request
      .mockResolvedValueOnce({
        metadata: { name: 'k4all', generation: 3 },
        spec: { targetRelease: 'v2.6.0' },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        metadata: { name: 'k4all', generation: 4 },
        spec: { targetRelease: 'v2.6.0', approvals: [] },
      })
      .mockResolvedValueOnce({});
    await addClusterUpgradeApproval(approval);
    expect(body(1)).toEqual([
      { op: 'test', path: '/metadata/generation', value: 3 },
      { op: 'add', path: '/spec/approvals', value: [approval] },
    ]);
    expect(body(3)).toEqual([{ op: 'add', path: '/spec/approvals/-', value: approval }]);
  });

  it("adds a rollout approval to the ClusterConfig's spec.nodes.rollout.approvals", async () => {
    const a = { ...approval, release: undefined, settingsHash: '0123456789abcdef' };
    request
      .mockResolvedValueOnce({
        metadata: { name: 'k4all-cluster-config', generation: 9 },
        spec: { nodes: { iommu: true, rollout: { paused: true } } },
      })
      .mockResolvedValueOnce({});
    await addNodeRolloutApproval('k4all-cluster-config', a);
    expect(request.mock.calls[1][0]).toMatch(/clusterconfigs\/k4all-cluster-config\?fieldManager=/);
    expect(body(1)).toEqual([
      { op: 'test', path: '/metadata/generation', value: 9 },
      { op: 'add', path: '/spec/nodes/rollout/approvals', value: [a] },
    ]);
  });
});
