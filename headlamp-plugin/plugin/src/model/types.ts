/*
 * TypeScript mirror of the k4all-operator API (group k4all.magesgate.com,
 * version v1alpha1), as of k4all-operator v0.7.0 (api/v1alpha1/*.go, branch
 * release-v0.7.0): the v2.7.0 settings (features.virt.kubevirt, .hangar,
 * .metadata, features.rook, nodes) and status.nodes; from v0.7.0 upgrade
 * readiness and remediations (ClusterConfig spec.upgrades, the rollout's
 * approvals, blockers and records; ClusterUpgrade spec.approvals,
 * status.readiness, status.nodes[].blockers, status.remediations).
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

/**
 * KubeVirt settings k4all owns in the KubeVirt CR (operator v0.6.0). A field
 * left out is not owned: k4all writes nothing for it.
 */
export interface KubeVirtSettings {
  /** Gates k4all turns on, added to the ones others set (union). */
  featureGates?: string[];
  /** Gates k4all turns off: removed from featureGates, and on KubeVirt 1.8+ written to disabledFeatureGates. */
  disabledFeatureGates?: string[];
  /** StorageClass of the persistent VM state (EFI variables, TPM). */
  vmStateStorageClass?: string;
}

export interface HangarSettings {
  /** Hangar's privileged node agent; absent: the release default (installed with virt). */
  nodeAgent?: boolean;
}

export type MetadataScope = 'Labelled' | 'All';

export interface MetadataSettings {
  enabled?: boolean;
  /** "" means Labelled. */
  scope?: MetadataScope | string;
  tokens?: {
    audiences?: string[];
    /** At least 600 (kubelet's minimum for a projected token). */
    expirationSeconds?: number;
  };
  /** A ConfigMap in each VM's namespace with cloud-init vendor-data. */
  vendorDataConfigMap?: string;
}

export interface VirtConfig {
  enabled?: boolean;
  emulation?: EmulationMode | string;
  kubevirt?: KubeVirtSettings;
  hangar?: HangarSettings;
  metadata?: MetadataSettings;
}

export type RookSmallCluster = 'Refuse' | 'Allow';

export interface RookConfig {
  enabled?: boolean;
  /** Creation input: read once, when k4all creates the CephCluster. */
  storage?: { deviceFilter?: string };
  /** "" means Refuse. */
  smallCluster?: RookSmallCluster | string;
}

export type CPUManagerPolicy = 'none' | 'static';
export type TopologyManagerPolicy = 'none' | 'best-effort' | 'restricted' | 'single-numa-node';
export type TopologyManagerScope = 'container' | 'pod';

export interface KubeletSettings {
  /** 10 to 1000. */
  maxPods?: number;
  cpuManagerPolicy?: CPUManagerPolicy | string;
  /** A cpuset ("0-1"); required with the static CPU manager. */
  reservedSystemCPUs?: string;
  topologyManagerPolicy?: TopologyManagerPolicy | string;
  topologyManagerScope?: TopologyManagerScope | string;
}

/** Page sizes the operator accepts in nodes.hugepages. */
export const HUGEPAGE_SIZES = ['1Gi', '2Mi'] as const;
export type HugepageSize = (typeof HUGEPAGE_SIZES)[number];

export interface NodesConfig {
  kubelet?: KubeletSettings;
  /** Page size ("1Gi", "2Mi") to pages per node; a size left out is not owned. */
  hugepages?: Partial<Record<HugepageSize | string, number>>;
  iommu?: boolean;
  rollout?: {
    paused?: boolean;
    /**
     * Answers to the remediations the rollout's drains wait for (operator
     * v0.7.0). One for another settingsHash than status.nodes.settingsHash
     * is ignored.
     */
    approvals?: NodeRolloutApproval[];
  };
}

/**
 * How the operator's drains (ClusterUpgrade, node-settings rollout) treat
 * what the readiness check finds (operator v0.7.0).
 */
export interface UpgradesConfig {
  /** Mode of each remediation of the catalog, by id; left out: the catalog default (ask). */
  remediations?: Record<string, RemediationMode | string>;
}

