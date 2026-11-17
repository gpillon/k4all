import { Icon } from '@iconify/react';
import {
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
import { componentActivation } from '../../model/components';
import { FIELDS } from '../../model/fields';
import { setIn } from '../../model/objects';
import { emulationMode } from '../../model/settings';
import { ComponentSpec } from '../../model/types';
import { ApplyBadge, TonePill } from '../common/ui';
import { isChanged, SectionProps } from './common';

type FeatureKey = 'virt' | 'argocd' | 'ovsCni';

interface FeatureDef {
  key: FeatureKey;
  icon: string;
  label: string;
  help: string;
  readyKey: 'virtReady' | 'argocdReady' | 'ovsCniReady';
}

const FEATURES: FeatureDef[] = [
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

function componentsFor(feature: FeatureKey, components: Record<string, ComponentSpec>): string[] {
  return Object.entries(components)
    .filter(([name, spec]) => componentActivation(name, spec, {}).feature === feature)
    .map(([name]) => name)
    .sort();
}

function FeatureCard(
  props: SectionProps & { def: FeatureDef; components: Record<string, ComponentSpec> }
) {
  const theme = useTheme();
  const { def, draft, base, update, disabled } = props;
  const path = ['features', def.key, 'enabled'];
  const enabled = draft.features?.[def.key]?.enabled === true;
  const wasEnabled = base.features?.[def.key]?.enabled === true;
  const changed =
    isChanged(props, path) || (def.key === 'virt' && isChanged(props, FIELDS.virtEmulation.path));
  const ready = props.status?.features?.[def.readyKey];
  const names = componentsFor(def.key, props.components);
  const id = `k4all-feature-${def.key}`;

  let status: React.ReactNode;
  if (enabled !== wasEnabled) {
    status = <TonePill tone="info" label={enabled ? 'Will be installed' : 'Will be removed'} />;
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
            onChange={(_, checked) => update(d => setIn(d, path, checked))}
            inputProps={{ 'aria-label': def.label }}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {def.help}
        </Typography>
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
      </CardContent>
    </Card>
  );
}

export function FeaturesSection(
  props: SectionProps & { components: Record<string, ComponentSpec> }
) {
  const ovsBridge = props.draft.features?.ovsBridge?.enabled === true;
  return (
    <Grid container spacing={2}>
      {FEATURES.map(def => (
        <Grid item xs={12} md={6} xl={4} key={def.key}>
          <FeatureCard {...props} def={def} />
        </Grid>
      ))}
      <Grid item xs={12} md={6} xl={4}>
        <Card variant="outlined" sx={{ height: '100%', borderRadius: 2, borderStyle: 'dashed' }}>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Icon icon="mdi:bridge" width={24} height={24} />
                <Typography sx={{ fontWeight: 600 }}>{FIELDS.ovsBridgeEnabled.label}</Typography>
              </Stack>
              <ApplyBadge mode="install" />
            </Stack>
            <Box sx={{ mt: 1 }}>
              <TonePill tone={ovsBridge ? 'success' : 'neutral'} label={ovsBridge ? 'On' : 'Off'} />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              {FIELDS.ovsBridgeEnabled.help} {FIELDS.ovsBridgeEnabled.why}
            </Typography>
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}
