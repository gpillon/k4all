import { Icon } from '@iconify/react';
import { Box, Grid, Stack, Tooltip, Typography } from '@mui/material';
import React from 'react';
import { Capabilities } from '../../model/capabilities';
import { formatValue } from '../../model/changes';
import { applyModeOf, FieldId, FieldInfo, FIELDS } from '../../model/fields';
import { getIn } from '../../model/objects';
import { ClusterConfigSpec } from '../../model/types';
import { ApplyBadge, CapabilityChip, Panel } from '../common/ui';

const GROUPS: { title: string; icon: string; fields: FieldId[] }[] = [
  {
    title: 'Cluster network',
    icon: 'mdi:ip-network-outline',
    fields: ['cniType', 'podNetwork', 'serviceNetwork'],
  },
  { title: 'API endpoint', icon: 'mdi:api', fields: ['apiHostname', 'customApiEndpoint'] },
  {
    title: 'Control plane HA',
    icon: 'mdi:server-network',
    fields: ['haType', 'haVIP', 'haSubnet', 'haInterface'],
  },
  {
    title: 'Nodes',
    icon: 'mdi:server-outline',
    fields: ['firewalld', 'ovsBridgeEnabled', 'httpProxy', 'httpsProxy', 'noProxy'],
  },
];

function LockedRow(props: { id: FieldId; spec: ClusterConfigSpec; caps: Capabilities }) {
  const info: FieldInfo = FIELDS[props.id];
  const live = applyModeOf(info, props.caps) === 'live';
  const value = getIn(props.spec, info.path);
  const fallback = info.fallback;
  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="flex-start"
      spacing={2}
      sx={{ py: 1 }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {info.label}
          </Typography>
          <Tooltip title={`${info.help} ${info.why ?? ''}`}>
            <Box
              component="span"
              sx={{ display: 'inline-flex', color: 'text.secondary', cursor: 'help' }}
              tabIndex={0}
              aria-label={`Why ${info.label} is read-only`}
            >
              <Icon icon="mdi:help-circle-outline" width={16} height={16} />
            </Box>
          </Tooltip>
        </Stack>
        {info.liveWith && !live && (
          <Box sx={{ mt: 0.5 }}>
            <CapabilityChip id={info.liveWith} />
          </Box>
        )}
        {live && (
          <Typography variant="caption" color="text.secondary">
            Editable in the {info.group === 'features' ? 'Features' : 'Networking'} tab.
          </Typography>
        )}
      </Box>
      <Typography
        variant="body2"
        sx={{
          fontFamily: 'monospace',
          textAlign: 'right',
          wordBreak: 'break-all',
          color: value === undefined || value === '' ? 'text.secondary' : 'text.primary',
        }}
      >
        {formatValue(value, fallback)}
      </Typography>
    </Stack>
  );
}

export function InstallTimeSection(props: { spec: ClusterConfigSpec; caps: Capabilities }) {
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
        <Icon icon="mdi:lock-outline" width={18} height={18} />
        <Typography variant="body2">
          These settings were fixed when the cluster was installed, or are read by the nodes from{' '}
          <code>/etc/k4all-config.yaml</code>. They are shown for reference; hover the help icons
          for the reason.
        </Typography>
      </Stack>
      <Grid container spacing={2}>
        {GROUPS.map(group => (
          <Grid item xs={12} md={6} key={group.title}>
            <Panel
              title={group.title}
              icon={group.icon}
              action={<ApplyBadge mode={group.title === 'Nodes' ? 'node' : 'install'} />}
              dense
            >
              {group.fields.map(id => (
                <LockedRow key={id} id={id} spec={props.spec} caps={props.caps} />
              ))}
            </Panel>
          </Grid>
        ))}
      </Grid>
    </Stack>
  );
}
