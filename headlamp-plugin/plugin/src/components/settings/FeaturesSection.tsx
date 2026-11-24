import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  alpha,
  Box,
  Card,
  CardContent,
  Chip,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
  useTheme,
} from '@mui/material';
import React from 'react';
import { featureOffConsequence } from '../../model/changes';
import {
  belongsTo,
  componentActivation,
  ComponentNotice,
  componentNotice,
  Feature,
  FEATURE_LABEL,
} from '../../model/components';
import { applyModeOf, FIELDS } from '../../model/fields';
import { getIn, setIn, setPruned } from '../../model/objects';
import { emulationMode } from '../../model/settings';
import { ComponentSpec, ComponentStatus } from '../../model/types';
import { ApplyBadge, CapabilityChip, Mono, TonePill } from '../common/ui';
import { isChanged, SectionProps } from './common';

export interface FeatureDef {
  key: Feature;
  icon: string;
  label: string;
  help: string;
  /** status.features key; features without one pass `ready` to the card. */
  readyKey?: 'virtReady' | 'argocdReady' | 'ovsCniReady';
}

export const ROOK_FEATURE: FeatureDef = {
  key: 'rook',
  icon: 'mdi:database-outline',
  label: FEATURE_LABEL.rook,
  help: FIELDS.rookEnabled.help,
};

export const FEATURES: FeatureDef[] = [
  {
    key: 'virt',
    icon: 'mdi:monitor-multiple',
    label: FIELDS.virtEnabled.label,
    help: FIELDS.virtEnabled.help,
    readyKey: 'virtReady',
  },
  {
    key: 'argocd',
    icon: 'mdi:source-branch-sync',
    label: FIELDS.argocdEnabled.label,
    help: FIELDS.argocdEnabled.help,
    readyKey: 'argocdReady',
  },
  {
    key: 'ovsCni',
    icon: 'mdi:lan',
    label: FIELDS.ovsCniEnabled.label,
    help: FIELDS.ovsCniEnabled.help,
    readyKey: 'ovsCniReady',
  },
];

function componentsFor(feature: Feature, components: Record<string, ComponentSpec>): string[] {
  return Object.entries(components)
    .filter(
      ([name, spec]) =>
        spec.management !== 'Removed' && belongsTo(componentActivation(name, spec, {}), feature)
    )
    .map(([name]) => name)
    .sort();
}

export interface FeatureCardProps extends SectionProps {
  def: FeatureDef;
  components: Record<string, ComponentSpec>;
  /** The ReleaseManifest status of each component. */
  statuses?: Record<string, ComponentStatus>;
  /** Readiness for features without a status.features key (Rook: the RookReady condition). */
  ready?: boolean;
  /** More content under the switch. */
  children?: React.ReactNode;
}

type Notice = ComponentNotice & { name: string };

