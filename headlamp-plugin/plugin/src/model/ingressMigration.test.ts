import {
  IngressLike,
  ingressServices,
  managedBy,
  nginxClassIngresses,
  planMoveToTraefik,
  usesNginxClass,
} from './ingressMigration';
import { applyOps } from './patch';

function ingress(extra: {
  name?: string;
  namespace?: string;
  className?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  tls?: boolean;
}): IngressLike {
  return {
    metadata: {
      name: extra.name ?? 'web',
      namespace: extra.namespace ?? 'apps',
      generation: 3,
      annotations: extra.annotations,
      labels: extra.labels,
    },
    spec: {
      ingressClassName: extra.className,
      defaultBackend: { service: { name: 'fallback' } },
      rules: [
        {
          host: 'web.example.org',
          http: {
            paths: [
              { path: '/', backend: { service: { name: 'web' } } },
              { path: '/api', backend: { service: { name: 'api' } } },
              { path: '/v2', backend: { service: { name: 'api' } } },
            ],
          },
        },
      ],
      tls: extra.tls ? [{ hosts: ['web.example.org'], secretName: 'web-tls' }] : undefined,
    },
  };
}

describe('finding the Ingresses on the nginx class', () => {
  it('matches ingressClassName and the old annotation, nothing else', () => {
    expect(usesNginxClass(ingress({ className: 'nginx' }))).toBe(true);
    expect(
      usesNginxClass(ingress({ annotations: { 'kubernetes.io/ingress.class': 'nginx' } }))
    ).toBe(true);
    expect(usesNginxClass(ingress({ className: 'traefik' }))).toBe(false);
    expect(usesNginxClass(ingress({}))).toBe(false); // default class: Traefik
    const list = nginxClassIngresses([
      ingress({ name: 'b', namespace: 'z', className: 'nginx' }),
      ingress({ name: 'a', namespace: 'z', className: 'nginx' }),
      ingress({ name: 'c', namespace: 'a', className: 'nginx' }),
      ingress({ name: 'd', namespace: 'a', className: 'traefik' }),
    ]);
    expect(list.map(i => `${i.metadata.namespace}/${i.metadata.name}`)).toEqual([
      'a/c',
      'z/a',
      'z/b',
    ]);
  });

  it('lists the backend Services once', () => {
    expect(ingressServices(ingress({}))).toEqual(['api', 'fallback', 'web']);
  });

  it('spots Helm and Argo CD', () => {
    expect(
      managedBy(
        ingress({
          labels: { 'app.kubernetes.io/managed-by': 'Helm' },
          annotations: {
            'meta.helm.sh/release-name': 'shop',
            'meta.helm.sh/release-namespace': 'apps',
          },
        })
      )
    ).toEqual([{ tool: 'Helm', detail: 'Helm release apps/shop' }]);
    expect(
      managedBy(
        ingress({
          annotations: {
            'argocd.argoproj.io/tracking-id': 'shop:networking.k8s.io/Ingress:apps/web',
          },
        })
      )
    ).toEqual([{ tool: 'Argo CD', detail: 'Argo CD application shop' }]);
    expect(managedBy(ingress({}))).toEqual([]);
  });
});

