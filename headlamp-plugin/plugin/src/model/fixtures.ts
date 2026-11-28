/*
 * Test fixtures shaped like real k4all clusters: the installer's default
 * ClusterConfig and a subset of k4all-release.yaml, for a v2.6.0 cluster
 * (Traefik, as from v2.4.0; its operator kept at v0.3.0, so the
 * compatibility paths for older operators stay covered) and a v2.4.0
 * cluster that kept ingress-nginx (operator v0.5.0).
 */

import {
  ClusterConfigObject,
  ClusterUpgradeObject,
  Finding,
  KubeVirtLike,
  NodeLike,
  ObjectRef,
  ReleaseInfo,
  ReleaseManifestObject,
} from './types';

export function defaultClusterConfig(): ClusterConfigObject {
  return {
    apiVersion: 'k4all.magesgate.com/v1alpha1',
    kind: 'ClusterConfig',
    metadata: { name: 'k4all-cluster-config', generation: 3, resourceVersion: '4711' },
    spec: {
      networking: { cni: { type: 'calico' }, firewalld: { enabled: false } },
      features: {
        virt: { enabled: false, emulation: 'auto' },
        argocd: { enabled: false },
        ovsCni: { enabled: false },
        ovsBridge: { enabled: true },
      },
      cluster: {
        apiEndPointUseHostName: false,
        customApiEndPoint: '',
        podNetwork: '10.100.0.1/18',
        serviceNetwork: '10.96.0.0/16',
        ha: {
          interface: 'auto',
          type: 'none',
          apiControlEndpoint: '',
          apiControlEndpointSubnetSize: '',
        },
      },
      ingress: { traefik: { dedicatedIP: '', isDefault: true }, cilium: { dedicatedIP: '' } },
      proxy: { httpProxy: '', httpsProxy: '', noProxy: '' },
      componentOverrides: {},
    },
    status: {
      observedGeneration: 3,
      activeCNI: 'calico',
      lastReconcileTime: '2026-11-17T10:00:00Z',
      conditions: [{ type: 'Reconciled', status: 'True', reason: 'Synced' }],
    },
  };
}