export function FeatureCard(props: FeatureCardProps) {
  const theme = useTheme();
  const { def, draft, base, update, disabled } = props;
  const path = ['features', def.key, 'enabled'];
  const enabled = draft.features?.[def.key]?.enabled === true;
  const wasEnabled = base.features?.[def.key]?.enabled === true;
  const changed =
    isChanged(props, path) || (def.key === 'virt' && isChanged(props, FIELDS.virtEmulation.path));
  const ready = def.readyKey ? props.status?.features?.[def.readyKey] : props.ready;
  const names = componentsFor(def.key, props.components);
  const id = `k4all-feature-${def.key}`;
  // Components k4all-operator keeps installed though the feature is off
  // ("uninstall refused: "), or that wait for something ("waiting: ").
  const notices = names
    .map(name => ({ name, notice: componentNotice(props.statuses?.[name]) }))
    .filter((r): r is { name: string; notice: ComponentNotice } => !!r.notice)
    .map((r): Notice => ({ name: r.name, ...r.notice }));
  // What turning it off removes: not what another feature keeps (the snapshot controller).
  const removed = names.filter(name => {
    const spec = props.components[name];
    return (
      componentActivation(name, spec, base).active && !componentActivation(name, spec, draft).active
    );
  });
  const refusals = notices.filter(n => n.kind === 'refused');
  const waits = notices.filter(n => n.kind === 'waiting');

  let status: React.ReactNode;
  if (enabled !== wasEnabled) {
    status = <TonePill tone="info" label={enabled ? 'Will be installed' : 'Will be removed'} />;
  } else if (!enabled && refusals.length > 0) {
    status = <TonePill tone="warning" label="Removal refused" />;
  } else if (!enabled) {
    status = <TonePill tone="neutral" label="Off" />;
  } else {
    status = ready ? (
      <TonePill tone="success" label="Ready" />
    ) : (
      <TonePill tone="info" busy label="Installing" />
    );
  }

  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        borderRadius: 2,
        borderColor: changed ? 'primary.main' : undefined,
        backgroundColor: enabled
          ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.08 : 0.03)
          : undefined,
        transition: 'background-color 150ms, border-color 150ms',
      }}
    >
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: 1.5,
                display: 'grid',
                placeItems: 'center',
                color: enabled ? 'primary.main' : 'text.secondary',
                backgroundColor: theme.palette.action.hover,
              }}
            >
              <Icon icon={def.icon} width={24} height={24} />
            </Box>
            <Box>
              <Typography component="label" htmlFor={id} sx={{ fontWeight: 600, display: 'block' }}>
                {def.label}
              </Typography>
              {status}
            </Box>
          </Stack>
          <Switch
            id={id}
            checked={enabled}
            disabled={disabled}
            onChange={(_, checked) =>
              // Off where the spec had no value (features.rook on most clusters) leaves none.
              update(d =>
                checked || getIn(base, path) !== undefined
                  ? setIn(d, path, checked)
                  : setPruned(d, path, undefined)
              )
            }
            inputProps={{ 'aria-label': def.label }}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {def.help}
        </Typography>
        {(def.key === 'virt' || def.key === 'rook') && wasEnabled && !enabled && (
          <Alert
            severity={def.key === 'rook' || props.caps.virtUninstallGuard ? 'warning' : 'error'}
            sx={{ mt: 1.5 }}
          >
            {featureOffConsequence(
              def.key,
              removed.length ? removed.join(', ') : 'its components',
              props.caps
            )}
          </Alert>
        )}
        {refusals.length > 0 && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            <AlertTitle>k4all-operator keeps these installed</AlertTitle>
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2 }}>
              {refusals.map(r => (
                <li key={r.name}>
                  <Mono>{r.name}</Mono>: <span>{r.text}</span>
                </li>
              ))}
            </Stack>
          </Alert>
        )}
        {waits.length > 0 && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            <AlertTitle>Waiting</AlertTitle>
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2 }}>
              {waits.map(r => (
                <li key={r.name}>
                  <Mono>{r.name}</Mono>: <span>{r.text}</span>
                </li>
              ))}
            </Stack>
          </Alert>
        )}
        {names.length > 0 && (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
            {names.map(n => (
              <Chip key={n} size="small" variant="outlined" label={n} />
            ))}
          </Stack>
        )}
        {def.key === 'virt' && enabled && (
          <FormControl size="small" sx={{ mt: 2, minWidth: 220 }} disabled={disabled}>
            <InputLabel id="k4all-virt-emulation-label">{FIELDS.virtEmulation.label}</InputLabel>
            <Select
              labelId="k4all-virt-emulation-label"
              label={FIELDS.virtEmulation.label}
              value={emulationMode(draft)}
              onChange={e => {
                const mode = e.target.value;
                update(d => setIn(d, FIELDS.virtEmulation.path, mode));
              }}
            >
              <MenuItem value="auto">auto: use /dev/kvm when present</MenuItem>
              <MenuItem value="false">off: hardware virtualization only</MenuItem>
              <MenuItem value="true">on: always emulate (slow)</MenuItem>
            </Select>
          </FormControl>
        )}
        {props.children}
      </CardContent>
    </Card>
  );
}

/**
 * The OVS bridge: set at installation until k4all-operator can move node
 * addresses onto the bridge and back (capability ovsBridgeToggle).
 */
function OvsBridgeCard(props: SectionProps) {
  const { draft, base, update, disabled, caps } = props;
  const info = FIELDS.ovsBridgeEnabled;
  const enabled = draft.features?.ovsBridge?.enabled === true;
  const live = applyModeOf(info, caps) === 'live';
  const changed = isChanged(props, info.path);
  const wasEnabled = base.features?.ovsBridge?.enabled === true;
  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        borderRadius: 2,
        borderStyle: live ? 'solid' : 'dashed',
        borderColor: changed ? 'primary.main' : undefined,
      }}
    >
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Icon icon="mdi:bridge" width={24} height={24} />
            <Typography
              component={live ? 'label' : 'span'}
              htmlFor={live ? 'k4all-feature-ovsBridge' : undefined}
              sx={{ fontWeight: 600 }}
            >
              {info.label}
            </Typography>
          </Stack>
          {live ? (
            <Switch
              id="k4all-feature-ovsBridge"
              checked={enabled}
              disabled={disabled}
              onChange={(_, checked) => update(d => setIn(d, info.path, checked))}
              inputProps={{ 'aria-label': info.label }}
            />
          ) : (
            <ApplyBadge mode="install" />
          )}
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
          {enabled !== wasEnabled ? (
            <TonePill tone="info" label={enabled ? 'Will be turned on' : 'Will be turned off'} />
          ) : (
            <TonePill tone={enabled ? 'success' : 'neutral'} label={enabled ? 'On' : 'Off'} />
          )}
          {!live && <CapabilityChip id="ovsBridgeToggle" />}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {info.help}{' '}
          {live
            ? 'Changing it moves every node address between its interface and the bridge, one node at a time.'
            : info.why}
        </Typography>
      </CardContent>
    </Card>
  );
}

export function FeaturesSection(
  props: SectionProps & {
    components: Record<string, ComponentSpec>;
    statuses?: Record<string, ComponentStatus>;
  }
) {
  return (
    <Grid container spacing={2}>
      {FEATURES.map(def => (
        <Grid item xs={12} md={6} xl={4} key={def.key}>
          <FeatureCard {...props} def={def} />
        </Grid>
      ))}
      <Grid item xs={12} md={6} xl={4}>
        <OvsBridgeCard {...props} />
      </Grid>
    </Grid>
  );
}
