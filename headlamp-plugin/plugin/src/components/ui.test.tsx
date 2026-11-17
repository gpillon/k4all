/*
 * Rendering tests of the presentational parts: the settings sections and the
 * review dialog. Headlamp itself is not needed for these; icons are stubbed
 * so Iconify does not try to download them.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { describeChanges } from '../model/changes';
import { defaultClusterConfig, releaseManifest } from '../model/fixtures';
import { setIn } from '../model/objects';
import { buildSpecPatch } from '../model/patch';
import { Draft, setTraefik } from '../model/settings';
import { validateSettings } from '../model/validation';
import { ReviewDialog } from './review/ReviewDialog';
import { SaveFlow } from './review/useSaveFlow';
import { FeaturesSection } from './settings/FeaturesSection';
import { IngressSection } from './settings/IngressSection';

vi.mock('@iconify/react', () => ({ Icon: () => null }));

function sectionProps(draft: Draft, update = vi.fn()) {
  const base = defaultClusterConfig().spec!;
  return { draft, base, update, disabled: false, issues: validateSettings(draft), status: {} };
}

/** Runs the update function a section passed to its `update` callback. */
function applied(update: ReturnType<typeof vi.fn>, draft: Draft): Draft {
  expect(update).toHaveBeenCalled();
  const fn = update.mock.calls[update.mock.calls.length - 1][0] as (d: Draft) => Draft;
  return fn(draft);
}

describe('IngressSection', () => {
  it('writes the Traefik IP, mirrored for MetalLB, when the user types it', () => {
    const draft = defaultClusterConfig().spec!;
    const update = vi.fn();
    render(<IngressSection {...sectionProps(draft, update)} />);
    fireEvent.change(screen.getByLabelText('Traefik dedicated IP'), {
      target: { value: ' 192.168.1.240 ' },
    });
    const next = applied(update, draft);
    expect(next.ingress?.traefik).toEqual({ dedicatedIP: '192.168.1.240', isDefault: true });
    expect(next.ingress?.nginx?.dedicatedIP).toBe('192.168.1.240');
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

  it('offers to move pre-v2.6.0 settings to spec.ingress.traefik', () => {
    const legacy: Draft = {
      networking: { cni: { type: 'calico' } },
      ingress: { nginx: { dedicatedIP: '', isDefault: true } },
    };
    const update = vi.fn();
    render(<IngressSection {...sectionProps(legacy, update)} base={legacy} />);
    fireEvent.click(screen.getByRole('button', { name: /Move to spec.ingress.traefik/ }));
    expect(applied(update, legacy).ingress?.traefik).toEqual({ dedicatedIP: '', isDefault: true });
  });
});

describe('FeaturesSection', () => {
  const components = releaseManifest().spec!.components!;

  it('turns a feature on and lists what it installs', () => {
    const draft = defaultClusterConfig().spec!;
    const update = vi.fn();
    render(<FeaturesSection {...sectionProps(draft, update)} components={components} />);
    expect(screen.getByText('kubevirt-manager')).toBeTruthy();
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