export function releaseManifest(): ReleaseManifestObject {
  return {
    apiVersion: 'k4all.magesgate.com/v1alpha1',
    kind: 'ReleaseManifest',
    metadata: { name: 'k4all', generation: 7, resourceVersion: '900' },
    spec: {
      osImage: {
        name: 'k4all-bootc',
        repository: 'ghcr.io/gpillon/k4all-bootc',
        imageTag: 'v2.6.0-amd64',
      },
      components: {
        calico: { type: 'manifest', version: 'v3.33.1', upgradePath: [{ version: 'v3.32.4' }] },
        cilium: { type: 'helm-oci', version: '1.20.4', dependsOn: ['gateway-api'] },
        'cilium-cli': { type: 'binary', version: 'v0.20.3', dependsOn: ['cilium'] },
        metallb: { type: 'manifest', version: 'v0.16.2', dependsOn: ['calico', 'cilium'] },
        'gateway-api': { type: 'manifest', version: 'v1.6.3' },
        'kube-vip': { type: 'static-pod', version: 'v1.3.1' },
        'ingress-nginx': {
          type: 'helm',
          version: '4.14.3',
          management: 'Removed',
          dependsOn: ['cert-manager', 'metallb'],
        },
        traefik: { type: 'helm', version: '42.4.0', dependsOn: ['cert-manager', 'metallb'] },
        'cert-manager': {
          type: 'helm',
          version: 'v1.21.3',
          dependsOn: ['calico', 'cilium'],
          upgradePath: [
            { version: 'v1.15.5' },
            { version: 'v1.16.5' },
            { version: 'v1.17.4' },
            { version: 'v1.18.6' },
            { version: 'v1.19.6' },
            { version: 'v1.20.5' },
          ],
        },
        headlamp: { type: 'helm', version: '0.46.0', dependsOn: ['cert-manager', 'traefik'] },
        kubevirt: { type: 'manifest', version: 'v1.9.1', featureGate: 'virt' },
        virtctl: {
          type: 'binary',
          version: 'v1.9.1',
          featureGate: 'virt',
          dependsOn: ['kubevirt'],
        },
        cdi: { type: 'manifest', version: 'v1.66.1', featureGate: 'virt', dependsOn: ['kubevirt'] },
        hangar: {
          type: 'manifest',
          version: 'v0.1.1',
          featureGate: 'virt',
          dependsOn: ['kubevirt', 'cdi'],
        },
        'hangar-node-agent': {
          type: 'manifest',
          version: 'v0.1.1',
          featureGate: 'virt',
          dependsOn: ['kubevirt'],
        },
        'kubevirt-manager': {
          type: 'manifest',
          management: 'Removed',
          version: 'v1.5.4',
          featureGate: 'virt',
        },
        cairn: { type: 'manifest', version: 'v0.1.1', featureGate: 'rook' },
        argocd: {
          type: 'helm',
          version: '10.18.0',
          featureGate: 'argocd',
          dependsOn: ['calico', 'cilium', 'traefik'],
        },
        'multus-cni': {
          type: 'manifest',
          version: 'v4.3.2',
          featureGate: 'ovsCni',
          dependsOn: ['calico', 'cilium'],
        },
        'ovs-cni': {
          type: 'manifest',
          version: 'v0.40.0',
          featureGate: 'ovsCni',
          dependsOn: ['multus-cni'],
        },
        'k4all-operator': { type: 'manifest', version: 'v0.3.0' },
      },
    },
    status: {
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'AllComponentsReconciled',
          message: '9/9 components installed',
        },
      ],
      components: {
        calico: { state: 'Installed', installedVersion: 'v3.33.1' },
        metallb: { state: 'Installed', installedVersion: 'v0.16.2' },
        'gateway-api': { state: 'Installed', installedVersion: 'v1.6.3' },
        'ingress-nginx': { state: 'Removed' },
        traefik: { state: 'Installed', installedVersion: '42.4.0' },
        'cert-manager': { state: 'Upgrading', installedVersion: 'v1.17.4' },
        headlamp: { state: 'Installed', installedVersion: '0.46.0' },
        kubevirt: { state: 'Skipped' },
        'k4all-operator': { state: 'Installed', installedVersion: 'v0.3.0' },
      },
    },
  };
}

export function node(
  name: string,
  extra: Partial<NodeLike['metadata']> = {},
  ip = '192.168.1.10'
): NodeLike {
  return {
    metadata: { name, labels: { 'node-role.kubernetes.io/control-plane': '' }, ...extra },
    status: {
      addresses: [{ type: 'InternalIP', address: ip }],
      conditions: [{ type: 'Ready', status: 'True' }],
      nodeInfo: {
        kubeletVersion: 'v1.36.2',
        osImage: 'Fedora Linux 45',
        containerRuntimeVersion: 'cri-o://1.36.0',
      },
    },
  };
}

/**
 * A v2.4.0 cluster that still runs ingress-nginx: its ReleaseManifest was
 * changed by hand to keep it, without Traefik (k4all's own has Traefik and
 * ingress-nginx Removed from v2.4.0, the first release with the plugin). The
 * ClusterConfig has spec.ingress.nginx only, as on clusters installed before
 * v2.4.0. Operator v0.5.0, as v2.4.0 pins it.
 */
export function clusterConfigNginx(): ClusterConfigObject {
  const cc = defaultClusterConfig();
  cc.spec!.ingress = { nginx: { dedicatedIP: '', isDefault: true }, cilium: { dedicatedIP: '' } };
  return cc;
}

export function releaseManifestNginx(): ReleaseManifestObject {
  const rm = releaseManifest();
  const components = rm.spec!.components!;
  delete components.traefik;
  components['ingress-nginx'] = {
    type: 'helm',
    version: '4.14.3',
    dependsOn: ['cert-manager', 'metallb'],
  };
  components['k4all-operator'] = { type: 'manifest', version: 'v0.5.0' };
  rm.spec!.osImage!.imageTag = 'v2.4.0-amd64';
  const status = rm.status!.components!;
  delete status.traefik;
  status['ingress-nginx'] = { state: 'Installed', installedVersion: '4.14.3' };
  status['k4all-operator'] = { state: 'Installed', installedVersion: 'v0.5.0' };
  return rm;
}

