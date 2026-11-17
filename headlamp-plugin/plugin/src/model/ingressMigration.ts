/*
 * Moving Ingresses from the nginx class to the traefik class (k4all v2.4.0+).
 *
 * Since v2.4.0 Traefik serves the Ingresses of class nginx through its
 * ingress-nginx provider, with the nginx annotations it understands. Moving
 * an Ingress to the traefik class makes it a plain Traefik Ingress:
 *
 * - spec.ingressClassName: traefik (and the old kubernetes.io/ingress.class
 *   annotation removed: the API server refuses both on one Ingress);
 * - nginx.ingress.kubernetes.io/force-ssl-redirect or ssl-redirect "true"
 *   become the router middleware traefik-redirect-https@kubernetescrd (the
 *   Middleware "redirect-https" in namespace traefik, created by k4all);
 *   "false" is dropped (Traefik does not redirect unless asked);
 * - backend-protocol HTTPS becomes traefik.ingress.kubernetes.io/service.serversscheme:
 *   https on each backend Service; HTTP is the default and is dropped;
 * - every other nginx annotation stays, and has no effect any more: the
 *   user is told and must confirm.
 */

import { toPointer } from './objects';
import { JsonPatchOp, precondition } from './patch';

export const INGRESS_CLASS_ANNOTATION = 'kubernetes.io/ingress.class';
export const NGINX_ANNOTATION_PREFIX = 'nginx.ingress.kubernetes.io/';
export const TRAEFIK_MIDDLEWARES_ANNOTATION = 'traefik.ingress.kubernetes.io/router.middlewares';
export const TRAEFIK_REDIRECT_MIDDLEWARE = 'traefik-redirect-https@kubernetescrd';
export const TRAEFIK_SERVERS_SCHEME_ANNOTATION =
  'traefik.ingress.kubernetes.io/service.serversscheme';

const SSL_REDIRECT = ['force-ssl-redirect', 'ssl-redirect'].map(a => NGINX_ANNOTATION_PREFIX + a);
const BACKEND_PROTOCOL = `${NGINX_ANNOTATION_PREFIX}backend-protocol`;

export interface IngressLike {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    generation?: number;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    ingressClassName?: string;
    defaultBackend?: { service?: { name: string } };
    rules?: {
      host?: string;
      http?: { paths?: { path?: string; backend?: { service?: { name: string } } }[] };
    }[];
    tls?: { hosts?: string[]; secretName?: string }[];
  };
}

/** The Ingress is served as class nginx: by ingressClassName or the old annotation. */
export function usesNginxClass(ing: IngressLike): boolean {
  return (
    ing.spec?.ingressClassName === 'nginx' ||
    ing.metadata.annotations?.[INGRESS_CLASS_ANNOTATION] === 'nginx'
  );
}

