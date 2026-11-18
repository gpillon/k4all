/*
 * The settings draft: a copy of ClusterConfig.spec the forms edit. Setters
 * return a new draft and never touch fields the plugin does not manage, so a
 * saved draft differs from the stored spec only where the user changed it.
 */

import { clone, getIn, isPlainObject, JsonObject, Path, setIn } from './objects';
import {
  ClusterConfigSpec,
  ComponentOverride,
  ComponentSpec,
  IngressControllerConfig,
} from './types';

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
 * The ingress controller of the release: ingress-nginx up to k4all v2.3.x,
 * Traefik from v2.4.0 (ingress-nginx is then Removed), the first release with
 * this plugin. ingress-nginx is still met where a ReleaseManifest was changed
 * by hand to keep it. The operator's ingress-nginx hook reads
 * spec.ingress.nginx only; the Traefik hook reads spec.ingress.traefik, or
 * spec.ingress.nginx while the traefik key is absent.
 */
export type IngressController = 'traefik' | 'nginx';

export const INGRESS_LABEL: Record<IngressController, string> = {
  traefik: 'Traefik',
  nginx: 'ingress-nginx',
};

/** The active ingress controller, from the ReleaseManifest components (or the config). */
export function activeIngress(
  components: Record<string, ComponentSpec> | undefined,
  spec: ClusterConfigSpec = {}
): IngressController {
  const active = (name: string) => {
    const c = components?.[name];
    return !!c && c.management !== 'Removed';
  };
  if (active('traefik')) {
    return 'traefik';
  }
  if (active('ingress-nginx')) {
    return 'nginx';
  }
  return spec.ingress?.traefik || !spec.ingress?.nginx ? 'traefik' : 'nginx';
}

export type TraefikSource = 'traefik' | 'nginx' | 'none';

export interface EffectiveTraefik {
  dedicatedIP: string;
  isDefault: boolean;
  /** Where the operator takes the settings from. */
  source: TraefikSource;
}

function pick(cfg: IngressControllerConfig | undefined, source: TraefikSource): EffectiveTraefik {
  return { dedicatedIP: cfg?.dedicatedIP ?? '', isDefault: cfg?.isDefault === true, source };
}

/**
 * The Traefik settings the operator uses: spec.ingress.traefik, or, on
 * clusters installed before v2.4.0 whose ClusterConfig was not migrated yet
 * (k4all-operator v0.4.2 and later write the key; v0.5.0 does it in the
 * v2.4.0 sync), the values inherited from the ingress-nginx settings
 * (source "nginx"). The plugin only reads those: any
 * change is saved to spec.ingress.traefik. A missing isDefault reads as
 * false, as the operator's Go types did before v0.4.0.
 */
export function effectiveTraefik(spec: ClusterConfigSpec): EffectiveTraefik {
  const ingress = spec.ingress ?? {};
  if (ingress.traefik !== undefined && ingress.traefik !== null) {
    return pick(ingress.traefik, 'traefik');
  }
  if (ingress.nginx !== undefined && ingress.nginx !== null) {
    return pick(ingress.nginx, 'nginx');
  }
  return pick(undefined, 'none');
}

/** The settings the active controller's hook reads. */
export function effectiveIngress(
  spec: ClusterConfigSpec,
  controller: IngressController
): EffectiveTraefik {
  if (controller === 'nginx') {
    const nginx = spec.ingress?.nginx;
    return pick(nginx ?? undefined, nginx ? 'nginx' : 'none');
  }
  return effectiveTraefik(spec);
}

/**
 * Writes Traefik settings, to spec.ingress.traefik only, with both fields
 * explicit (starting from the inherited values when the key is new): an
 * omitted isDefault meant false to k4all-operator v0.3.0 and means true from
 * v0.4.0 (CRD default). The ingress-nginx key is never written on a Traefik
 * release.
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
  return setIn(draft, ['ingress', 'traefik'], next);
}

/** Writes ingress-nginx settings (spec.ingress.nginx), both fields explicit. */
export function setNginx(
  draft: Draft,
  change: Partial<Pick<EffectiveTraefik, 'dedicatedIP' | 'isDefault'>>
): Draft {
  const current = effectiveIngress(draft, 'nginx');
  const next = {
    ...(isPlainObject(draft.ingress?.nginx) ? draft.ingress?.nginx : {}),
    dedicatedIP: change.dedicatedIP ?? current.dedicatedIP,
    isDefault: change.isDefault ?? current.isDefault,
  };
  return setIn(draft, ['ingress', 'nginx'], next);
}

/** Writes the settings of the active controller. */
export function setIngress(
  draft: Draft,
  controller: IngressController,
  change: Partial<Pick<EffectiveTraefik, 'dedicatedIP' | 'isDefault'>>
): Draft {
  return controller === 'nginx' ? setNginx(draft, change) : setTraefik(draft, change);
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

/**
 * How the operator publishes the ingress controller for these settings. The
 * Traefik hook (traefik_hook.go) and the ingress-nginx hook
 * (ingress_nginx_hook.go) follow the same rules.
 */
export function ingressExposure(
  spec: ClusterConfigSpec,
  controller: IngressController = 'traefik'
): Exposure {
  const t = effectiveIngress(spec, controller);
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

/** How the operator's Traefik hook publishes Traefik for these settings. */
export function traefikExposure(spec: ClusterConfigSpec): Exposure {
  return ingressExposure(spec, 'traefik');
}