/** The ReleaseManifest as k4all v2.4.0 leaves it: Traefik, ingress-nginx Removed, operator v0.5.0. */
export function releaseManifestV240(): ReleaseManifestObject {
  const rm = releaseManifest();
  rm.spec!.osImage!.imageTag = 'v2.4.0-amd64';
  rm.spec!.components!['k4all-operator'] = { type: 'manifest', version: 'v0.5.0' };
  rm.status!.components!['k4all-operator'] = { state: 'Installed', installedVersion: 'v0.5.0' };
  return rm;
}

/**
 * The ReleaseManifest of k4all v2.7.0 (operator v0.6.0): Hangar and Cairn,
 * Rook/Ceph behind the rook gate, the snapshot controller, the metadata
 * service, kubevirt-manager Removed.
 */
export function releaseManifestV270(): ReleaseManifestObject {
  const rm = releaseManifest();
  rm.spec!.osImage!.imageTag = 'v2.7.0-amd64';
  const components = rm.spec!.components!;
  components['rook-ceph'] = {
    type: 'helm',
    version: '1.21.2',
    featureGate: 'rook',
    dependsOn: ['calico', 'cilium'],
  };
  components['ceph-csi-drivers'] = {
    type: 'helm',
    version: '1.1.0',
    featureGate: 'rook',
    dependsOn: ['rook-ceph'],
  };
  components['snapshot-controller'] = {
    type: 'manifest',
    version: 'v8.4.0',
    featureGate: 'snapshots',
    dependsOn: ['calico', 'cilium'],
  };
  components['k4all-metadata'] = {
    type: 'manifest',
    version: 'v0.6.0',
    featureGate: 'virtMetadata',
    dependsOn: ['kubevirt'],
  };
  components['k4all-operator'] = { type: 'manifest', version: 'v0.6.0' };
  rm.status!.components!['k4all-operator'] = { state: 'Installed', installedVersion: 'v0.6.0' };
  return rm;
}

/** A k4all v2.7.0 ClusterConfig after the hop from v2.6.x: virt on, none of the new fields set. */
export function clusterConfigV270(): ClusterConfigObject {
  const cc = defaultClusterConfig();
  cc.spec!.features!.virt = { enabled: true, emulation: 'auto' };
  return cc;
}

/** A Node with capacity: cpus logical CPUs, memory in GiB. */
export function nodeWithCapacity(
  name: string,
  cpus: number,
  memoryGi: number,
  opts: { worker?: boolean; type?: string; hugepages1Gi?: string } = {}
): NodeLike {
  const n = node(
    name,
    {
      labels: opts.worker ? {} : { 'node-role.kubernetes.io/control-plane': '' },
      annotations: opts.type ? { 'k4all.magesgate.com/node-type': opts.type } : undefined,
    },
    '192.168.1.' + (10 + name.length)
  );
  n.status!.capacity = {
    cpu: String(cpus),
    memory: `${memoryGi * 1024 * 1024}Ki`,
    'hugepages-1Gi': opts.hugepages1Gi ?? '0',
    'hugepages-2Mi': '0',
    pods: '110',
  };
  return n;
}