export function nginxClassIngresses<T extends IngressLike>(items: T[]): T[] {
  return items
    .filter(usesNginxClass)
    .sort(
      (a, b) =>
        (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') ||
        a.metadata.name.localeCompare(b.metadata.name)
    );
}

/** The hosts an Ingress serves. */
export function ingressHosts(ing: IngressLike): string[] {
  return [...new Set((ing.spec?.rules ?? []).map(r => r.host).filter((h): h is string => !!h))];
}

/** The Services the Ingress routes to (same namespace). */
export function ingressServices(ing: IngressLike): string[] {
  const names = new Set<string>();
  const def = ing.spec?.defaultBackend?.service?.name;
  if (def) {
    names.add(def);
  }
  for (const rule of ing.spec?.rules ?? []) {
    for (const path of rule.http?.paths ?? []) {
      if (path.backend?.service?.name) {
        names.add(path.backend.service.name);
      }
    }
  }
  return [...names].sort();
}

export interface ManagedBy {
  tool: 'Helm' | 'Argo CD';
  detail: string;
}

/**
 * Who else writes this Ingress: Helm (managed-by label, release annotations,
 * chart label) or Argo CD (tracking annotation or instance label). A change
 * made here is undone at their next upgrade or sync.
 */
export function managedBy(ing: IngressLike): ManagedBy[] {
  const labels = ing.metadata.labels ?? {};
  const annotations = ing.metadata.annotations ?? {};
  const out: ManagedBy[] = [];
  const release = annotations['meta.helm.sh/release-name'];
  if (labels['app.kubernetes.io/managed-by'] === 'Helm' || release || labels['helm.sh/chart']) {
    out.push({
      tool: 'Helm',
      detail: release
        ? `Helm release ${annotations['meta.helm.sh/release-namespace'] ?? ''}/${release}`.replace(
            ' /',
            ' '
          )
        : `Helm chart ${labels['helm.sh/chart'] ?? ''}`.trim(),
    });
  }
  const tracking = annotations['argocd.argoproj.io/tracking-id'];
  const instance = labels['argocd.argoproj.io/instance'];
  if (tracking || instance) {
    out.push({
      tool: 'Argo CD',
      detail: `Argo CD application ${(tracking ?? instance ?? '').split(':')[0]}`,
    });
  }
  return out;
}

export interface Conversion {
  annotation: string;
  value: string;
  /** What it becomes, in words. */
  becomes: string;
}

export interface MovePlan {
  /** JSON Patch for the Ingress, guarded by its generation. */
  ops: JsonPatchOp[];
  /** Annotations converted or dropped because Traefik needs no equivalent. */
  converted: Conversion[];
  /** nginx annotations that stay and stop having an effect. */
  kept: { annotation: string; value: string }[];
  /** Services that get traefik.ingress.kubernetes.io/service.serversscheme: https. */
  httpsServices: string[];
  managedBy: ManagedBy[];
  /** Behaviour changes worth knowing that the move does not convert. */
  notes: string[];
  /** Kept annotations or a managing tool: ask before applying. */
  needsConfirmation: boolean;
}

function truthy(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/** The changes that move one Ingress to the traefik class. */
export function planMoveToTraefik(ing: IngressLike): MovePlan {
  const annotations = { ...(ing.metadata.annotations ?? {}) };
  const converted: Conversion[] = [];
  const kept: { annotation: string; value: string }[] = [];
  const remove = new Set<string>();
  let redirect = false;
  let httpsServices: string[] = [];

  for (const [key, value] of Object.entries(annotations).sort(([a], [b]) => a.localeCompare(b))) {
    if (!key.startsWith(NGINX_ANNOTATION_PREFIX)) {
      continue;
    }
    if (SSL_REDIRECT.includes(key)) {
      remove.add(key);
      if (truthy(value)) {
        redirect = true;
        converted.push({
          annotation: key,
          value,
          becomes: `${TRAEFIK_MIDDLEWARES_ANNOTATION}: ${TRAEFIK_REDIRECT_MIDDLEWARE}`,
        });
      } else {
        converted.push({
          annotation: key,
          value,
          becomes: 'nothing: Traefik does not redirect to HTTPS unless asked',
        });
      }
      continue;
    }
    if (key === BACKEND_PROTOCOL) {
      const protocol = value.trim().toUpperCase();
      if (protocol === 'HTTPS') {
        remove.add(key);
        httpsServices = ingressServices(ing);
        converted.push({
          annotation: key,
          value,
          becomes: `${TRAEFIK_SERVERS_SCHEME_ANNOTATION}: https on Service ${
            httpsServices.join(', ') || '(none found)'
          }`,
        });
        continue;
      }
      if (protocol === 'HTTP') {
        remove.add(key);
        converted.push({ annotation: key, value, becomes: 'nothing: HTTP is the default' });
        continue;
      }
    }
    kept.push({ annotation: key, value });
  }

  const ops: JsonPatchOp[] = [precondition(ing)];
  ops.push({ op: 'add', path: '/spec/ingressClassName', value: 'traefik' });
  if (annotations[INGRESS_CLASS_ANNOTATION] !== undefined) {
    remove.add(INGRESS_CLASS_ANNOTATION);
  }
  for (const key of [...remove].sort()) {
    ops.push({ op: 'remove', path: toPointer(['metadata', 'annotations', key]) });
  }
  if (redirect) {
    const existing = (annotations[TRAEFIK_MIDDLEWARES_ANNOTATION] ?? '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
    if (!existing.includes(TRAEFIK_REDIRECT_MIDDLEWARE)) {
      const value = [...existing, TRAEFIK_REDIRECT_MIDDLEWARE].join(',');
      ops.push(
        ing.metadata.annotations
          ? {
              op: 'add',
              path: toPointer(['metadata', 'annotations', TRAEFIK_MIDDLEWARES_ANNOTATION]),
              value,
            }
          : {
              op: 'add',
              path: '/metadata/annotations',
              value: { [TRAEFIK_MIDDLEWARES_ANNOTATION]: value },
            }
      );
    }
  }

  const notes: string[] = [];
  const hasTls = (ing.spec?.tls ?? []).length > 0;
  if (hasTls && !SSL_REDIRECT.some(k => k in annotations)) {
    notes.push(
      'ingress-nginx redirected HTTP to HTTPS for an Ingress with TLS by default; Traefik does not. ' +
        `Add ${TRAEFIK_MIDDLEWARES_ANNOTATION}: ${TRAEFIK_REDIRECT_MIDDLEWARE} if you want the redirect.`
    );
  }
  const owners = managedBy(ing);
  return {
    ops,
    converted,
    kept,
    httpsServices,
    managedBy: owners,
    notes,
    needsConfirmation: kept.length > 0 || owners.length > 0,
  };
}
