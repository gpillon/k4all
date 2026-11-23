/*
 * Rendering tests of the presentational parts: the settings sections and the
 * review dialog. Headlamp itself is not needed for these; icons are stubbed
 * so Iconify does not try to download them.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { Capabilities, capabilitiesOf } from '../model/capabilities';
import { describeChanges } from '../model/changes';
import { clusterConfigNginx, defaultClusterConfig, releaseManifest } from '../model/fixtures';
import { setIn } from '../model/objects';
import { buildSpecPatch } from '../model/patch';
import { Draft, setTraefik } from '../model/settings';
import { validateSettings } from '../model/validation';
import { ReviewDialog } from './review/ReviewDialog';
import { SaveFlow } from './review/useSaveFlow';
import { FeaturesSection } from './settings/FeaturesSection';
import { IngressSection } from './settings/IngressSection';
import { NetworkingSection } from './settings/NetworkingSection';

vi.mock('@iconify/react', () => ({ Icon: () => null }));

/** The fixtures' operator, v0.3.0: no optional capability. */
const OLD_OPERATOR: Capabilities = capabilitiesOf('v0.3.0');

function sectionProps(draft: Draft, update = vi.fn(), caps = OLD_OPERATOR) {
  const base = defaultClusterConfig().spec!;
  return {
    draft,
    base,
    update,
    disabled: false,
    issues: validateSettings(draft),
    status: {},
    caps,
  };
}

/** Runs the update function a section passed to its `update` callback. */
function applied(update: ReturnType<typeof vi.fn>, draft: Draft): Draft {
  expect(update).toHaveBeenCalled();
  const fn = update.mock.calls[update.mock.calls.length - 1][0] as (d: Draft) => Draft;
  return fn(draft);
}

describe('IngressSection', () => {
  it('writes the Traefik IP to spec.ingress.traefik only', () => {
    const draft = defaultClusterConfig().spec!;
    const update = vi.fn();
    render(<IngressSection {...sectionProps(draft, update)} />);
    fireEvent.change(screen.getByLabelText('Traefik dedicated IP'), {
      target: { value: ' 192.168.1.240 ' },
    });
    const next = applied(update, draft);
    expect(next.ingress?.traefik).toEqual({ dedicatedIP: '192.168.1.240', isDefault: true });
    expect(next.ingress?.nginx).toBeUndefined();
  });

  it('shows validation errors next to the field', () => {
    const draft = setTraefik(defaultClusterConfig().spec!, { dedicatedIP: '10.96.0.10' });
    render(<IngressSection {...sectionProps(draft)} />);
    expect(screen.getByText(/inside the service network/)).toBeTruthy();
    expect(screen.getByText(/changed/)).toBeTruthy();
  });

  it('explains how Traefik is exposed', () => {
    render(<IngressSection {...sectionProps(defaultClusterConfig().spec!)} />);
    expect(screen.getByText(/Host ports 80 and 443/)).toBeTruthy();
  });

  it('edits spec.ingress.nginx on clusters that kept ingress-nginx', () => {
    const draft = clusterConfigNginx().spec!;
    const update = vi.fn();
    render(
      <IngressSection
        {...sectionProps(draft, update, capabilitiesOf('v0.5.0'))}
        base={draft}
        controller="nginx"
      />
    );
    expect(screen.queryByRole('button', { name: /Move to spec.ingress.traefik/ })).toBeNull();
    expect(screen.getByText(/replaces it with Traefik/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'ingress-nginx is the default IngressClass' })
    );
    expect(applied(update, draft).ingress).toEqual({
      nginx: { dedicatedIP: '', isDefault: false },
      cilium: { dedicatedIP: '' },
    });
  });

  it('shows the inherited values and saves a change straight to spec.ingress.traefik', () => {
    const legacy: Draft = {
      networking: { cni: { type: 'calico' } },
      ingress: { nginx: { dedicatedIP: '192.168.1.240', isDefault: true } },
    };
    const update = vi.fn();
    render(<IngressSection {...sectionProps(legacy, update)} base={legacy} />);
    expect(screen.queryByRole('button', { name: /Move to/ })).toBeNull();
    expect(screen.getByText(/settings it inherited/)).toBeTruthy();
    expect((screen.getByLabelText('Traefik dedicated IP') as HTMLInputElement).value).toBe(
      '192.168.1.240'
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Traefik is the default IngressClass' }));
    expect(applied(update, legacy).ingress).toEqual({
      nginx: { dedicatedIP: '192.168.1.240', isDefault: true },
      traefik: { dedicatedIP: '192.168.1.240', isDefault: false },
    });
  });
});

