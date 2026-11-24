/*
 * Virtualization settings besides the gates (k4all v2.7.0, operator v0.6.0):
 * where the persistent VM state lives (features.virt.kubevirt
 * .vmStateStorageClass) and the metadata service (features.virt.metadata).
 */

import { ClusterConfigSpec, KubeVirtLike, StorageClassLike, StorageProfileLike } from './types';
import type { Issue } from './validation';

export const DEFAULT_CLASS_ANNOTATION = 'storageclass.kubernetes.io/is-default-class';
export const DEFAULT_VIRT_CLASS_ANNOTATION = 'storageclass.kubevirt.io/is-default-virt-class';

export interface VmStateInfo {
  /** The ClusterConfig sets vmStateStorageClass: k4all owns it. */
  owned: boolean;
  /** The StorageClass KubeVirt uses for the state, if any. */
  effective?: string;
  /** Where that comes from. */
  how: 'k4all' | 'kubevirt-cr' | 'virt-default' | 'default' | 'none';
  /** The StorageClass exists. */
  exists: boolean;
  /** The access mode KubeVirt asks for (backend-storage getAccessMode, Filesystem volumes). */
  access: 'RWX' | 'RWO';
  /** The access mode is KubeVirt's fallback: the StorageProfile has no Filesystem entry, or there is none. */
  fallback: boolean;
  /** A CDI StorageProfile exists for the class. */
  hasProfile: boolean;
}

const annotated = (s: StorageClassLike, key: string) => s.metadata.annotations?.[key] === 'true';

/**
 * Where KubeVirt keeps persistent EFI/TPM state, and with which access mode,
 * as KubeVirt 1.9 picks them (pkg/storage/backend-storage): vmStateStorageClass
 * (k4all's, else the KubeVirt CR's), else the default virt class, else the
 * cluster default. The PVC is a Filesystem volume: its access mode is RWX if
 * the class's StorageProfile offers it for Filesystem, else RWO if offered,
 * else RWX when vmStateStorageClass is set and RWO when not.
 */
export function vmStateInfo(
  spec: ClusterConfigSpec,
  ctx: {
    kv: KubeVirtLike | null | undefined;
    storageClasses: StorageClassLike[];
    profiles: StorageProfileLike[];
  }
): VmStateInfo {
  const own = spec.features?.virt?.kubevirt?.vmStateStorageClass;
  const inCR = ctx.kv?.spec?.configuration?.vmStateStorageClass;
  let effective: string | undefined;
  let how: VmStateInfo['how'];
  if (own) {
    effective = own;
    how = 'k4all';
  } else if (inCR) {
    effective = inCR;
    how = 'kubevirt-cr';
  } else {
    const virt = ctx.storageClasses.find(s => annotated(s, DEFAULT_VIRT_CLASS_ANNOTATION));
    const def = ctx.storageClasses.find(s => annotated(s, DEFAULT_CLASS_ANNOTATION));
    effective = virt?.metadata.name ?? def?.metadata.name;
    how = virt ? 'virt-default' : def ? 'default' : 'none';
  }
  const classSet = how === 'k4all' || how === 'kubevirt-cr';
  const profile = ctx.profiles.find(p => p.metadata.name === effective);
  const sets = (profile?.status?.claimPropertySets ?? []).filter(
    s => (s.volumeMode ?? '') === 'Filesystem' && s.accessModes
  );
  const modes = sets.flatMap(s => s.accessModes ?? []);
  const access: VmStateInfo['access'] = modes.includes('ReadWriteMany')
    ? 'RWX'
    : modes.includes('ReadWriteOnce')
    ? 'RWO'
    : classSet
    ? 'RWX'
    : 'RWO';
  return {
    owned: !!own,
    effective,
    how,
    exists: !!effective && ctx.storageClasses.some(s => s.metadata.name === effective),
    access,
    fallback: modes.length === 0,
    hasProfile: !!profile,
  };
}

/** Warnings about k4all's vmStateStorageClass (none when k4all does not own it). */
export function vmStateIssues(
  spec: ClusterConfigSpec,
  ctx: Parameters<typeof vmStateInfo>[1]
): Issue[] {
  const info = vmStateInfo(spec, ctx);
  if (!info.owned) {
    return [];
  }
  const name = info.effective;
  const warn = (message: string): Issue[] => [
    { field: 'vmStateStorageClass', severity: 'warning', message },
  ];
  if (!info.exists) {
    return warn(
      `There is no StorageClass ${name}. k4all-operator writes it anyway and reports it in the ` +
        'KubeVirtSettings condition; VMs with persistent EFI or TPM state cannot start.'
    );
  }
  if (info.access === 'RWO') {
    return warn(
      `${name} gives the VM state ReadWriteOnce volumes: KubeVirt copies the state to the target ` +
        'node at each live migration. It works; a ReadWriteMany class avoids the copy.'
    );
  }
  if (info.fallback) {
    return warn(
      (info.hasProfile
        ? `The CDI StorageProfile of ${name} lists no Filesystem access mode`
        : `There is no CDI StorageProfile for ${name}`) +
        ': KubeVirt then asks for a ReadWriteMany Filesystem volume, which block-only ' +
        'provisioners (Ceph RBD) cannot provide, and VMs with persistent state stay Pending. ' +
        'Give the StorageProfile a Filesystem entry (spec.claimPropertySets, ReadWriteOnce for RBD).'
    );
  }
  return [];
}

/** Audiences the API server accepts by default (kubeadm's service account issuer). */
export const API_SERVER_AUDIENCES = [
  'https://kubernetes.default.svc.cluster.local',
  'https://kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
  'kubernetes.default.svc',
];

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** Checks of features.virt.metadata; errors block saving. */
export function metadataIssues(spec: ClusterConfigSpec): Issue[] {
  const md = spec.features?.virt?.metadata;
  const issues: Issue[] = [];
  if (!md) {
    return issues;
  }
  const exp = md.tokens?.expirationSeconds;
  if (exp !== undefined && (!Number.isInteger(exp) || exp < 600)) {
    issues.push({
      field: 'metadataExpiration',
      severity: 'error',
      message: 'Tokens live at least 600 seconds (kubelet refuses shorter projected tokens).',
    });
  }
  for (const a of md.tokens?.audiences ?? []) {
    if (!a.trim()) {
      issues.push({
        field: 'metadataAudiences',
        severity: 'error',
        message: 'An audience cannot be empty.',
      });
    } else if (API_SERVER_AUDIENCES.includes(a.trim())) {
      issues.push({
        field: 'metadataAudiences',
        severity: 'error',
        message: `${a} is the API server's audience: a token read inside a VM could then call the API server.`,
      });
    }
  }
  const cm = md.vendorDataConfigMap;
  if (cm !== undefined && cm !== '' && (cm.length > 253 || !DNS_SUBDOMAIN.test(cm))) {
    issues.push({
      field: 'metadataVendorData',
      severity: 'error',
      message: `"${cm}" is not a ConfigMap name (lowercase letters, digits, "-" and ".").`,
    });
  }
  return issues;
}
