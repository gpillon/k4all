/*
 * TypeScript mirror of the k4all-operator API (group k4all.magesgate.com,
 * version v1alpha1), as of k4all-operator v0.3.0 (api/v1alpha1/*.go).
 *
 * Every field is optional: the operator's Go types use omitempty, so a field
 * the user never set is simply missing from the object the API server returns.
 */

export const K4ALL_GROUP = 'k4all.magesgate.com';
export const K4ALL_API_VERSION = 'v1alpha1';
export const K4ALL_GROUP_VERSION = `${K4ALL_GROUP}/${K4ALL_API_VERSION}`;

/** Set by k4all-upgrade on its Node while an OS/Kubernetes hop runs ("<from>-><to>"). */
export const UPGRADE_IN_PROGRESS_ANNOTATION = 'k4all.magesgate.com/upgrade-in-progress';
/** On the ReleaseManifest: component name, or "all", to re-apply. Removed by the operator. */
export const FORCE_RESYNC_ANNOTATION = 'k4all.magesgate.com/force-resync';
/** fieldManager used for every write, so managedFields show who changed what. */
export const FIELD_MANAGER = 'k4all-headlamp';

/** The names the k4all installer and the release use. */
export const DEFAULT_CLUSTER_CONFIG_NAME = 'k4all-cluster-config';
export const DEFAULT_RELEASE_MANIFEST_NAME = 'k4all';

export interface ObjectMeta {
  name: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown' | string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

// ---------------------------------------------------------------- ClusterConfig

export type CNIType = 'calico' | 'cilium';
export type HAType = 'none' | 'keepalived' | 'kubevip';
export type EmulationMode = 'true' | 'false' | 'auto';

export interface CiliumConfig {
  additionalDevices?: string[];
  l2announcements?: boolean;
  hubble?: boolean;
  gatewayAPI?: boolean;
}

export interface IngressControllerConfig {
  dedicatedIP?: string;
  isDefault?: boolean;
}

export interface ComponentOverride {
  /** Arbitrary Helm values, deep-merged over the ReleaseManifest values. */
  values?: Record<string, unknown>;
  /** "--set key=value" style arguments, applied after values. */
  helmArgs?: string[];
}

export interface ClusterConfigSpec {
  networking?: {
    cni?: { type?: CNIType | string; cilium?: CiliumConfig };
    firewalld?: { enabled?: boolean };
  };
  features?: {
    virt?: { enabled?: boolean; emulation?: EmulationMode | string };
    argocd?: { enabled?: boolean };
    ovsCni?: { enabled?: boolean };
    ovsBridge?: { enabled?: boolean };
  };
  cluster?: {
    apiEndPointUseHostName?: boolean;
    customApiEndPoint?: string;
    podNetwork?: string;
    serviceNetwork?: string;
    ha?: {
      interface?: string;
      type?: HAType | string;
      apiControlEndpoint?: string;
      apiControlEndpointSubnetSize?: string;
    };
  };
  ingress?: {
    nginx?: IngressControllerConfig;
    traefik?: IngressControllerConfig;
    cilium?: { dedicatedIP?: string };
  };
  proxy?: { httpProxy?: string; httpsProxy?: string; noProxy?: string };
  componentOverrides?: Record<string, ComponentOverride>;
}

export interface ClusterConfigStatus {
  conditions?: Condition[];
  observedGeneration?: number;
  activeCNI?: string;
  features?: {
    virtReady?: boolean;
    argocdReady?: boolean;
    ovsCniReady?: boolean;
    ovsBridgeReady?: boolean;
  };
  lastReconcileTime?: string;
}

export interface ClusterConfigObject {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec?: ClusterConfigSpec;
  status?: ClusterConfigStatus;
}

// -------------------------------------------------------------- ReleaseManifest

export type ComponentType = 'helm' | 'helm-oci' | 'manifest' | 'binary' | 'static-pod';
export type ComponentManagement = 'Managed' | 'Removed' | 'Unmanaged';
export type ComponentState =
  | 'Pending'
  | 'Installing'
  | 'Installed'
  | 'Upgrading'
  | 'Failed'
  | 'Uninstalling'
  | 'Skipped'
  | 'Removed'
  | 'Unmanaged';

export interface UpgradeStep {
  version: string;
  helmArgs?: string[];
  values?: Record<string, unknown>;
}

export interface ComponentSpec {
  type: ComponentType | string;
  management?: ComponentManagement | string;
  version: string;
  versionUrl?: string;
  repo?: string;
  chart?: string;
  source?: string;
  sources?: string[];
  namespace?: string;
  values?: Record<string, unknown>;
  valuesFrom?: { kind: string; name: string; namespace?: string; valuesKey?: string }[];
  helmArgs?: string[];
  installPath?: string;
  image?: string;
  dependsOn?: string[];
  patches?: unknown[];
  inlineManifests?: string[];
  custom?: Record<string, string>;
  upgradePath?: UpgradeStep[];
  featureGate?: string;
}

export interface ComponentStatus {
  state?: ComponentState | string;
  installedVersion?: string;
  appliedHash?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface ReleaseManifestObject {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec?: {
    osImage?: { name?: string; repository?: string; imageTag?: string };
    components?: Record<string, ComponentSpec>;
  };
  status?: {
    components?: Record<string, ComponentStatus>;
    conditions?: Condition[];
    resolvedOSImageTag?: string;
  };
}

// ------------------------------------------------------------------- NodeConfig

export interface NodeConfigObject {
  metadata: ObjectMeta;
  status?: {
    nodeName?: string;
    nodeType?: 'bootstrap' | 'control' | 'worker' | string;
    availableInterfaces?: { name: string; mac: string }[];
    networkInterface?: {
      state?: string;
      phase?: string;
      message?: string;
      lastUpdateTime?: string;
    };
  };
}

// ------------------------------------------------------------------------ Nodes

/** The part of a core/v1 Node the plugin reads. */
export interface NodeLike {
  metadata: ObjectMeta;
  spec?: { unschedulable?: boolean };
  status?: {
    addresses?: { type: string; address: string }[];
    conditions?: Condition[];
    nodeInfo?: {
      kubeletVersion?: string;
      osImage?: string;
      containerRuntimeVersion?: string;
      kernelVersion?: string;
      architecture?: string;
    };
  };
}
