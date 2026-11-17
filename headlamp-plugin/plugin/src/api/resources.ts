/*
 * Headlamp resource classes for the k4all custom resources. All three are
 * cluster-scoped. The plugin's model works on the plain JSON (jsonData).
 */

import { KubeObject, KubeObjectInterface } from '@kinvolk/headlamp-plugin/lib/k8s/cluster';
import {
  ClusterConfigObject,
  ClusterConfigSpec,
  ClusterConfigStatus,
  ClusterUpgradeObject,
  ClusterUpgradeSpec,
  ClusterUpgradeStatus,
  K4ALL_GROUP_VERSION,
  NodeConfigObject,
  ReleaseManifestObject,
} from '../model/types';

interface ClusterConfigJson extends KubeObjectInterface {
  spec?: ClusterConfigSpec;
  status?: ClusterConfigStatus;
}

interface ReleaseManifestJson extends KubeObjectInterface {
  spec?: ReleaseManifestObject['spec'];
  status?: ReleaseManifestObject['status'];
}

interface NodeConfigJson extends KubeObjectInterface {
  status?: NodeConfigObject['status'];
}

interface ClusterUpgradeJson extends KubeObjectInterface {
  spec?: ClusterUpgradeSpec;
  status?: ClusterUpgradeStatus;
}

export class ClusterConfig extends KubeObject<ClusterConfigJson> {
  static kind = 'ClusterConfig';
  static apiName = 'clusterconfigs';
  static apiVersion = K4ALL_GROUP_VERSION;
  static isNamespaced = false;

  get object(): ClusterConfigObject {
    return this.jsonData as ClusterConfigObject;
  }
}

export class ReleaseManifest extends KubeObject<ReleaseManifestJson> {
  static kind = 'ReleaseManifest';
  static apiName = 'releasemanifests';
  static apiVersion = K4ALL_GROUP_VERSION;
  static isNamespaced = false;

  get object(): ReleaseManifestObject {
    return this.jsonData as ReleaseManifestObject;
  }
}

export class NodeConfig extends KubeObject<NodeConfigJson> {
  static kind = 'NodeConfig';
  static apiName = 'nodeconfigs';
  static apiVersion = K4ALL_GROUP_VERSION;
  static isNamespaced = false;

  get object(): NodeConfigObject {
    return this.jsonData as NodeConfigObject;
  }
}

/** The singleton k4all-operator v0.4.0+ keeps, named k4all. */
export class ClusterUpgrade extends KubeObject<ClusterUpgradeJson> {
  static kind = 'ClusterUpgrade';
  static apiName = 'clusterupgrades';
  static apiVersion = K4ALL_GROUP_VERSION;
  static isNamespaced = false;

  get object(): ClusterUpgradeObject {
    return this.jsonData as ClusterUpgradeObject;
  }
}

export type K4allResource = 'clusterconfigs' | 'releasemanifests' | 'clusterupgrades';

export function apiPath(resource: K4allResource, name: string): string {
  return `/apis/${K4ALL_GROUP_VERSION}/${resource}/${encodeURIComponent(name)}`;
}
