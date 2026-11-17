import { Icon } from '@iconify/react';
import { Alert, Box, Button, Stack, Switch, TextField, Typography } from '@mui/material';
import React from 'react';
import { FIELDS } from '../../model/fields';
import { setIn } from '../../model/objects';
import {
  adoptTraefikKey,
  effectiveTraefik,
  isCilium,
  MIRROR_TRAEFIK_IP_TO_NGINX,
  nginxFollowsTraefik,
  setTraefik,
  traefikExposure,
} from '../../model/settings';
import { ApplyBadge, Mono, Panel, SettingRow } from '../common/ui';
import { FieldMessages, firstError, isChanged, SectionProps } from './common';

/**
 * A text field that edits locally and commits on every keystroke, so
 * validation and the "changed" marker follow typing.
 */
function IPField(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error?: string;
  label: string;
}) {
  return (
    <TextField
      id={props.id}
      size="small"
      value={props.value}
      placeholder="node address"
      disabled={props.disabled}
      error={!!props.error}
      onChange={e => props.onChange(e.target.value.trim())}
      inputProps={{
        'aria-label': props.label,
        spellCheck: false,
        style: { fontFamily: 'monospace' },
      }}
      sx={{ width: 260 }}
    />
  );
}

export function IngressSection(props: SectionProps) {
  const { draft, base, update, disabled, issues } = props;
  const traefik = effectiveTraefik(draft);
  const legacy = effectiveTraefik(base).source !== 'traefik' && traefik.source !== 'traefik';
  const exposure = traefikExposure(draft);
  const traefikIPChanged = effectiveTraefik(base).dedicatedIP !== traefik.dedicatedIP;
  const traefikDefaultChanged = effectiveTraefik(base).isDefault !== traefik.isDefault;
  const ciliumIP = draft.ingress?.cilium?.dedicatedIP ?? '';
  const mirrored =
    MIRROR_TRAEFIK_IP_TO_NGINX &&
    traefik.dedicatedIP !== '' &&
    nginxFollowsTraefik(draft, traefik.dedicatedIP);

  return (
    <Stack spacing={2}>
      {legacy && (
        <Alert
          severity="info"
          action={
            !disabled && (
              <Button color="inherit" size="small" onClick={() => update(adoptTraefikKey)}>
                Move to spec.ingress.traefik
              </Button>
            )
          }
        >
          This cluster was installed before k4all v2.6.0: Traefik takes its settings from{' '}
          <Mono>spec.ingress.nginx</Mono>. Saving a change here writes{' '}
          <Mono>spec.ingress.traefik</Mono> with the same values.
        </Alert>
      )}

      <Panel title="Traefik" icon="mdi:traffic-light-outline">
        <SettingRow
          label={FIELDS.traefikIP.label}
          htmlFor="k4all-traefik-ip"
          help={FIELDS.traefikIP.help}
          badge={<ApplyBadge mode="live" />}
          changed={traefikIPChanged}
          control={
            <IPField
              id="k4all-traefik-ip"
              label="Traefik dedicated IP"
              value={traefik.dedicatedIP}
              disabled={disabled}
              error={firstError(issues, 'traefikIP')}
              onChange={ip => update(d => setTraefik(d, { dedicatedIP: ip }))}
            />
          }
          messages={
            <Stack spacing={0.75}>
              <FieldMessages issues={issues} field="traefikIP" />
              {mirrored && (
                <Typography variant="caption" color="text.secondary">
                  Also written to <Mono>spec.ingress.nginx.dedicatedIP</Mono>: k4all-operator v0.3.0
                  builds the MetalLB address pool from that key.
                </Typography>
              )}
            </Stack>
          }
        />
        <SettingRow
          label={FIELDS.traefikDefault.label}
          htmlFor="k4all-traefik-default"
          help={FIELDS.traefikDefault.help}
          badge={<ApplyBadge mode="live" />}
          changed={traefikDefaultChanged}
          last
          control={
            <Switch
              id="k4all-traefik-default"
              checked={traefik.isDefault}
              disabled={disabled}
              onChange={(_, checked) => update(d => setTraefik(d, { isDefault: checked }))}
              inputProps={{ 'aria-label': 'Traefik is the default IngressClass' }}
            />
          }
        />
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ mt: 1.5, color: 'text.secondary' }}
        >
          <Icon icon="mdi:information-outline" width={18} height={18} />
          <Typography variant="body2">
            Result: {exposure.summary} Ingresses of class <Mono>nginx</Mono> keep working through
            Traefik's ingress-nginx provider.
          </Typography>
        </Stack>
      </Panel>

      <Panel title="Cilium ingress" icon="mdi:hexagon-outline">
        {!isCilium(draft) && ciliumIP === '' ? (
          <Typography variant="body2" color="text.secondary">
            Only used with the Cilium CNI; this cluster runs{' '}
            {draft.networking?.cni?.type ?? 'another CNI'}.
          </Typography>
        ) : (
          <SettingRow
            label={FIELDS.ciliumIngressIP.label}
            htmlFor="k4all-cilium-ip"
            help={FIELDS.ciliumIngressIP.help}
            badge={<ApplyBadge mode="live" />}
            changed={isChanged(props, FIELDS.ciliumIngressIP.path)}
            last
            control={
              <IPField
                id="k4all-cilium-ip"
                label="Cilium ingress dedicated IP"
                value={ciliumIP}
                disabled={disabled}
                error={firstError(issues, 'ciliumIngressIP')}
                onChange={ip => update(d => setIn(d, FIELDS.ciliumIngressIP.path, ip))}
              />
            }
            messages={<FieldMessages issues={issues} field="ciliumIngressIP" />}
          />
        )}
      </Panel>
      <Box />
    </Stack>
  );
}
