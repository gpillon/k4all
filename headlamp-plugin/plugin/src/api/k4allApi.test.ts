/*
 * The ClusterUpgrade writes as they reach the API server: path, query
 * (field manager, strict validation, dry run), content type and body.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { vi } from 'vitest';
import { patchClusterUpgrade, retryClusterUpgrade } from './k4allApi';

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