export interface ClusterConfigSpec {
  networking?: {
    cni?: { type?: CNIType | string; cilium?: CiliumConfig };
    firewalld?: { enabled?: boolean };
  };
  features?: {
    virt?: VirtConfig;
    /** A pointer in Go: absent on clusters without Rook. */
    rook?: RookConfig;
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
  /** Node settings k4all owns, the same on every node (operator v0.6.0). */
  nodes?: NodesConfig;
  /** Remediation modes of the drains (operator v0.7.0). */
  upgrades?: UpgradesConfig;
}

/** status.nodes.rollout.phase values. */
export type NodeRolloutPhase = 'Idle' | 'Rolling' | 'Paused' | 'Blocked';

export interface NodesStatus {
  /** Hash of the node settings the nodes must have (spec.nodes and its action class). */
  settingsHash?: string;
  rollout?: { phase?: NodeRolloutPhase | string; currentNode?: string; message?: string };
  perNode?: {
    name: string;
    appliedHash?: string;
    phase?: string;
    message?: string;
    /** What holds this node's drain now (operator v0.7.0). */
    blockers?: Finding[];
  }[];
  /** What the rollout changed on other objects for a drain and must put back (operator v0.7.0). */
  remediations?: RemediationRecordStatus[];
}

/** ClusterConfig condition types besides Reconciled and Degraded (operator v0.6.0). */
export const CONDITION_POD_NETWORK_OVERLAP = 'PodNetworkOverlap';
export const CONDITION_KUBEVIRT_SETTINGS = 'KubeVirtSettings';
export const CONDITION_NODE_SETTINGS_ROLLOUT = 'NodeSettingsRollout';
export const CONDITION_ROOK_READY = 'RookReady';
export const CONDITION_METADATA_SERVICE = 'MetadataService';
/**
 * True while an entry of spec.upgrades.remediations is ignored (operator
 * v0.7.0): reason UnknownId or AutoNotAllowed, the message names the entries.
 */
export const CONDITION_UNKNOWN_REMEDIATION = 'UnknownRemediation';
export const REASON_UNKNOWN_REMEDIATION_ID = 'UnknownId';
export const REASON_AUTO_NOT_ALLOWED = 'AutoNotAllowed';

/** On the KubeVirt CR: the gates k4all added last time (comma-separated), R6 of the v2.7.0 spec. */
export const KUBEVIRT_GATES_ANNOTATION = 'k4all.magesgate.com/feature-gates';
export const KUBEVIRT_DISABLED_GATES_ANNOTATION = 'k4all.magesgate.com/disabled-feature-gates';

/** Node annotations of the node-settings rollout (operator and host agent). */
export const NODE_SETTINGS_TARGET_ANNOTATION = 'k4all.magesgate.com/node-settings-target';
export const NODE_SETTINGS_APPLIED_ANNOTATION = 'k4all.magesgate.com/node-settings-applied';
export const NODE_SETTINGS_MESSAGE_ANNOTATION = 'k4all.magesgate.com/node-settings-message';

/**
 * On kube-system/kubelet-config: k4all-operator's record of the node
 * settings, with what each kubelet field had before k4all first wrote it
 * ("prior": the value's text, null when the field was not there).
 */
export const NODE_SETTINGS_RECORD_ANNOTATION = 'k4all.magesgate.com/node-settings';

/** The VM template labels of the metadata service opt-in. */
export const METADATA_OPT_IN_LABEL = 'k4all.magesgate.com/metadata';
export const METADATA_SERVICE_ACCOUNT_LABEL = 'k4all.magesgate.com/service-account';

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
  /** Rollout of spec.nodes; absent until spec.nodes sets something. */
  nodes?: NodesStatus;
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
    /** cpu, memory, hugepages-1Gi, hugepages-2Mi, pods as quantities ("8", "16303412Ki"). */
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
    nodeInfo?: {
      kubeletVersion?: string;
      osImage?: string;
      containerRuntimeVersion?: string;
      kernelVersion?: string;
      architecture?: string;
    };
  };
}

// --------------------------------------------------------------- ClusterUpgrade

