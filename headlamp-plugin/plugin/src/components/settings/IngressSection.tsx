import { Icon } from '@iconify/react';
import { Alert, Box, Stack, Switch, TextField, Typography } from '@mui/material';
import React from 'react';
import { FIELDS } from '../../model/fields';
import { setIn } from '../../model/objects';
import {
  effectiveIngress,
  INGRESS_LABEL,
  IngressController,
  ingressExposure,
  isCilium,
  setIngress,
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

export function IngressSection(props: SectionProps & { controller?: IngressController }) {
  const { draft, base, update, disabled, issues } = props;
  const controller = props.controller ?? 'traefik';
  const name = INGRESS_LABEL[controller];
  const isTraefik = controller === 'traefik';
  const current = effectiveIngress(draft, controller);
  const before = effectiveIngress(base, controller);
  // Before the operator migrates the key (v0.4.2), Traefik runs on the
  // values it inherited; the first change saves them to spec.ingress.traefik.
  const inherited = isTraefik && current.source === 'nginx';
  const exposure = ingressExposure(draft, controller);
  const ciliumIP = draft.ingress?.cilium?.dedicatedIP ?? '';
  const set = (change: { dedicatedIP?: string; isDefault?: boolean }) =>
    update(d => setIngress(d, controller, change));

  return (
    <Stack spacing={2}>
      {inherited && (
        <Alert severity="info">
          Traefik runs on the settings it inherited when it replaced the previous ingress
          controller. A change here saves them to <Mono>spec.ingress.traefik</Mono>.
        </Alert>
      )}
      {!isTraefik && (
        <Alert severity="info">
          This release runs ingress-nginx, configured by <Mono>spec.ingress.nginx</Mono>. k4all
          v2.6.0 replaces it with Traefik, which takes over these settings and keeps serving the
          Ingresses of class <Mono>nginx</Mono>.
        </Alert>
      )}

      <Panel
        title={name}
        icon={isTraefik ? 'mdi:traffic-light-outline' : 'mdi:routes'}
        action={<Mono>{isTraefik ? 'spec.ingress.traefik' : 'spec.ingress.nginx'}</Mono>}
      >
        <SettingRow
          label={FIELDS.traefikIP.label}
          htmlFor="k4all-ingress-ip"
          help={`A LoadBalancer address for ${name}. ${FIELDS.traefikIP.help}`}
          badge={<ApplyBadge mode="live" />}
          changed={before.dedicatedIP !== current.dedicatedIP}
          control={
            <IPField
              id="k4all-ingress-ip"
              label={`${name} dedicated IP`}
              value={current.dedicatedIP}
              disabled={disabled}
              error={firstError(issues, 'traefikIP')}
              onChange={ip => set({ dedicatedIP: ip })}
            />
          }
          messages={<FieldMessages issues={issues} field="traefikIP" />}
        />
        <SettingRow
          label={FIELDS.traefikDefault.label}
          htmlFor="k4all-ingress-default"
          help={`Ingresses without an ingressClassName are served by ${name}.`}
          badge={<ApplyBadge mode="live" />}
          changed={before.isDefault !== current.isDefault}
          last
          control={
            <Switch
              id="k4all-ingress-default"
              checked={current.isDefault}
              disabled={disabled}
              onChange={(_, checked) => set({ isDefault: checked })}
              inputProps={{ 'aria-label': `${name} is the default IngressClass` }}
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
            Result: {exposure.summary}
            {isTraefik &&
              " Ingresses of class nginx keep working through Traefik's ingress-nginx provider."}
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
