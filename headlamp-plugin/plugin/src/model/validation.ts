/*
 * Validation of the settings draft and of component overrides. Errors block
 * saving; warnings are shown and kept in the review, but do not block.
 */

import yaml from 'js-yaml';
import { cidrContains, parseCIDR, parseIP, sameIP } from './net';
import { isPlainObject, JsonObject } from './objects';
import { effectiveIngress, INGRESS_LABEL, IngressController, isCilium } from './settings';
import { ClusterConfigSpec } from './types';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  /** Field id (see fields.ts) or "override:<component>". */
  field: string;
  severity: Severity;
  message: string;
}

export interface ValidationContext {
  /** InternalIP addresses of the nodes. */
  nodeIPs?: string[];
  /** The release's ingress controller (default Traefik). */
  ingress?: IngressController;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some(i => i.severity === 'error');
}

export function issuesFor(issues: Issue[], field: string): Issue[] {
  return issues.filter(i => i.field === field);
}

function validateLoadBalancerIP(
  field: string,
  label: string,
  ip: string,
  spec: ClusterConfigSpec,
  ctx: ValidationContext
): Issue[] {
  if (ip === '') {
    return [];
  }
  const bytes = parseIP(ip);
  if (!bytes) {
    return [
      { field, severity: 'error', message: `${label}: "${ip}" is not an IPv4 or IPv6 address.` },
    ];
  }
  const issues: Issue[] = [];
  const networks: [string, string | undefined][] = [
    ['pod network', spec.cluster?.podNetwork || '10.100.0.1/18'],
    ['service network', spec.cluster?.serviceNetwork || '10.96.0.0/16'],
  ];
  for (const [name, cidrText] of networks) {
    const cidr = cidrText ? parseCIDR(cidrText) : null;
    if (cidr && cidrContains(cidr, bytes)) {
      issues.push({
        field,
        severity: 'error',
        message: `${label}: ${ip} is inside the ${name} (${cidrText}); use an address of the node network.`,
      });
    }
  }
  const vip = spec.cluster?.ha?.apiControlEndpoint ?? '';
  if (vip && sameIP(vip, ip)) {
    issues.push({
      field,
      severity: 'error',
      message: `${label}: ${ip} is the control plane virtual IP.`,
    });
  }
  if ((ctx.nodeIPs ?? []).some(nodeIP => sameIP(nodeIP, ip))) {
    issues.push({
      field,
      severity: 'warning',
      message: `${label}: ${ip} is a node address. Leave the field empty to serve on the node address.`,
    });
  }
  return issues;
}

/** Linux interface names: 1-15 bytes, no "/", no whitespace; Cilium accepts a trailing "+" wildcard. */
export function validateDeviceName(name: string): string | null {
  if (name === '') {
    return 'Interface name is empty.';
  }
  if (name === '.' || name === '..') {
    return `"${name}" is not a valid interface name.`;
  }
  if (/[\s/]/.test(name)) {
    return `"${name}" contains a space or "/".`;
  }
  if (name.replace(/\+$/, '').length > 15) {
    return `"${name}" is longer than 15 characters.`;
  }
  return null;
}

