/*
 * Writes to the k4all custom resources. Every write is a JSON Patch with a
 * precondition, sent with fieldManager=k4all-headlamp and strict field
 * validation; settings changes are first sent as a server-side dry run.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { escapePointerToken } from '../model/objects';
import { annotationMergePatch, JsonPatchOp, precondition, writeQuery } from '../model/patch';
import {
  CLUSTER_UPGRADE_NAME,
  ClusterConfigObject,
  ClusterUpgradeObject,
  ComponentManagement,
  FORCE_RESYNC_ANNOTATION,
  ReleaseManifestObject,
  RETRY_ANNOTATION,
} from '../model/types';
import { apiPath, K4allResource } from './resources';

type Resource = K4allResource;

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

/** JSON Patch on the ClusterUpgrade "k4all" (spec writes, guarded by its generation). */
export function patchClusterUpgrade(
  ops: JsonPatchOp[],
  dryRun: boolean
): Promise<ClusterUpgradeObject> {
  return jsonPatch<ClusterUpgradeObject>('clusterupgrades', CLUSTER_UPGRADE_NAME, ops, dryRun);
}

export function getClusterUpgrade(): Promise<ClusterUpgradeObject> {
  return ApiProxy.request(
    apiPath('clusterupgrades', CLUSTER_UPGRADE_NAME)
  ) as Promise<ClusterUpgradeObject>;
}

/**
 * Asks the operator to retry the nodes whose hop failed: sets the retry
 * annotation (any value; a timestamp here), which the operator consumes. A
 * merge patch on that key only, like force-resync.
 */
export function retryClusterUpgrade(at: Date = new Date()): Promise<ClusterUpgradeObject> {
  return ApiProxy.request(
    `${apiPath('clusterupgrades', CLUSTER_UPGRADE_NAME)}?${writeQuery({ dryRun: false })}`,
    {
      method: 'PATCH',
      body: JSON.stringify(annotationMergePatch(RETRY_ANNOTATION, at.toISOString())),
      headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
    }
  ) as Promise<ClusterUpgradeObject>;
}