describe('FeaturesSection', () => {
  const components = releaseManifest().spec!.components!;

  it('turns a feature on and lists what it installs', () => {
    const draft = defaultClusterConfig().spec!;
    const update = vi.fn();
    render(<FeaturesSection {...sectionProps(draft, update)} components={components} />);
    expect(screen.getByText('hangar')).toBeTruthy();
    expect(screen.queryByText('kubevirt-manager')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Argo CD' }));
    expect(applied(update, draft).features?.argocd?.enabled).toBe(true);
  });

  it('marks pending changes on the card', () => {
    const draft = setIn(defaultClusterConfig().spec!, ['features', 'virt', 'enabled'], true);
    render(<FeaturesSection {...sectionProps(draft)} components={components} />);
    expect(screen.getByText('Will be installed')).toBeTruthy();
    expect(screen.getByLabelText('Software emulation')).toBeTruthy();
  });
});

describe('settings that need k4all-operator v0.6.0', () => {
  const components = releaseManifest().spec!.components!;

  it('keeps the OVS bridge and the CNI read-only with an older operator', () => {
    const draft = defaultClusterConfig().spec!;
    render(<FeaturesSection {...sectionProps(draft)} components={components} />);
    expect(screen.queryByRole('checkbox', { name: 'OVS bridge on every node' })).toBeNull();
    expect(screen.getByText('Coming with k4all-operator v0.6.0')).toBeTruthy();
    render(<NetworkingSection {...sectionProps(draft)} nodeConfigs={[]} />);
    expect(screen.queryByRole('combobox', { name: 'CNI' })).toBeNull();
    expect(screen.getAllByText('Coming with k4all-operator v0.6.0')).toHaveLength(2);
  });

  it('keeps them read-only with k4all-operator v0.5.0, the one k4all v2.4.0 pins', () => {
    // v0.5.0 cannot switch the CNI of a running cluster: a cni.type change
    // would re-create every pod network. Plugin 0.1.1 unlocked both here.
    const draft = defaultClusterConfig().spec!;
    const caps = capabilitiesOf('v0.5.0');
    render(<FeaturesSection {...sectionProps(draft, vi.fn(), caps)} components={components} />);
    expect(screen.queryByRole('checkbox', { name: 'OVS bridge on every node' })).toBeNull();
    render(<NetworkingSection {...sectionProps(draft, vi.fn(), caps)} nodeConfigs={[]} />);
    expect(screen.queryByRole('combobox', { name: 'CNI' })).toBeNull();
    expect(screen.getAllByText('Coming with k4all-operator v0.6.0')).toHaveLength(2);
  });

  it('turns them into controls once the operator has the capability', () => {
    const draft = defaultClusterConfig().spec!;
    const update = vi.fn();
    const caps = capabilitiesOf('v0.6.0');
    render(<FeaturesSection {...sectionProps(draft, update, caps)} components={components} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'OVS bridge on every node' }));
    expect(applied(update, draft).features?.ovsBridge?.enabled).toBe(false);
    render(<NetworkingSection {...sectionProps(draft, update, caps)} nodeConfigs={[]} />);
    expect(screen.getByRole('combobox', { name: 'CNI' })).toBeTruthy();
    expect(screen.queryByText('Coming with k4all-operator v0.6.0')).toBeNull();
  });
});

describe('ReviewDialog', () => {
  function reviewFlow(draft: Draft): SaveFlow & { apply: ReturnType<typeof vi.fn> } {
    const base = defaultClusterConfig();
    const items = describeChanges(base.spec!, draft, releaseManifest().spec!.components!);
    return {
      phase: {
        kind: 'review',
        data: {
          base,
          draft,
          ops: buildSpecPatch(base, draft),
          result: { ...base, spec: draft },
          items,
          adjustments: [],
          reapplied: ['headlamp', 'traefik'],
        },
      },
      review: vi.fn(),
      apply: vi.fn(),
      resolve: vi.fn(),
      close: vi.fn(),
    };
  }

  it('lists the changes and applies them', () => {
    const flow = reviewFlow(
      setIn(defaultClusterConfig().spec!, ['features', 'argocd', 'enabled'], true)
    );
    render(<ReviewDialog flow={flow} title="Apply" />);
    expect(screen.getByText(/Installs argocd/)).toBeTruthy();
    expect(screen.getByText(/applies these components again/)).toBeTruthy();
    expect(screen.getByText(/NodePort 32323/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(flow.apply).toHaveBeenCalled();
  });

  it('requires an acknowledgement before a destructive change', () => {
    const on = setIn(defaultClusterConfig().spec!, ['features', 'virt', 'enabled'], true);
    const flow = reviewFlow(on);
    // Turning virtualization off again from a base where it is on:
    const base = { ...defaultClusterConfig(), spec: on };
    const draft = defaultClusterConfig().spec!;
    if (flow.phase.kind === 'review') {
      flow.phase.data.base = base;
      flow.phase.data.items = describeChanges(on, draft, releaseManifest().spec!.components!);
    }
    render(<ReviewDialog flow={flow} title="Apply" />);
    const apply = screen.getByRole('button', { name: 'Apply changes' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
    expect(apply.disabled).toBe(false);
  });

  it('shows conflicts with both values and lets the user pick', () => {
    const flow: SaveFlow = {
      phase: {
        kind: 'conflict',
        theirs: defaultClusterConfig(),
        draft: {},
        result: {
          merged: {},
          conflicts: [
            {
              path: ['a'],
              label: 'ingress.traefik.dedicatedIP',
              base: '',
              theirs: '10.0.0.2',
              mine: '10.0.0.1',
            },
          ],
        },
      },
      review: vi.fn(),
      apply: vi.fn(),
      resolve: vi.fn(),
      close: vi.fn(),
    };
    render(<ReviewDialog flow={flow} title="Apply" />);
    expect(screen.getByText('10.0.0.2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my values' }));
    expect(flow.resolve).toHaveBeenCalledWith('mine');
  });
});