export function validateSettings(spec: ClusterConfigSpec, ctx: ValidationContext = {}): Issue[] {
  const issues: Issue[] = [];
  const controller = ctx.ingress ?? 'traefik';
  const name = INGRESS_LABEL[controller];
  const traefik = effectiveIngress(spec, controller);
  issues.push(...validateLoadBalancerIP('traefikIP', `${name} IP`, traefik.dedicatedIP, spec, ctx));

  const ciliumIP = spec.ingress?.cilium?.dedicatedIP ?? '';
  issues.push(
    ...validateLoadBalancerIP('ciliumIngressIP', 'Cilium ingress IP', ciliumIP, spec, ctx)
  );
  if (traefik.dedicatedIP && ciliumIP && sameIP(traefik.dedicatedIP, ciliumIP)) {
    issues.push({
      field: 'ciliumIngressIP',
      severity: 'error',
      message: `${name} and the Cilium ingress cannot share the same dedicated IP.`,
    });
  }
  if (ciliumIP && !isCilium(spec)) {
    issues.push({
      field: 'ciliumIngressIP',
      severity: 'warning',
      message: 'The cluster CNI is not Cilium: this address is only added to the MetalLB pool.',
    });
  }

  const emulation = spec.features?.virt?.emulation;
  if (
    emulation !== undefined &&
    emulation !== '' &&
    !['true', 'false', 'auto'].includes(emulation)
  ) {
    issues.push({
      field: 'virtEmulation',
      severity: 'error',
      message: `Unknown emulation mode "${emulation}".`,
    });
  }

  const devices = spec.networking?.cni?.cilium?.additionalDevices ?? [];
  const seen = new Set<string>();
  for (const device of devices) {
    const problem = validateDeviceName(device);
    if (problem) {
      issues.push({ field: 'ciliumDevices', severity: 'error', message: problem });
    }
    if (seen.has(device)) {
      issues.push({
        field: 'ciliumDevices',
        severity: 'error',
        message: `"${device}" is listed twice.`,
      });
    }
    seen.add(device);
    if (device === 'ovs-bridge' && spec.features?.ovsBridge?.enabled) {
      issues.push({
        field: 'ciliumDevices',
        severity: 'warning',
        message: 'ovs-bridge is added automatically when the OVS bridge is on.',
      });
    }
  }
  return issues;
}

// -------------------------------------------------------------- Overrides

export interface ParsedValues {
  values?: JsonObject;
  error?: string;
}

/** Parses the override values editor: empty text means no values. */
export function parseValuesYaml(text: string): ParsedValues {
  if (text.trim() === '') {
    return { values: undefined };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const e = err as { mark?: { line?: number }; reason?: string; message?: string };
    const line = e.mark?.line !== undefined ? ` (line ${e.mark.line + 1})` : '';
    return { error: `Not valid YAML${line}: ${e.reason ?? e.message ?? String(err)}` };
  }
  if (parsed === null || parsed === undefined) {
    return { values: undefined };
  }
  if (!isPlainObject(parsed)) {
    return { error: 'Helm values must be a mapping (key: value), not a list or a scalar.' };
  }
  return { values: parsed };
}

/**
 * The operator applies each helmArg with Helm's --set parser after stripping
 * "--set " or "--set=". Anything else (--set-string, --version, ...) would be
 * parsed as a key, or fail the component, so it is rejected here.
 */
export function validateHelmArg(arg: string): string | null {
  const trimmed = arg.trim();
  if (trimmed === '') {
    return 'Empty argument.';
  }
  const body = trimmed.replace(/^--set[ =]/, '');
  if (body.startsWith('-')) {
    return `"${trimmed}": only --set key=value is supported.`;
  }
  const firstPair = body.split(',')[0];
  const eq = firstPair.indexOf('=');
  if (eq <= 0) {
    return `"${trimmed}": expected key=value.`;
  }
  if (/\s/.test(firstPair.slice(0, eq))) {
    return `"${trimmed}": the key contains spaces.`;
  }
  return null;
}

/** Keys of the headlamp component values that carry the k4all plugin itself. */
const HEADLAMP_PLUGIN_KEYS = ['initContainers', 'volumes', 'volumeMounts'];

/** Component-specific warnings about an override. */
export function overrideWarnings(
  component: string,
  values: JsonObject | undefined,
  componentType: string
): Issue[] {
  const field = `override:${component}`;
  const issues: Issue[] = [];
  if (values && componentType !== 'helm' && componentType !== 'helm-oci') {
    issues.push({
      field,
      severity: 'warning',
      message: `${component} is a ${componentType} component: k4all-operator only uses values for Helm components.`,
    });
  }
  if (component === 'headlamp' && values) {
    const replaced = HEADLAMP_PLUGIN_KEYS.filter(key => key in values);
    if (replaced.length > 0) {
      issues.push({
        field,
        severity: 'warning',
        message:
          `Lists are replaced, not merged: overriding ${replaced.join(
            ', '
          )} drops the k4all plugin ` + 'unless you copy its entries from the release values.',
      });
    }
  }
  return issues;
}