/** The only ClusterUpgrade; k4all-operator (v0.4.0+) creates it with an empty spec. */
export const CLUSTER_UPGRADE_NAME = 'k4all';
/** On the ClusterUpgrade: retry the nodes whose hop failed. The operator removes it. */
export const RETRY_ANNOTATION = 'k4all.magesgate.com/retry';
/**
 * On the ClusterUpgrade, any value: check the readiness again now, with
 * dry-run evictions (operator v0.7.0). The operator removes it after the check.
 */
export const CHECK_READINESS_ANNOTATION = 'k4all.magesgate.com/check-readiness';
/**
 * On the ClusterUpgrade, a remediation record id or "all": restore those
 * records now, for a node that will not come back (operator v0.7.0). The
 * operator removes it.
 */
export const RESTORE_ANNOTATION = 'k4all.magesgate.com/restore';
export const RESTORE_ALL = 'all';
/** The graph k4all-upgrade reads on the nodes, used when spec.graphUrl is empty. */
export const DEFAULT_UPGRADE_GRAPH_URL =
  'https://github.com/gpillon/k4all/releases/latest/download/upgrade-graph.json';

/** Node annotations of the protocol between k4all-operator and k4all-upgrade. */
export const NODE_RELEASE_ANNOTATION = 'k4all.magesgate.com/release';
export const NODE_TYPE_ANNOTATION = 'k4all.magesgate.com/node-type';
export const NODE_UPGRADE_PHASE_ANNOTATION = 'k4all.magesgate.com/upgrade-phase';
export const NODE_UPGRADE_MESSAGE_ANNOTATION = 'k4all.magesgate.com/upgrade-message';
export const NODE_UPGRADE_TARGET_ANNOTATION = 'k4all.magesgate.com/upgrade-target';

export type ClusterUpgradePhase = 'Idle' | 'Paused' | 'Progressing' | 'Succeeded' | 'Failed';
export type HopPhase = 'Done' | 'InProgress' | 'Pending';
export type NodeUpgradePhase = 'Pending' | 'Draining' | 'Upgrading' | 'Done' | 'Failed';

/**
 * Why a node failed, or what the upgrade waits for on it. Retry (the retry
 * annotation) acts on DrainTimeout and Abandoned only; a HOLD (HostHold,
 * TargetRejected, RollbackRebooted) goes on once resumed on the node;
 * NodeNotReady is not a failure.
 */
export type NodeUpgradeReason =
  | 'DrainTimeout'
  | 'HostHold'
  | 'Abandoned'
  | 'TargetRejected'
  | 'RollbackRebooted'
  | 'NodeNotReady'
  // operator v0.7.0
  | 'DrainBlocked'
  | 'WaitingForApproval'
  | 'Remediating'
  | 'Restoring'
  | 'RestoreFailed';

/** ClusterUpgrade condition types (k4all-operator v0.4.0). */
export const CONDITION_GRAPH_AVAILABLE = 'GraphAvailable';
export const CONDITION_PROGRESSING = 'Progressing';
export const CONDITION_SUCCEEDED = 'Succeeded';
export const CONDITION_FAILED = 'Failed';
/**
 * True while the next node waits on a blocker or an answer (operator
 * v0.7.0); reason DrainBlocked, WaitingForApproval, Remediating, Restoring,
 * RestoreFailed or CephNotHealthy.
 */
export const CONDITION_BLOCKED = 'Blocked';
/** True while an embedded readiness rule does not compile or fails (operator v0.7.0). */
export const CONDITION_RULES_INVALID = 'RulesInvalid';

export interface DrainSpec {
  /** Minutes to wait for the evictions (default 30). */
  timeoutMinutes?: number;
  /** Run the hop anyway when the drain times out. */
  continueOnTimeout?: boolean;
  /** Wait for an answer (an approval) also for findings that only disrupt (operator v0.7.0). */
  confirmDisruptions?: boolean;
}

export interface ClusterUpgradeSpec {
  /** Release to bring every node to; empty means none. Lowering or clearing stops after the current node. */
  targetRelease?: string;
  /** Upgrade graph; empty means the k4all release graph on GitHub. */
  graphUrl?: string;
  /** Stops the upgrade before the next node. */
  paused?: boolean;
  drain?: DrainSpec;
  /**
   * Answers to the remediations of the readiness report (operator v0.7.0).
   * One for another release than targetRelease is ignored.
   */
  approvals?: RemediationApproval[];
}

