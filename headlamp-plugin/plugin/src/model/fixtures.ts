/*
 * Test fixtures shaped like a real k4all v2.7.0 cluster: the installer's
 * default ClusterConfig and a subset of k4all-release.yaml.
 */

import { ClusterConfigObject, NodeLike, ReleaseManifestObject } from './types';

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
        imageTag: 'v2.7.0-amd64',
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
          version: '4.15.1',
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
        headlamp: { type: 'helm', version: '0.46.0', dependsOn: ['cert-manager'] },
        kubevirt: { type: 'manifest', version: 'v1.9.1', featureGate: 'virt' },
        virtctl: {
          type: 'binary',
          version: 'v1.9.1',
          featureGate: 'virt',
          dependsOn: ['kubevirt'],
        },
        cdi: { type: 'manifest', version: 'v1.66.1', featureGate: 'virt', dependsOn: ['kubevirt'] },
        'kubevirt-manager': {
          type: 'manifest',
          version: 'v1.5.4',
          featureGate: 'virt',
          dependsOn: ['kubevirt'],
        },
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
