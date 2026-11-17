import {
  Alert,
  Autocomplete,
  Chip,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import { applyModeOf, FieldId, FIELDS } from '../../model/fields';
import { setIn } from '../../model/objects';
import { isCilium } from '../../model/settings';
import { NodeConfigObject } from '../../model/types';
import { ApplyBadge, CapabilityChip, Mono, Panel, SettingRow } from '../common/ui';
import { FieldMessages, isChanged, SectionProps } from './common';

const TOGGLES: { id: FieldId; key: 'l2announcements' | 'hubble' | 'gatewayAPI' }[] = [
  { id: 'ciliumL2', key: 'l2announcements' },
  { id: 'ciliumHubble', key: 'hubble' },
  { id: 'ciliumGatewayAPI', key: 'gatewayAPI' },
];

/** Interface names the nodes reported (NodeConfig status), as suggestions. */
export function interfaceSuggestions(nodeConfigs: NodeConfigObject[]): string[] {
  const names = new Set<string>();
  for (const nc of nodeConfigs) {
    for (const iface of nc.status?.availableInterfaces ?? []) {
      if (iface.name && iface.name !== 'lo') {
        names.add(iface.name);
      }
    }
  }
  return [...names].sort();
}

/**
 * The CNI: install-time until k4all-operator can migrate the pod network of a
 * running cluster (capability cniSwitch).
 */
function CniPanel(props: SectionProps) {
  const { draft, update, disabled, caps } = props;
  const info = FIELDS.cniType;
  const live = applyModeOf(info, caps) === 'live';
  const cni = draft.networking?.cni?.type ?? 'unknown';
  return (
    <Panel title="CNI" icon="mdi:lan-connect">
      <SettingRow
        label={info.label}
        htmlFor={live ? 'k4all-cni-type' : undefined}
        help={
          live
            ? `${info.help} Switching it migrates every node to the other CNI; pods lose their network until they restart.`
            : `${info.help} ${info.why}`
        }
        badge={live ? <ApplyBadge mode="live" /> : <ApplyBadge mode="install" />}
        changed={isChanged(props, info.path)}
        last
        control={
          live ? (
            <Select
              id="k4all-cni-type"
              size="small"
              value={cni}
              disabled={disabled}
              onChange={e => {
                const next = e.target.value;
                update(d => setIn(d, info.path, next));
              }}
              inputProps={{ 'aria-label': 'CNI' }}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="calico">calico</MenuItem>
              <MenuItem value="cilium">cilium</MenuItem>
            </Select>
          ) : (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography sx={{ fontWeight: 600, fontFamily: 'monospace' }}>{cni}</Typography>
              <CapabilityChip id="cniSwitch" />
            </Stack>
          )
        }
      />
    </Panel>
  );
}

export function NetworkingSection(props: SectionProps & { nodeConfigs: NodeConfigObject[] }) {
  const { draft, update, disabled, issues } = props;

  if (!isCilium(draft)) {
    return (
      <Stack spacing={2}>
        <CniPanel {...props} />
        <Typography variant="body2" color="text.secondary">
          The Cilium options (L2 announcements, Hubble, Gateway API, devices) apply to Cilium
          clusters only.
        </Typography>
      </Stack>
    );
  }

  const devicesPath = FIELDS.ciliumDevices.path;
  const devices = draft.networking?.cni?.cilium?.additionalDevices ?? [];
  const suggestions = interfaceSuggestions(props.nodeConfigs);

  return (
    <Stack spacing={2}>
      <CniPanel {...props} />
      <Alert severity="info">
        These options become Cilium Helm values. Saving a change upgrades Cilium: its agents restart
        one node at a time. Anything else can still be set in <Mono>componentOverrides.cilium</Mono>
        , from the Cilium component page.
      </Alert>
      <Panel title="Cilium" icon="mdi:hexagon-outline">
        {TOGGLES.map(({ id, key }) => {
          const info = FIELDS[id];
          return (
            <SettingRow
              key={id}
              label={info.label}
              htmlFor={`k4all-${id}`}
              help={info.help}
              badge={<ApplyBadge mode="live" />}
              changed={isChanged(props, info.path)}
              control={
                <Switch
                  id={`k4all-${id}`}
                  checked={draft.networking?.cni?.cilium?.[key] === true}
                  disabled={disabled}
                  onChange={(_, checked) => update(d => setIn(d, info.path, checked))}
                  inputProps={{ 'aria-label': info.label }}
                />
              }
            />
          );
        })}
        <SettingRow
          label={FIELDS.ciliumDevices.label}
          help={FIELDS.ciliumDevices.help}
          badge={<ApplyBadge mode="live" />}
          changed={isChanged(props, devicesPath)}
          last
          control={
            <Autocomplete
              multiple
              freeSolo
              size="small"
              disabled={disabled}
              options={suggestions}
              value={devices}
              onChange={(_, value) =>
                update(d =>
                  setIn(
                    d,
                    devicesPath,
                    value.length ? value.map(v => String(v).trim()).filter(Boolean) : undefined
                  )
                )
              }
              renderTags={(value, getTagProps) =>
                value.map((option, index) => {
                  const { key, ...tagProps } = getTagProps({ index });
                  return <Chip key={key} size="small" label={option} {...tagProps} />;
                })
              }
              renderInput={params => (
                <TextField
                  {...params}
                  placeholder={devices.length ? '' : 'auto-detect'}
                  inputProps={{ ...params.inputProps, 'aria-label': 'Cilium devices' }}
                />
              )}
              sx={{ width: 320 }}
            />
          }
          messages={<FieldMessages issues={issues} field="ciliumDevices" />}
        />
      </Panel>
    </Stack>
  );
}
