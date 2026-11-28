/*
 * Writes to the k4all custom resources. Every write is a JSON Patch with a
 * precondition, sent with fieldManager=k4all-headlamp and strict field
 * validation; settings changes are first sent as a server-side dry run.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { classifyError } from '../model/errors';
import { withRolloutPaused } from '../model/nodeSettings';
import { escapePointerToken, Path } from '../model/objects';
import {
  annotationMergePatch,
  buildSpecPatch,
  JsonPatchOp,
  precondition,
  Versioned,
  writeQuery,
} from '../model/patch';
import { addApprovalOps, AnyApproval } from '../model/readiness';
import {
  CHECK_READINESS_ANNOTATION,
  CLUSTER_UPGRADE_NAME,
  ClusterConfigObject,
  ClusterUpgradeObject,
  ComponentManagement,
  FORCE_RESYNC_ANNOTATION,
  NodeRolloutApproval,
  ReleaseManifestObject,
  RemediationApproval,
  RESTORE_ANNOTATION,
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
 * Pauses or resumes the node-settings rollout (spec.nodes.rollout.paused) at
 * once, outside any settings draft, like Pause on the Upgrades page: a JSON
 * Patch of that field on the latest ClusterConfig, guarded by its generation,
 * rebuilt and sent again once when someone saved in between.
 */
export async function setNodeRolloutPaused(
  name: string,
  paused: boolean
): Promise<ClusterConfigObject> {
  for (let attempt = 0; ; attempt++) {
    const cc = await getClusterConfig(name);
    const ops = buildSpecPatch(cc, withRolloutPaused(cc.spec ?? {}, paused));
    if (ops.length === 0) {
      return cc;
    }
    try {
      return await patchClusterConfig(name, ops, false);
    } catch (err) {
      if (attempt > 0 || classifyError(err).kind !== 'conflict') {
        throw err;
      }
    }
  }
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

/** Sets one annotation on the ClusterUpgrade "k4all" (a merge patch on that key only). */
function annotateClusterUpgrade(key: string, value: string): Promise<ClusterUpgradeObject> {
  return ApiProxy.request(
    `${apiPath('clusterupgrades', CLUSTER_UPGRADE_NAME)}?${writeQuery({ dryRun: false })}`,
    {
      method: 'PATCH',
      body: JSON.stringify(annotationMergePatch(key, value)),
      headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
    }
  ) as Promise<ClusterUpgradeObject>;
}

/**
 * Asks the operator to retry the nodes whose hop failed: sets the retry
 * annotation (any value; a timestamp here), which the operator consumes. A
 * merge patch on that key only, like force-resync.
 */
export function retryClusterUpgrade(at: Date = new Date()): Promise<ClusterUpgradeObject> {
  return annotateClusterUpgrade(RETRY_ANNOTATION, at.toISOString());
}

/**
 * Asks the operator for a new readiness check, with dry-run evictions
 * (operator v0.7.0): the check-readiness annotation, any value (a
 * timestamp here). The operator removes it after the check.
 */
export function checkClusterUpgradeReadiness(at: Date = new Date()): Promise<ClusterUpgradeObject> {
  return annotateClusterUpgrade(CHECK_READINESS_ANNOTATION, at.toISOString());
}

/**
 * Asks the operator to put back a remediation record now, whatever its
 * node's state (operator v0.7.0): the restore annotation, the record id.
 */
export function restoreRemediation(id: string): Promise<ClusterUpgradeObject> {
  return annotateClusterUpgrade(RESTORE_ANNOTATION, id);
}

/**
 * Adds one approval to a list of approvals on the latest object (addApprovalOps):
 * an append, or the list created under a generation test; built once more
 * on the newer object when someone saved in between.
 */
async function appendApproval<T extends Versioned & { spec?: unknown }>(
  get: () => Promise<T>,
  patch: (ops: JsonPatchOp[]) => Promise<T>,
  path: Path,
  approval: AnyApproval
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const obj = await get();
    const ops = addApprovalOps(obj, path, approval);
    if (ops.length === 0) {
      return obj;
    }
    try {
      return await patch(ops);
    } catch (err) {
      if (attempt > 0 || classifyError(err).kind !== 'conflict') {
        throw err;
      }
    }
  }
}

/** Apply fix / Accept on the upgrade: one approval more in spec.approvals (operator v0.7.0). */
export function addClusterUpgradeApproval(
  approval: RemediationApproval
): Promise<ClusterUpgradeObject> {
  return appendApproval(
    getClusterUpgrade,
    ops => patchClusterUpgrade(ops, false),
    ['spec', 'approvals'],
    approval
  );
}

/** Apply fix / Accept on the node-settings rollout: spec.nodes.rollout.approvals (operator v0.7.0). */
export function addNodeRolloutApproval(
  name: string,
  approval: NodeRolloutApproval
): Promise<ClusterConfigObject> {
  return appendApproval(
    () => getClusterConfig(name),
    ops => patchClusterConfig(name, ops, false),
    ['spec', 'nodes', 'rollout', 'approvals'],
    approval
  );
}

// ------------------------------------------- Ingresses still on the nginx class

function ingressPath(namespace: string, name: string): string {
  return `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(
    namespace
  )}/ingresses/${encodeURIComponent(name)}`;
}

/** JSON Patch on an Ingress (planMoveToTraefik), guarded by its generation. */
export function patchIngress(
  namespace: string,
  name: string,
  ops: JsonPatchOp[],
  dryRun: boolean
): Promise<unknown> {
  return ApiProxy.request(`${ingressPath(namespace, name)}?${writeQuery({ dryRun })}`, {
    method: 'PATCH',
    body: JSON.stringify(ops),
    headers: { 'Content-Type': 'application/json-patch+json', Accept: 'application/json' },
  });
}

/** Sets one annotation on a Service (merge patch on that key only). */
export function annotateService(
  namespace: string,
  name: string,
  key: string,
  value: string,
  dryRun: boolean
): Promise<unknown> {
  return ApiProxy.request(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(
      name
    )}?${writeQuery({ dryRun })}`,
    {
      method: 'PATCH',
      body: JSON.stringify(annotationMergePatch(key, value)),
      headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
    }
  );
}