// ------------------------------------------- Readiness and remediations (v0.7.0)

/** Names an object of any kind; group "" is the core group, namespace "" a cluster-scoped object. */
export interface ObjectRef {
  group?: string;
  kind: string;
  namespace?: string;
  name: string;
}

/** auto: applied without asking (autoAllowed entries only); ask: once approved; off: report only. */
export type RemediationMode = 'auto' | 'ask' | 'off';
export type FindingSeverity = 'Blocks' | 'Disrupts' | 'Info';
export type RemediationRisk = 'None' | 'Downtime';
/** Apply runs the remediation; Accept goes on without it. Left out: Apply. */
export type ApprovalDecision = 'Apply' | 'Accept';
export type RemediationTrigger = 'approval' | 'auto';
export type RemediationPhase =
  | 'Applying'
  | 'Applied'
  | 'Restoring'
  | 'Restored'
  | 'Superseded'
  | 'Failed';

/** A remediation a finding offers, for one object. */
export interface RemediationOption {
  remediation: string;
  target: ObjectRef;
  /** The mode in effect: ClusterConfig spec.upgrades.remediations, else the catalog default. */
  mode: RemediationMode | string;
  risk: RemediationRisk | string;
  summary?: string;
}

/** One thing the readiness check found. */
export interface Finding {
  severity: FindingSeverity | string;
  /** PDBNeverAllows, CNPGSingleInstance, VMShutdown, ...: no enum, kinds come with rules. */
  kind: string;
  object: ObjectRef;
  message?: string;
  remediations?: RemediationOption[];
  /** Objects folded into an aggregated finding (Info). */
  count?: number;
}

export interface ReadinessSummary {
  blocks?: number;
  disrupts?: number;
  info?: number;
  /** VMs that shut down at least once in a hop. */
  vmShutdowns?: number;
  /** Of those, the VMs that start again only when their node is back. */
  vmsDownUntilNodeBack?: number;
}

export interface NodeReadiness {
  name: string;
  summary?: ReadinessSummary;
  /** What this node's drain and reboot would do, Blocks first. */
  findings?: Finding[];
  /** Findings left out over the cap (Info first). */
  truncated?: number;
}

/** What each node's drain and reboot would do now. */
export interface ReadinessReport {
  checkedAt?: string;
  /** targetRelease, else the newest of availableReleases. */
  release?: string;
  /** Hops of the path to release: every hop drains and reboots every node. */
  hops?: number;
  /** This check sent dry-run evictions. */
  dryRun?: boolean;
  summary?: ReadinessSummary;
  /** The report in one sentence. */
  message?: string;
  /** Findings about the whole cluster (Ceph health, nodes not Ready). */
  cluster?: Finding[];
  /** One entry per node, in upgrade order. */
  nodes?: NodeReadiness[];
}

/** A person's answer to one remediation of one object, for one upgrade. */
export interface RemediationApproval {
  remediation: string;
  target: ObjectRef;
  /** Only for this node's drain; empty: every node of the upgrade. */
  node?: string;
  decision?: ApprovalDecision | string;
  /** The targetRelease it was given for. */
  release: string;
}

/** The same answer for the node-settings rollout, bound to status.nodes.settingsHash. */
export interface NodeRolloutApproval {
  remediation: string;
  target: ObjectRef;
  node?: string;
  decision?: ApprovalDecision | string;
  /** 16 hex digits: the status.nodes.settingsHash it was given for. */
  settingsHash: string;
}

/** What k4all changed on an object for a drain and must put back (a view of the target's annotation). */
export interface RemediationRecordStatus {
  /** rm- and a short hash of remediation, target, node and hop. */
  id: string;
  remediation: string;
  target: ObjectRef;
  /** The node whose drain it was applied for. */
  node: string;
  /** The hop's release, or the node-settings rollout's change. */
  hop: string;
  by: RemediationTrigger | string;
  phase: RemediationPhase | string;
  appliedAt?: string;
  /** What k4all changed, or why it failed. */
  message?: string;
}

