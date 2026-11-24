/*
 * Pieces /k4all/settings and the v2.7.0 settings pages share: the links to
 * the three pages, the PodNetworkOverlap banner, the capability notice.
 */

import { Icon } from '@iconify/react';
import { Router } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  AlertTitle,
  Box,
  Card,
  CardActionArea,
  Grid,
  Stack,
  Typography,
} from '@mui/material';
import React from 'react';
import { useHistory } from 'react-router-dom';
import {
  Capabilities,
  CAPABILITY_RELEASE,
  CAPABILITY_SINCE,
  CapabilityId,
} from '../../model/capabilities';
import { findCondition } from '../../model/health';
import { ClusterConfigStatus, CONDITION_POD_NETWORK_OVERLAP } from '../../model/types';
import { CapabilityChip, Mono } from '../common/ui';

/** The v2.7.0 settings pages: route name, path, what they hold, and the capability they need. */
export const SETTINGS_PAGES: {
  route: string;
  path: string;
  label: string;
  icon: string;
  help: string;
  capability: CapabilityId;
}[] = [
  {
    route: 'k4all-settings-virtualization',
    path: '/k4all/settings/virtualization',
    label: 'Virtualization',
    icon: 'mdi:monitor-multiple',
    help: 'KubeVirt feature gates, VM state storage, Hangar node agent, metadata service.',
    capability: 'virtSettings',
  },
  {
    route: 'k4all-settings-nodes',
    path: '/k4all/settings/nodes',
    label: 'Nodes',
    icon: 'mdi:server-outline',
    help: 'Max pods, CPU manager, reserved CPUs, topology manager, hugepages, IOMMU.',
    capability: 'nodeSettings',
  },
  {
    route: 'k4all-settings-storage',
    path: '/k4all/settings/storage',
    label: 'Storage',
    icon: 'mdi:database-outline',
    help: 'Rook/Ceph with the Cairn console: disks, small clusters.',
    capability: 'rookStorage',
  },
];

export function SettingsPagesLinks(props: { caps: Capabilities }) {
  const history = useHistory();
  return (
    <Grid container spacing={1.5} sx={{ mb: 2.5 }}>
      {SETTINGS_PAGES.map(p => (
        <Grid item xs={12} md={4} key={p.route}>
          <Card variant="outlined" sx={{ height: '100%', borderRadius: 2 }}>
            <CardActionArea
              onClick={() => history.push(Router.createRouteURL(p.route))}
              sx={{ height: '100%', p: 1.75 }}
              aria-label={`${p.label} settings`}
            >
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Box sx={{ color: 'primary.main', pt: 0.25 }}>
                  <Icon icon={p.icon} width={24} height={24} />
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography sx={{ fontWeight: 600 }}>{p.label}</Typography>
                    {!props.caps[p.capability] && <CapabilityChip id={p.capability} />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {p.help}
                  </Typography>
                </Box>
              </Stack>
            </CardActionArea>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}

/**
 * PodNetworkOverlap (operator v0.6.0, Cilium only, report-only): True with
 * what overlaps and what to do, Unknown when the check failed; False only
 * shows the informational "Note: …" of its message, when there is one.
 */
export function PodNetworkOverlapBanner(props: { status?: ClusterConfigStatus }) {
  const c = findCondition(props.status?.conditions, CONDITION_POD_NETWORK_OVERLAP);
  if (c?.status === 'False') {
    // No overlap, maybe with a note (the 10.0.0.0/8 pool holding the service network).
    const at = c.message?.indexOf('Note:') ?? -1;
    return at < 0 ? null : (
      <Alert severity="info" sx={{ mb: 2 }}>
        {c.message!.slice(at)}
      </Alert>
    );
  }
  if (!c || (c.status !== 'True' && c.status !== 'Unknown')) {
    return null;
  }
  const found = c.status === 'True';
  return (
    <Alert severity={found ? 'warning' : 'info'} sx={{ mb: 2 }}>
      <AlertTitle>
        {found
          ? 'Pod addresses overlap another network'
          : 'k4all-operator could not check the pod network for overlaps'}
      </AlertTitle>
      <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
        {c.message || c.reason}
      </Box>
      {found && (
        <Typography variant="body2" sx={{ mt: 1 }}>
          Cilium cannot change the pool of a running cluster, only add to it. Avoid the overlapping
          ranges for node, ingress and VIP addresses; ask before adding nodes in them. (
          <Mono>PodNetworkOverlap</Mono>, reported by k4all-operator)
        </Typography>
      )}
    </Alert>
  );
}

/**
 * The page's settings need a newer operator: say which, and that the page
 * is read-only until then.
 */
export function CapabilityNotice(props: { caps: Capabilities; id: CapabilityId; what: string }) {
  if (props.caps[props.id]) {
    return null;
  }
  const release = CAPABILITY_RELEASE[props.id];
  return (
    <Alert severity="info" icon={<Icon icon="mdi:timer-sand" />} sx={{ mb: 2 }}>
      <AlertTitle>
        {props.what} need k4all-operator {CAPABILITY_SINCE[props.id]}
        {release ? ` (k4all ${release})` : ''}
      </AlertTitle>
      This cluster runs k4all-operator {props.caps.operatorVersion ?? 'of an unknown version'}: its
      ClusterConfig does not have these fields yet, so they are shown read-only. Upgrade the cluster
      from the Upgrades page{release ? ` to ${release} or later` : ''} to change them here.
    </Alert>
  );
}