describe('planMoveToTraefik', () => {
  it('sets the traefik class, guarded by the generation', () => {
    const ing = ingress({ className: 'nginx' });
    const plan = planMoveToTraefik(ing);
    expect(plan.ops[0]).toEqual({ op: 'test', path: '/metadata/generation', value: 3 });
    expect(applyOps(ing, plan.ops).spec?.ingressClassName).toBe('traefik');
    expect(plan).toMatchObject({
      converted: [],
      kept: [],
      httpsServices: [],
      needsConfirmation: false,
    });
  });

  it('drops the old class annotation, which cannot coexist with ingressClassName', () => {
    const ing = ingress({ annotations: { 'kubernetes.io/ingress.class': 'nginx', team: 'a' } });
    const after = applyOps(ing, planMoveToTraefik(ing).ops);
    expect(after.metadata.annotations).toEqual({ team: 'a' });
    expect(after.spec?.ingressClassName).toBe('traefik');
  });

  it('turns an SSL redirect into the k4all redirect middleware', () => {
    const ing = ingress({
      className: 'nginx',
      annotations: { 'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true' },
    });
    const plan = planMoveToTraefik(ing);
    expect(applyOps(ing, plan.ops).metadata.annotations).toEqual({
      'traefik.ingress.kubernetes.io/router.middlewares': 'traefik-redirect-https@kubernetescrd',
    });
    expect(plan.converted[0].becomes).toMatch(/router.middlewares/);
    expect(plan.needsConfirmation).toBe(false);
  });

  it('appends the middleware to existing ones, once', () => {
    const ing = ingress({
      className: 'nginx',
      annotations: {
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
        'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true',
        'traefik.ingress.kubernetes.io/router.middlewares': 'apps-auth@kubernetescrd',
      },
    });
    expect(applyOps(ing, planMoveToTraefik(ing).ops).metadata.annotations).toEqual({
      'traefik.ingress.kubernetes.io/router.middlewares':
        'apps-auth@kubernetescrd,traefik-redirect-https@kubernetescrd',
    });
  });

  it('drops ssl-redirect "false" without a middleware', () => {
    const ing = ingress({
      className: 'nginx',
      annotations: { 'nginx.ingress.kubernetes.io/ssl-redirect': 'false' },
    });
    const plan = planMoveToTraefik(ing);
    expect(applyOps(ing, plan.ops).metadata.annotations).toEqual({});
    expect(plan.converted[0].becomes).toMatch(/does not redirect/);
  });

  it('moves backend-protocol HTTPS to the backend Services', () => {
    const ing = ingress({
      className: 'nginx',
      annotations: { 'nginx.ingress.kubernetes.io/backend-protocol': 'HTTPS' },
    });
    const plan = planMoveToTraefik(ing);
    expect(plan.httpsServices).toEqual(['api', 'fallback', 'web']);
    expect(applyOps(ing, plan.ops).metadata.annotations).toEqual({});
    expect(plan.converted[0].becomes).toBe(
      'traefik.ingress.kubernetes.io/service.serversscheme: https on Service api, fallback, web'
    );
  });

  it('keeps what it cannot convert and asks for confirmation', () => {
    const ing = ingress({
      className: 'nginx',
      annotations: {
        'nginx.ingress.kubernetes.io/backend-protocol': 'GRPC',
        'nginx.ingress.kubernetes.io/proxy-body-size': '50m',
        'cert-manager.io/cluster-issuer': 'letsencrypt',
      },
    });
    const plan = planMoveToTraefik(ing);
    expect(plan.kept).toEqual([
      { annotation: 'nginx.ingress.kubernetes.io/backend-protocol', value: 'GRPC' },
      { annotation: 'nginx.ingress.kubernetes.io/proxy-body-size', value: '50m' },
    ]);
    expect(plan.needsConfirmation).toBe(true);
    // kept annotations and non-nginx ones are left in place
    expect(Object.keys(applyOps(ing, plan.ops).metadata.annotations ?? {}).sort()).toEqual([
      'cert-manager.io/cluster-issuer',
      'nginx.ingress.kubernetes.io/backend-protocol',
      'nginx.ingress.kubernetes.io/proxy-body-size',
    ]);
  });

  it('asks for confirmation when Helm or Argo CD manage the Ingress', () => {
    const plan = planMoveToTraefik(
      ingress({ className: 'nginx', labels: { 'argocd.argoproj.io/instance': 'shop' } })
    );
    expect(plan.managedBy.map(m => m.tool)).toEqual(['Argo CD']);
    expect(plan.needsConfirmation).toBe(true);
  });

  it('notes the HTTPS redirect ingress-nginx did by default for TLS', () => {
    expect(planMoveToTraefik(ingress({ className: 'nginx', tls: true })).notes[0]).toMatch(
      /redirected HTTP to HTTPS/
    );
    expect(
      planMoveToTraefik(
        ingress({
          className: 'nginx',
          tls: true,
          annotations: { 'nginx.ingress.kubernetes.io/ssl-redirect': 'false' },
        })
      ).notes
    ).toEqual([]);
  });

  it('leaves an Ingress without annotations without them', () => {
    const ing = ingress({ className: 'nginx' });
    ing.metadata.annotations = undefined;
    expect(applyOps(ing, planMoveToTraefik(ing).ops).metadata.annotations).toBeUndefined();
  });
});