/** The KubeVirt CR of a cluster running KubeVirt version (developerConfiguration lists, k4all annotations). */
export function kubevirtCR(
  version = 'v1.9.1',
  opts: {
    featureGates?: string[];
    disabledFeatureGates?: string[];
    k4allOn?: string;
    k4allOff?: string;
    vmStateStorageClass?: string;
  } = {}
): KubeVirtLike {
  const annotations: Record<string, string> = {};
  if (opts.k4allOn !== undefined) {
    annotations['k4all.magesgate.com/feature-gates'] = opts.k4allOn;
  }
  if (opts.k4allOff !== undefined) {
    annotations['k4all.magesgate.com/disabled-feature-gates'] = opts.k4allOff;
  }
  return {
    metadata: { name: 'kubevirt', namespace: 'kubevirt', annotations },
    spec: {
      configuration: {
        developerConfiguration: {
          featureGates: opts.featureGates,
          disabledFeatureGates: opts.disabledFeatureGates,
        },
        vmStateStorageClass: opts.vmStateStorageClass,
      },
    },
    status: { observedKubeVirtVersion: version, phase: 'Deployed' },
  };
}

/** The fixture graph: a linear ladder, every release one hop after the previous one. */
const LADDER: ReleaseInfo[] = [
  {
    version: 'v2.4.0',
    kind: 'minor',
    minFrom: 'v2.3.0',
    kubernetes: '1.35.10',
    crio: '1.35',
    fedora: 43,
  },
  {
    version: 'v2.4.1',
    kind: 'patch',
    minFrom: 'v2.4.0',
    kubernetes: '1.35.10',
    crio: '1.35',
    fedora: 43,
    notes: 'Fixes.',
  },
  {
    version: 'v2.5.0',
    kind: 'minor',
    minFrom: 'v2.4.1',
    kubernetes: '1.35.10',
    crio: '1.35',
    fedora: 45,
    notes: 'Fedora 45.',
  },
  {
    version: 'v2.6.0',
    kind: 'minor',
    minFrom: 'v2.5.0',
    kubernetes: '1.36.4',
    crio: '1.36',
    fedora: 45,
    notes: 'Kubernetes 1.36.',
  },
  {
    version: 'v2.7.0',
    kind: 'minor',
    minFrom: 'v2.6.0',
    kubernetes: '1.36.4',
    crio: '1.36',
    fedora: 45,
    notes: 'Unattended join.',
  },
];

/** The releases newer than current, as the operator lists them (oldest first, with their path). */
export function availableReleases(current = 'v2.4.0'): ReleaseInfo[] {
  const start = LADDER.findIndex(r => r.version === current);
  return LADDER.slice(start + 1).map((r, i, newer) => ({
    ...r,
    path: newer.slice(0, i + 1).map(h => h.version),
  }));
}

export function releaseInfo(version: string): ReleaseInfo {
  return { ...LADDER.find(r => r.version === version)! };
}

/** The ClusterUpgrade as the operator keeps it on an idle three-node v2.4.0 cluster. */
export function clusterUpgrade(extra: Partial<ClusterUpgradeObject> = {}): ClusterUpgradeObject {
  return {
    apiVersion: 'k4all.magesgate.com/v1alpha1',
    kind: 'ClusterUpgrade',
    metadata: { name: 'k4all', generation: 1, resourceVersion: '50' },
    spec: { drain: { timeoutMinutes: 30 } },
    status: {
      phase: 'Idle',
      currentRelease: 'v2.4.0',
      currentReleaseInfo: releaseInfo('v2.4.0'),
      availableReleases: availableReleases('v2.4.0'),
      nodes: [
        { name: 'cp-1', role: 'bootstrap', release: 'v2.4.0', phase: 'Done' },
        { name: 'cp-2', role: 'control', release: 'v2.4.0', phase: 'Done' },
        { name: 'w-1', role: 'worker', release: 'v2.4.0', phase: 'Done' },
      ],
      graphUrl: 'https://github.com/gpillon/k4all/releases/latest/download/upgrade-graph.json',
      observedGeneration: 1,
      conditions: [
        {
          type: 'GraphAvailable',
          status: 'True',
          reason: 'Read',
          message: 'https://github.com/gpillon/k4all/releases/latest/download/upgrade-graph.json',
        },
        { type: 'Progressing', status: 'False', reason: 'Idle' },
        { type: 'Succeeded', status: 'False', reason: 'Idle' },
        { type: 'Failed', status: 'False', reason: 'Idle' },
      ],
    },
    ...extra,
  };
}

