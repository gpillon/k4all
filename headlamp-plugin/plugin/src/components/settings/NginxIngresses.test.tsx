import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { annotateService, patchIngress } from '../../api/k4allApi';
import { IngressLike } from '../../model/ingressMigration';
import { NginxIngressesView } from './NginxIngresses';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ K8s: {} }));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  Link: (props: { children: React.ReactNode }) => <a href="#ingress">{props.children}</a>,
}));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
vi.mock('../../api/k4allApi', () => ({
  patchIngress: vi.fn(async () => ({})),
  annotateService: vi.fn(async () => ({})),
}));

const ing = (name: string, extra: Partial<IngressLike['metadata']> = {}, className = 'nginx') =>
  ({
    metadata: { name, namespace: 'apps', generation: 1, ...extra },
    spec: {
      ingressClassName: className,
      rules: [
        { host: `${name}.example.org`, http: { paths: [{ backend: { service: { name } } }] } },
      ],
    },
  } as IngressLike);

describe('NginxIngressesView', () => {
  beforeEach(() => {
    vi.mocked(patchIngress).mockClear();
    vi.mocked(annotateService).mockClear();
  });

  it('lists only the Ingresses on the nginx class, with what the move does', () => {
    render(
      <NginxIngressesView
        canPatch
        items={[
          ing('shop', {
            annotations: {
              'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true',
              'nginx.ingress.kubernetes.io/rewrite-target': '/',
            },
            labels: { 'app.kubernetes.io/managed-by': 'Helm' },
          }),
          ing('blog', {}, 'traefik'),
        ]}
      />
    );
    const rows = within(screen.getByRole('table', { name: 'Ingresses on the nginx class' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toMatch(/apps\/shop/);
    expect(screen.getByText('1 converted')).toBeTruthy();
    expect(screen.getByText('1 not convertible')).toBeTruthy();
    expect(screen.getByText('Helm')).toBeTruthy();
  });

  it('says when nothing is left on the nginx class', () => {
    render(<NginxIngressesView canPatch items={[ing('blog', {}, 'traefik')]} />);
    expect(screen.getByText('No Ingress uses the nginx class.')).toBeTruthy();
  });

  it('asks for confirmation, then dry-runs and applies Services before the Ingress', async () => {
    render(
      <NginxIngressesView
        canPatch
        items={[
          ing('shop', {
            annotations: {
              'nginx.ingress.kubernetes.io/backend-protocol': 'HTTPS',
              'nginx.ingress.kubernetes.io/proxy-body-size': '50m',
            },
          }),
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch apps/shop to traefik' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/cannot be converted/)).toBeTruthy();
    const apply = within(dialog).getByRole('button', {
      name: 'Switch to traefik',
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I understand/ }));
    fireEvent.click(apply);
    await waitFor(() => expect(patchIngress).toHaveBeenCalledTimes(2));
    expect(vi.mocked(annotateService).mock.calls).toEqual([
      ['apps', 'shop', 'traefik.ingress.kubernetes.io/service.serversscheme', 'https', true],
      ['apps', 'shop', 'traefik.ingress.kubernetes.io/service.serversscheme', 'https', false],
    ]);
    expect(vi.mocked(patchIngress).mock.calls.map(c => c[3])).toEqual([true, false]);
    // dry runs first: both dry runs come before any real write
    const order = [
      ...vi.mocked(annotateService).mock.invocationCallOrder.map((o, i) => [o, `svc ${i}`]),
      ...vi.mocked(patchIngress).mock.invocationCallOrder.map((o, i) => [o, `ing ${i}`]),
    ]
      .sort((a, b) => (a[0] as number) - (b[0] as number))
      .map(x => x[1]);
    expect(order).toEqual(['svc 0', 'ing 0', 'svc 1', 'ing 1']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('No Ingress uses the nginx class.')).toBeTruthy();
  });

  it('disables the switch without patch permission', () => {
    render(<NginxIngressesView canPatch={false} items={[ing('shop')]} />);
    expect(
      (screen.getByRole('button', { name: 'Switch apps/shop to traefik' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
