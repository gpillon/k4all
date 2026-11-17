/*
 * The settings draft: a copy of ClusterConfig.spec the forms edit. Setters
 * return a new draft and never touch fields the plugin does not manage, so a
 * saved draft differs from the stored spec only where the user changed it.
 */

import { clone, getIn, isPlainObject, JsonObject, Path, setIn } from './objects';
import { ClusterConfigSpec, ComponentOverride, IngressControllerConfig } from './types';

export type Draft = ClusterConfigSpec;

export function draftFrom(spec: ClusterConfigSpec | undefined): Draft {
  return clone(spec ?? {});
}

export function getField<T = unknown>(draft: Draft, path: Path): T | undefined {
  return getIn(draft, path) as T | undefined;
}

export function setField(draft: Draft, path: Path, value: unknown): Draft {
  return setIn(draft, path, value);
}

// ------------------------------------------------------------------ Ingress

/**
 * k4all-operator v0.3.0 builds the MetalLB address pool from
 * spec.ingress.nginx.dedicatedIP and spec.ingress.cilium.dedicatedIP only, not
 * from spec.ingress.traefik. Until that is fixed (DESIGN.md, operator change
 * O-1), the Traefik IP is also written to the legacy nginx key so MetalLB
 * announces it. ingress-nginx itself is Removed from v2.6.0, so the nginx key
 * has no other effect while spec.ingress.traefik exists.
 */
export const MIRROR_TRAEFIK_IP_TO_NGINX = true;

export type TraefikSource = 'traefik' | 'nginx' | 'none';

export interface EffectiveTraefik {
  dedicatedIP: string;
  isDefault: boolean;
  /** Where the operator takes the settings from. */
  source: TraefikSource;
}

/**
 * The Traefik settings the operator uses: spec.ingress.traefik, or
 * spec.ingress.nginx on clusters whose ClusterConfig predates v2.6.0. A
 * missing isDefault reads as false, as the operator's Go types do.
 */
export function effectiveTraefik(spec: ClusterConfigSpec): EffectiveTraefik {
  const ingress = spec.ingress ?? {};
  const pick = (cfg: IngressControllerConfig | undefined, source: TraefikSource) => ({
    dedicatedIP: cfg?.dedicatedIP ?? '',
    isDefault: cfg?.isDefault === true,
    source,
  });
  if (ingress.traefik !== undefined && ingress.traefik !== null) {
    return pick(ingress.traefik, 'traefik');
  }
  if (ingress.nginx !== undefined && ingress.nginx !== null) {
    return pick(ingress.nginx, 'nginx');
  }
  return pick(undefined, 'none');
}

/**
 * Writes Traefik settings. spec.ingress.traefik is materialized with both
 * fields explicit: an omitted isDefault means false to k4all-operator v0.3.0
 * and true to later versions (CRD default), so it is never left out.
 */
export function setTraefik(
  draft: Draft,
  change: Partial<Pick<EffectiveTraefik, 'dedicatedIP' | 'isDefault'>>
): Draft {
  const current = effectiveTraefik(draft);
  const next = {
    ...(isPlainObject(draft.ingress?.traefik) ? draft.ingress?.traefik : {}),
    dedicatedIP: change.dedicatedIP ?? current.dedicatedIP,
    isDefault: change.isDefault ?? current.isDefault,
  };
  let out = setIn(draft, ['ingress', 'traefik'], next);
  if (MIRROR_TRAEFIK_IP_TO_NGINX && change.dedicatedIP !== undefined) {
    out = mirrorToNginx(out, current.dedicatedIP, change.dedicatedIP);
  }
  return out;
}

/** True when the nginx key only exists to carry the mirrored Traefik IP, or is free for it. */
export function nginxFollowsTraefik(spec: ClusterConfigSpec, traefikIP: string): boolean {
  const nginxIP = spec.ingress?.nginx?.dedicatedIP ?? '';
  return nginxIP === '' || nginxIP === traefikIP;
}

function mirrorToNginx(draft: Draft, previousIP: string, nextIP: string): Draft {
  if (!nginxFollowsTraefik(draft, previousIP)) {
    return draft; // someone set a different legacy IP on purpose: leave it
  }
  const hasNginx = isPlainObject(draft.ingress?.nginx);
  if (!hasNginx && nextIP === '') {
    return draft;
  }
  return setIn(draft, ['ingress', 'nginx', 'dedicatedIP'], nextIP);
}

/** Moves a pre-v2.6.0 config to spec.ingress.traefik, keeping behaviour identical. */
export function adoptTraefikKey(draft: Draft): Draft {
  if (effectiveTraefik(draft).source === 'traefik') {
    return draft;
  }
  return setTraefik(draft, {});
}

// -------------------------------------------------------------- Overrides

export function getOverride(draft: Draft, component: string): ComponentOverride | undefined {
  return draft.componentOverrides?.[component];
}

/**
 * Sets componentOverrides[component]. Empty values and helmArgs drop the key,
 * so a cleared override disappears instead of lingering as {}.
 */
export function setOverride(draft: Draft, component: string, override: ComponentOverride): Draft {
  const values =
    override.values && Object.keys(override.values).length > 0 ? override.values : undefined;
  const helmArgs =
    override.helmArgs && override.helmArgs.length > 0 ? override.helmArgs : undefined;
  const existing = (draft.componentOverrides?.[component] ?? {}) as JsonObject;
  if (values === undefined && helmArgs === undefined) {
    const rest = { ...existing };
    delete rest.values;
    delete rest.helmArgs;
    return setIn(
      draft,
      ['componentOverrides', component],
      Object.keys(rest).length ? rest : undefined
    );
  }
  const next: JsonObject = { ...existing };
  if (values === undefined) {
    delete next.values;
  } else {
    next.values = values;
  }
  if (helmArgs === undefined) {
    delete next.helmArgs;
  } else {
    next.helmArgs = helmArgs;
  }
  return setIn(draft, ['componentOverrides', component], next);
}

// ------------------------------------------------------------- Features

export function isCilium(spec: ClusterConfigSpec): boolean {
  return spec.networking?.cni?.type === 'cilium';
}

export function emulationMode(spec: ClusterConfigSpec): string {
  return spec.features?.virt?.emulation || 'auto';
}

export interface Exposure {
  kind: 'dedicated' | 'kube-vip' | 'loadbalancer-node' | 'host-ports';
  summary: string;
}

/** How the operator's Traefik hook publishes Traefik for these settings (traefik_hook.go). */
export function traefikExposure(spec: ClusterConfigSpec): Exposure {
  const t = effectiveTraefik(spec);
  if (t.dedicatedIP) {
    return {
      kind: 'dedicated',
      summary: `LoadBalancer Service on ${t.dedicatedIP}, announced by MetalLB.`,
    };
  }
  if (spec.cluster?.ha?.type === 'kubevip') {
    return {
      kind: 'kube-vip',
      summary: 'LoadBalancer Service on the node address, through kube-vip.',
    };
  }
  if (!t.isDefault) {
    return { kind: 'loadbalancer-node', summary: 'LoadBalancer Service on the node address.' };
  }
  return { kind: 'host-ports', summary: 'Host ports 80 and 443 on the control-plane nodes.' };
}
