/*
 * Settings → Upgrades (the remediation modes, k4all-operator v0.7.0) and the
 * node-settings rollout's blockers, approvals and records.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { capabilitiesOf } from '../model/capabilities';
import { describeChanges } from '../model/changes';
import {
  barePodFinding,
  clusterConfigV270,
  clusterUpgradeBlocked,
  cnpgFinding,
} from '../model/fixtures';
import { rolloutView } from '../model/nodeSettings';
import { buildSpecPatch } from '../model/patch';
import { Draft } from '../model/settings';
import { ClusterConfigObject } from '../model/types';
import { validateSettings } from '../model/validation';
import { RolloutPanel } from './nodes/nodeSettingsSections';
import { UpgradesSection } from './settings/UpgradesSection';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Utils: { getCluster: () => 'main' },
  Router: { createRouteURL: (name: string) => `/c/main/${name}` },
}));

const V070 = capabilitiesOf('v0.7.0');
const V061 = capabilitiesOf('v0.6.1');

function props(draft: Draft, opts: { update?: ReturnType<typeof vi.fn>; caps?: typeof V070 } = {}) {
  return {
    draft,
    base: clusterConfigV270().spec!,
    update: opts.update ?? vi.fn(),
    disabled: false,
    issues: validateSettings(draft),
    status: {},
    caps: opts.caps ?? V070,
  };
}

function applied(update: ReturnType<typeof vi.fn>, draft: Draft): Draft {
  const fn = update.mock.calls[update.mock.calls.length - 1][0] as (d: Draft) => Draft;
  return fn(draft);
}

function options(label: string): HTMLElement[] {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  return within(screen.getByRole('listbox')).getAllByRole('option');
}

describe('Settings → Upgrades', () => {
  it('lists the catalog with each risk spelled out, ask by default', () => {
    render(<UpgradesSection {...props(clusterConfigV270().spec!)} />);
    const table = screen.getByRole('table', { name: 'Remediation modes' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 9);
    expect(
      within(table).getByText(
        'The database is down until the node is back, on network storage too.'
      )
    ).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Mode of vm-stop-start' }).textContent).toBe(
      'ask (default)'
    );
    // built in, no mode
    expect(within(table).getByText('built in, no mode')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Mode of ceph-wait-health' })).toBeNull();
  });

  it('disables auto for the entries that are not autoAllowed, with the reason', () => {
    render(<UpgradesSection {...props(clusterConfigV270().spec!)} />);
    for (const id of ['cnpg-add-replica', 'pdb-scale-up', 'pdb-relax-for-node', 'acknowledge']) {
      const auto = options(`Mode of ${id}`).find(o => o.textContent?.startsWith('auto'))!;
      expect(auto.getAttribute('aria-disabled')).toBe('true');
      expect(auto.textContent).toMatch(/not allowed: /);
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    }
    for (const id of [
      'cnpg-disable-pdb',
      'cnpg-maintenance-window',
      'vm-migrate-first',
      'vm-stop-start',
    ]) {
      const auto = options(`Mode of ${id}`).find(o => o.textContent?.startsWith('auto'))!;
      expect(auto.getAttribute('aria-disabled')).toBeNull();
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    }
  }, 20000);

  it('writes spec.upgrades.remediations as JSON, off a string', () => {
    const update = vi.fn();
    const draft = clusterConfigV270().spec!;
    render(<UpgradesSection {...props(draft, { update })} />);
    fireEvent.click(
      options('Mode of pdb-relax-for-node').find(o => o.textContent?.startsWith('off'))!
    );
    const next = applied(update, draft);
    expect(next.upgrades).toEqual({ remediations: { 'pdb-relax-for-node': 'off' } });
    const ops = buildSpecPatch(clusterConfigV270(), next);
    expect(JSON.parse(JSON.stringify(ops))).toContainEqual({
      op: 'add',
      path: '/spec/upgrades',
      value: { remediations: { 'pdb-relax-for-node': 'off' } },
    });
    const items = describeChanges(draft, next);
    expect(items).toEqual([
      expect.objectContaining({
        key: 'upgrades.remediations.pdb-relax-for-node',
        label: "Mode of Relax the budget for the node's hop",
        from: 'ask (default)',
        to: 'off',
      }),
    ]);
    expect(items[0].consequence).toMatch(/still holds the node until you fix it or accept/);
  });

  it('shows an id it does not know read-only, and the UnknownRemediation condition', () => {
    const draft = {
      ...clusterConfigV270().spec!,
      upgrades: { remediations: { 'zalando-add-replica': 'auto', 'pdb-scale-up': 'auto' } },
    };
    render(
      <UpgradesSection
        {...props(draft)}
        status={{
          conditions: [
            {
              type: 'UnknownRemediation',
              status: 'True',
              reason: 'UnknownId',
              message: 'zalando-add-replica is not in the catalog; pdb-scale-up may not be auto',
            },
          ],
        }}
      />
    );
    expect(screen.getByText('k4all-operator ignores some entries')).toBeTruthy();
    expect(screen.getByText(/zalando-add-replica is not in the catalog/)).toBeTruthy();
    expect(screen.getByText('unknown to this addon')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Mode of zalando-add-replica' })).toBeNull();
    expect(
      screen.getByText(/auto is not allowed here: k4all-operator reads it as ask/)
    ).toBeTruthy();
  });

  it('is read-only with an operator before v0.7.0', () => {
    render(<UpgradesSection {...props(clusterConfigV270().spec!, { caps: V061 })} />);
    expect(
      screen.getByText(/Remediation modes need k4all-operator v0.7.0 \(k4all v2.7.2\)/)
    ).toBeTruthy();
    for (const box of screen.getAllByRole('combobox')) {
      expect(box.getAttribute('aria-disabled')).toBe('true');
    }
  });
});

describe('the node-settings rollout with blockers (operator v0.7.0)', () => {
  function rolloutConfig(): ClusterConfigObject {
    const cc = clusterConfigV270();
    cc.spec!.nodes = { kubelet: { cpuManagerPolicy: 'static', reservedSystemCPUs: '0' } };
    cc.status = {
      conditions: [
        {
          type: 'NodeSettingsRollout',
          status: 'False',
          reason: 'WaitingForApproval',
          message: 'w-1 waits for an answer',
        },
      ],
      nodes: {
        settingsHash: '3f9c0a1b2c3d4e5f',
        rollout: { phase: 'Blocked', currentNode: 'w-1', message: 'w-1 waits for an answer' },
        perNode: [
          // the operator keeps v0.6.1's text in the message: the structured blockers win
          {
            name: 'w-1',
            phase: 'Pending',
            message:
              'runs pods that declare no controller: default/debug (a drain would delete them, and nothing recreates them: delete them, or recreate them under a controller; see docs/upgrades.md, Pods that declare no controller); the node is not cordoned',
            blockers: [cnpgFinding(), barePodFinding()],
          },
          { name: 'cp-1', phase: 'Pending' },
        ],
        remediations: clusterUpgradeBlocked().status!.remediations!.map(r => ({
          ...r,
          hop: 'nodes-3f9c0a1b2c3d4e5f',
        })),
      },
    };
    return cc;
  }

  it('reads the structured blockers, and the text only without them', () => {
    const view = rolloutView(rolloutConfig());
    expect(view.structured).toBe(true);
    expect(view.drainBlock).toBeUndefined();
    expect(view.settingsHash).toBe('3f9c0a1b2c3d4e5f');
    const old = rolloutConfig();
    delete old.status!.nodes!.perNode![0].blockers;
    expect(rolloutView(old).drainBlock?.node).toBe('w-1');
  });

  it('answers a blocker with an approval for the settings hash', () => {
    const onAnswer = vi.fn();
    render(
      <RolloutPanel
        view={rolloutView(rolloutConfig())}
        canPause
        busy={false}
        onPause={vi.fn()}
        readiness
        onAnswer={onAnswer}
      />
    );
    const held = screen.getByRole('region', { name: 'What holds w-1' });
    expect(within(held).getAllByRole('group')).toHaveLength(2);
    expect(screen.getByText(/The next node waits for an answer/)).toBeTruthy();
    fireEvent.click(
      within(held).getByRole('button', { name: 'Apply fix cnpg-add-replica for Cluster db/app-pg' })
    );
    expect(onAnswer).toHaveBeenCalledWith({
      remediation: 'cnpg-add-replica',
      target: cnpgFinding().object,
      decision: 'Apply',
    });
    // the parsed advice is not shown next to the structured list
    expect(screen.queryByText('w-1 runs pods that declare no controller')).toBeNull();
    expect(screen.getByRole('table', { name: 'What k4all changed' })).toBeTruthy();
  });

  it('shows the blockers and records read-only to a viewer, and nothing new without the capability', () => {
    const { unmount } = render(
      <RolloutPanel
        view={rolloutView(rolloutConfig())}
        canPause={false}
        busy={false}
        onPause={vi.fn()}
        readiness
      />
    );
    expect(screen.getByRole('region', { name: 'What holds w-1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Apply fix|Accept)/ })).toBeNull();
    unmount();
    const old = rolloutConfig();
    delete old.status!.nodes!.perNode![0].blockers;
    render(<RolloutPanel view={rolloutView(old)} canPause busy={false} onPause={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'What holds w-1' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'What k4all changed' })).toBeNull();
    expect(screen.getByText('w-1 runs pods that declare no controller')).toBeTruthy();
  });
});