/** The same cluster upgrading to v2.6.0: hop v2.5.0 in progress, cp-2 draining. */
export function clusterUpgradeInProgress(): ClusterUpgradeObject {
  const cu = clusterUpgrade();
  cu.metadata.generation = 2;
  cu.spec = { targetRelease: 'v2.6.0', drain: { timeoutMinutes: 30 } };
  cu.status = {
    ...cu.status,
    phase: 'Progressing',
    message: 'v2.5.0: draining cp-2, 3 pods left',
    currentHop: 'v2.5.0',
    path: [
      {
        release: 'v2.4.1',
        kind: 'patch',
        phase: 'Done',
        startedAt: '2026-11-17T09:00:00Z',
        completedAt: '2026-11-17T09:27:00Z',
      },
      { release: 'v2.5.0', kind: 'minor', phase: 'InProgress', startedAt: '2026-11-17T09:30:00Z' },
      { release: 'v2.6.0', kind: 'minor', phase: 'Pending' },
    ],
    currentRelease: 'v2.4.1',
    currentReleaseInfo: releaseInfo('v2.4.1'),
    availableReleases: availableReleases('v2.4.1'),
    nodes: [
      {
        name: 'cp-1',
        role: 'bootstrap',
        release: 'v2.5.0',
        phase: 'Done',
        startedAt: '2026-11-17T09:30:00Z',
        completedAt: '2026-11-17T09:41:00Z',
      },
      {
        name: 'cp-2',
        role: 'control',
        release: 'v2.4.1',
        phase: 'Draining',
        message: '3 pods left',
        drainStartedAt: '2026-11-17T10:00:00Z',
        startedAt: '2026-11-17T10:00:00Z',
      },
      {
        name: 'w-1',
        role: 'worker',
        release: 'v2.4.1',
        phase: 'Pending',
        startedAt: '2026-11-17T09:15:00Z',
        completedAt: '2026-11-17T09:27:00Z',
      },
    ],
    observedGeneration: 2,
    conditions: [
      {
        type: 'GraphAvailable',
        status: 'True',
        reason: 'Read',
        message: 'https://example/graph.json',
      },
      {
        type: 'Progressing',
        status: 'True',
        reason: 'Progressing',
        message: 'v2.5.0: draining cp-2, 3 pods left',
      },
      { type: 'Succeeded', status: 'False', reason: 'Progressing' },
      { type: 'Failed', status: 'False', reason: 'Progressing' },
    ],
  };
  return cu;
}

/** Marks the in-progress fixture Failed, with the Failed condition the operator sets. */
export function failWith(
  cu: ClusterUpgradeObject,
  reason: string,
  message: string
): ClusterUpgradeObject {
  cu.status!.phase = 'Failed';
  cu.status!.message = message;
  cu.status!.conditions = (cu.status!.conditions ?? []).map(c =>
    c.type === 'Failed'
      ? { ...c, status: 'True', reason, message }
      : c.type === 'Progressing'
      ? { ...c, status: 'False', reason: 'Failed' }
      : c
  );
  return cu;
}

// ------------------------------------------ Upgrade readiness (operator v0.7.0)

/** The ReleaseManifest of k4all v2.7.2: k4all-operator v0.7.0 (upgrade readiness). */
export function releaseManifestV272(): ReleaseManifestObject {
  const rm = releaseManifestV270();
  rm.spec!.osImage!.imageTag = 'v2.7.2-amd64';
  rm.spec!.components!['k4all-operator'] = { type: 'manifest', version: 'v0.7.0' };
  rm.status!.components!['k4all-operator'] = { state: 'Installed', installedVersion: 'v0.7.0' };
  return rm;
}

const CNPG = (name: string): ObjectRef => ({
  group: 'postgresql.cnpg.io',
  kind: 'Cluster',
  namespace: 'db',
  name,
});
const VM = (name: string): ObjectRef => ({
  group: 'kubevirt.io',
  kind: 'VirtualMachine',
  namespace: 'lab',
  name,
});