export interface Hop {
  release: string;
  kind?: 'minor' | 'patch' | string;
  phase: HopPhase | string;
  /** When the hop became InProgress. */
  startedAt?: string;
  /** When every node had run it. */
  completedAt?: string;
}

export interface ReleaseInfo {
  version: string;
  kind?: 'minor' | 'patch' | string;
  /** kubelet version in the image, e.g. "1.36.4". */
  kubernetes?: string;
  fedora?: number;
  notes?: string;
  /** The oldest release that may switch straight to this one. */
  minFrom?: string;
  /** CRI-O minor of the image. */
  crio?: string;
  /**
   * Only in availableReleases: the hops from currentRelease to this release,
   * as the operator plans them; empty when the graph has no way there.
   */
  path?: string[];
}

export interface NodeUpgradeStatus {
  name: string;
  /** bootstrap, control or worker: the upgrade order. */
  role?: string;
  /** Release the node runs (its last committed release). */
  release?: string;
  phase: NodeUpgradePhase | string;
  /** k4all-upgrade's phase on the node: PREFLIGHT ... COMMIT, HOLD, ABANDONED. */
  hostPhase?: string;
  message?: string;
  reason?: NodeUpgradeReason | string;
  /** When the operator cordoned the node for the current hop; a retry starts it over. */
  drainStartedAt?: string;
  /** When the operator started the node's latest hop (its cordon). */
  startedAt?: string;
  /** When the node finished its latest hop. */
  completedAt?: string;
  /** What holds this node now: findings that block, or that wait for an answer (operator v0.7.0). */
  blockers?: Finding[];
}

export interface ClusterUpgradeStatus {
  phase?: ClusterUpgradePhase | string;
  message?: string;
  /** The oldest release among the nodes. */
  currentRelease?: string;
  /** The graph's entry for currentRelease (Kubernetes, CRI-O, Fedora). */
  currentReleaseInfo?: ReleaseInfo;
  /** Release of the hop in progress. */
  currentHop?: string;
  path?: Hop[];
  /** Releases newer than currentRelease that targetRelease can name, oldest first. */
  availableReleases?: ReleaseInfo[];
  nodes?: NodeUpgradeStatus[];
  graphUrl?: string;
  observedGeneration?: number;
  conditions?: Condition[];
  /** What each node's drain and reboot would do now (operator v0.7.0). */
  readiness?: ReadinessReport;
  /** What k4all changed on other objects for a drain and must put back (operator v0.7.0). */
  remediations?: RemediationRecordStatus[];
}

export interface ClusterUpgradeObject {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec?: ClusterUpgradeSpec;
  status?: ClusterUpgradeStatus;
}

// ------------------------------------------------- Other APIs the pages read

/** The part of a KubeVirt CR (kubevirt.io/v1) the virtualization page reads. */
export interface KubeVirtLike {
  metadata: ObjectMeta & { namespace?: string };
  spec?: {
    configuration?: {
      developerConfiguration?: {
        featureGates?: string[];
        disabledFeatureGates?: string[];
        useEmulation?: boolean;
      };
      vmStateStorageClass?: string;
    };
  };
  status?: {
    observedKubeVirtVersion?: string;
    targetKubeVirtVersion?: string;
    phase?: string;
  };
}

/** The part of a StorageClass (storage.k8s.io/v1) the pages read. */
export interface StorageClassLike {
  metadata: ObjectMeta;
  provisioner?: string;
  volumeBindingMode?: string;
}

/** The part of a CDI StorageProfile (cdi.kubevirt.io/v1beta1): the access modes a StorageClass offers. */
export interface StorageProfileLike {
  metadata: ObjectMeta;
  status?: {
    claimPropertySets?: { accessModes?: string[]; volumeMode?: string }[];
  };
}

/** The part of a CephCluster (ceph.rook.io/v1) the storage page reads. */
export interface CephClusterLike {
  metadata: ObjectMeta & { namespace?: string };
  status?: { phase?: string; message?: string; state?: string; ceph?: { health?: string } };
}
