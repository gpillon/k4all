/*
 * Writes to the k4all custom resources. Every write is a JSON Patch with a
 * precondition, sent with fieldManager=k4all-headlamp and strict field
 * validation; settings changes are first sent as a server-side dry run.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { escapePointerToken } from '../model/objects';
import { annotationMergePatch, JsonPatchOp, precondition, writeQuery } from '../model/patch';
import {
  ClusterConfigObject,
  ComponentManagement,
  FORCE_RESYNC_ANNOTATION,
  ReleaseManifestObject,
} from '../model/types';
import { apiPath } from './resources';

type Resource = 'clusterconfigs' | 'releasemanifests';

async function jsonPatch<T>(
  resource: Resource,
  name: string,
  ops: JsonPatchOp[],
  dryRun: boolean
): Promise<T> {
  return ApiProxy.request(`${apiPath(resource, name)}?${writeQuery({ dryRun })}`, {
    method: 'PATCH',
    body: JSON.stringify(ops),
    headers: { 'Content-Type': 'application/json-patch+json', Accept: 'application/json' },
  }) as Promise<T>;
}

export function patchClusterConfig(
  name: string,
  ops: JsonPatchOp[],
  dryRun: boolean
): Promise<ClusterConfigObject> {
  return jsonPatch<ClusterConfigObject>('clusterconfigs', name, ops, dryRun);
}

export function getClusterConfig(name: string): Promise<ClusterConfigObject> {
  return ApiProxy.request(apiPath('clusterconfigs', name)) as Promise<ClusterConfigObject>;
}

/**
 * Asks the operator to re-apply one component (or "all") through the
 * force-resync annotation. A merge patch: other annotations are left alone.
 */
export function forceResync(
  rm: ReleaseManifestObject,
  target: string
): Promise<ReleaseManifestObject> {
  return ApiProxy.request(
    `${apiPath('releasemanifests', rm.metadata.name)}?${writeQuery({ dryRun: false })}`,
    {
      method: 'PATCH',
      body: JSON.stringify(annotationMergePatch(FORCE_RESYNC_ANNOTATION, target)),
      headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
    }
  ) as Promise<ReleaseManifestObject>;
}

/**
 * Sets spec.components[component].management. Guarded by the ReleaseManifest
 * generation: a release sync between load and click makes it fail cleanly.
 */
export function setManagement(
  rm: ReleaseManifestObject,
  component: string,
  management: ComponentManagement
): Promise<ReleaseManifestObject> {
  const pointer = `/spec/components/${escapePointerToken(component)}/management`;
  const ops: JsonPatchOp[] = [precondition(rm), { op: 'add', path: pointer, value: management }];
  return jsonPatch('releasemanifests', rm.metadata.name, ops, false);
}