/** A single-instance CloudNativePG cluster: it blocks, with its three fixes. */
export function cnpgFinding(name = 'app-pg'): Finding {
  return {
    severity: 'Blocks',
    kind: 'CNPGSingleInstance',
    object: CNPG(name),
    message: `single-instance CloudNativePG primary ${name}-1: PDB ${name}-primary allows no disruption; its volume is on TopoLVM on this node`,
    remediations: [
      {
        remediation: 'cnpg-disable-pdb',
        target: CNPG(name),
        mode: 'ask',
        risk: 'Downtime',
        summary:
          'enablePDB false for the hop; the database is down until the node is back (its volume is on this node)',
      },
      {
        remediation: 'cnpg-maintenance-window',
        target: CNPG(name),
        mode: 'ask',
        risk: 'Downtime',
        summary: 'maintenance window for the hop, the pod waits for its node and volume',
      },
      {
        remediation: 'cnpg-add-replica',
        target: CNPG(name),
        mode: 'ask',
        risk: 'None',
        summary:
          'instances 1 -> 2 before the hop, back to 1 after: no downtime, needs room for a second volume',
      },
    ],
  };
}

/** A VM with evictionStrategy None: it shuts down with the drain. */
export function vmShutdownFinding(name = 'gpu-01', canMove = false): Finding {
  return {
    severity: 'Disrupts',
    kind: 'VMShutdown',
    object: VM(name),
    message: canMove
      ? 'evictionStrategy None: shuts down; it can move live to w-1'
      : `evictionStrategy None: shuts down; starts again only when this node is back (disk ${name}-rootdisk on TopoLVM here)`,
    remediations: [
      ...(canMove
        ? [
            {
              remediation: 'vm-migrate-first',
              target: VM(name),
              mode: 'ask',
              risk: 'None',
              summary: `move ${name} live to w-1 before the drain`,
            },
          ]
        : []),
      {
        remediation: 'vm-stop-start',
        target: VM(name),
        mode: 'ask',
        risk: 'Downtime',
        summary: 'clean stop before the drain, start after the hop',
      },
    ],
  };
}

/** A pod that declares no controller: it blocks, Accept (acknowledge) deletes it with the drain. */
export function barePodFinding(): Finding {
  const pod: ObjectRef = { kind: 'Pod', namespace: 'default', name: 'debug' };
  return {
    severity: 'Blocks',
    kind: 'BarePod',
    object: pod,
    message: 'pod default/debug declares no controller: the drain would delete it for good',
    remediations: [{ remediation: 'acknowledge', target: pod, mode: 'ask', risk: 'Downtime' }],
  };
}

/**
 * A ClusterUpgrade idle on v2.4.0 with the readiness report for its newest
 * release, v2.7.0, four hops away (operator v0.7.0).
 */
export function clusterUpgradeWithReadiness(): ClusterUpgradeObject {
  const cu = clusterUpgrade();
  cu.status!.readiness = {
    checkedAt: '2026-11-17T09:00:00Z',
    release: 'v2.7.0',
    hops: 4,
    dryRun: true,
    summary: { blocks: 1, disrupts: 3, info: 3, vmShutdowns: 2, vmsDownUntilNodeBack: 1 },
    message:
      '1 thing will stop the upgrade; 2 VMs will shut down per hop, 1 of them until their node is back',
    cluster: [
      {
        severity: 'Info',
        kind: 'CephHealthy',
        object: {
          group: 'ceph.rook.io',
          kind: 'CephCluster',
          namespace: 'rook-ceph',
          name: 'rook-ceph',
        },
        message: 'HEALTH_OK',
      },
    ],
    nodes: [
      {
        name: 'cp-1',
        summary: { blocks: 1, disrupts: 2, info: 2, vmShutdowns: 1, vmsDownUntilNodeBack: 1 },
        findings: [
          vmShutdownFinding('gpu-01'),
          cnpgFinding(),
          {
            severity: 'Disrupts',
            kind: 'PinnedToNode',
            object: { kind: 'Pod', namespace: 'shop', name: 'cache-0' },
            message: 'nodeSelector admits only cp-1',
            remediations: [
              {
                remediation: 'acknowledge',
                target: { kind: 'Pod', namespace: 'shop', name: 'cache-0' },
                mode: 'ask',
                risk: 'Downtime',
              },
            ],
          },
          {
            severity: 'Info',
            kind: 'EmptyDir',
            object: { kind: 'Pod', namespace: 'shop', name: 'web-1' },
            message: '3 pods lose emptyDir volumes',
            count: 3,
          },
          {
            severity: 'Info',
            kind: 'CephDaemonsHere',
            object: { kind: 'Node', name: 'cp-1' },
            message: 'mon-a, osd-0 stop until cp-1 is back',
          },
        ],
        truncated: 0,
      },
      {
        name: 'cp-2',
        summary: { disrupts: 1, vmShutdowns: 1 },
        findings: [vmShutdownFinding('web-01', true)],
      },
      {
        name: 'w-1',
        summary: { info: 1 },
        findings: [
          {
            severity: 'Info',
            kind: 'OperatorHere',
            object: {
              kind: 'Pod',
              namespace: 'k4all-operator-system',
              name: 'k4all-operator-controller-manager-0',
            },
            message: 'k4all-operator runs here: it moves itself off last',
          },
        ],
        truncated: 2,
      },
    ],
  };
  return cu;
}

/** The in-progress upgrade with cp-2 held before its cordon, and a record of cp-1's hop (operator v0.7.0). */
export function clusterUpgradeBlocked(): ClusterUpgradeObject {
  const cu = clusterUpgradeInProgress();
  const cp2 = cu.status!.nodes!.find(n => n.name === 'cp-2')!;
  cp2.phase = 'Pending';
  cp2.reason = 'WaitingForApproval';
  cp2.message = 'waiting for an answer to cnpg-disable-pdb for db/app-pg';
  delete cp2.drainStartedAt;
  cp2.blockers = [cnpgFinding(), barePodFinding()];
  cu.status!.message = 'v2.5.0: cp-2 waits for an answer';
  cu.status!.conditions = [
    ...(cu.status!.conditions ?? []),
    {
      type: 'Blocked',
      status: 'True',
      reason: 'WaitingForApproval',
      message: 'cp-2 waits for an answer to cnpg-disable-pdb for db/app-pg',
    },
  ];
  cu.status!.remediations = [
    {
      id: 'rm-4c1f9a',
      remediation: 'vm-stop-start',
      target: VM('gpu-01'),
      node: 'cp-1',
      hop: 'v2.5.0',
      by: 'approval',
      phase: 'Applied',
      appliedAt: '2026-11-17T09:31:00Z',
      message: 'set spec.runStrategy Halted (was Always)',
    },
    {
      id: 'rm-77d0e2',
      remediation: 'vm-migrate-first',
      target: VM('web-01'),
      node: 'cp-1',
      hop: 'v2.5.0',
      by: 'auto',
      phase: 'Restored',
      appliedAt: '2026-11-17T09:30:30Z',
      message: 'migrated web-01 to w-1',
    },
  ];
  return cu;
}

/** The finding kinds of the seed set (gpillon/k4all-operator#58) and of its embedded rules. */
export const SEED_FINDING_KINDS = [
  'PDBNeverAllows',
  'CNPGSingleInstance',
  'CNPGSwitchover',
  'PDBExhausted',
  'PDBSequential',
  'VMNotMigratable',
  'VMShutdown',
  'VMLiveMigrates',
  'NodeBoundVolume',
  'PinnedToNode',
  'NoRoomElsewhere',
  'BarePod',
  'Capacity',
  'AllReplicasHere',
  'EmptyDir',
  'StopsAtReboot',
  'SingleNodeShortStop',
  'OperatorHere',
  'CephNotHealthy',
  'CephHealthy',
  'CephDaemonsHere',
  'RookOSDBudget',
  'CephBelowMinSize',
  'CephNoRedundancy',
  'NodeNotReady',
  'PDBShort',
  'EvictionRefused',
  'RemediationFailed',
];
