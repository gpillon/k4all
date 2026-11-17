/*
 * The upgrade at a glance, for the Overview: the cluster's release, what it
 * can move to, or how far the upgrade in progress is.
 */

import { Icon } from '@iconify/react';
import { Router } from '@kinvolk/headlamp-plugin/lib';
import {
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { useClusterUpgrade, useClusterUpgradeServed } from '../../api/hooks';
import { CAPABILITY_RELEASE, CAPABILITY_SINCE } from '../../model/capabilities';
import { ClusterUpgradeObject } from '../../model/types';
import { upgradeView } from '../../model/upgrades';
import { TonePill } from '../common/ui';

function Frame(props: {
  children: React.ReactNode;
  action?: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <Card
      variant="outlined"
      sx={theme => ({
        borderRadius: 2,
        borderColor: props.highlight ? theme.palette.primary.main : undefined,
        background: props.highlight
          ? `linear-gradient(90deg, ${alpha(theme.palette.primary.main, 0.08)}, transparent 60%)`
          : undefined,
      })}
    >
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ md: 'center' }}
          justifyContent="space-between"
        >
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            <Box
              sx={theme => ({
                width: 40,
                height: 40,
                flexShrink: 0,
                borderRadius: 1.5,
                display: 'grid',
                placeItems: 'center',
                color: 'primary.main',
                backgroundColor: alpha(theme.palette.primary.main, 0.12),
              })}
            >
              <Icon icon="mdi:update" width={24} height={24} />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>{props.children}</Box>
          </Stack>
          {props.action}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function UpgradeSummary({ cu }: { cu: ClusterUpgradeObject }) {
  const history = useHistory();
  const view = upgradeView(cu);
  const open = () => history.push(Router.createRouteURL('k4all-upgrades'));
  const latest = view.latest;
  return (
    <Frame
      highlight={view.active || view.stage === 'available'}
      action={
        <Button
          variant={view.stage === 'available' || view.active ? 'contained' : 'outlined'}
          size="small"
          onClick={open}
          endIcon={<Icon icon="mdi:arrow-right" />}
          sx={{ flexShrink: 0 }}
        >
          {view.active
            ? 'Follow the upgrade'
            : view.stage === 'available'
            ? 'Plan upgrade'
            : 'Upgrades'}
        </Button>
      }
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography sx={{ fontWeight: 600 }}>Upgrades</Typography>
        <TonePill tone={view.tone} busy={view.busy} label={view.label} />
      </Stack>
      {view.active ? (
        <Box sx={{ mt: 0.75 }}>
          <Typography variant="body2" color="text.secondary">
            {view.current} → {view.target}
            {view.hopIndex > 0 &&
              ` · hop ${view.hopIndex} of ${view.path.length} · ${view.nodesDone} of ${view.nodesTotal} nodes done`}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={view.progress * 100}
            color={view.stage === 'failed' ? 'error' : 'primary'}
            aria-label="Upgrade progress"
            sx={{ mt: 0.75, height: 6, borderRadius: 3, maxWidth: 480 }}
          />
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {view.current ? `The cluster runs k4all ${view.current}. ` : ''}
          {latest
            ? `${view.available.length} newer release${
                view.available.length === 1 ? '' : 's'
              }, latest ${latest.version}${
                latest.kubernetes ? ` (Kubernetes ${latest.kubernetes}` : ''
              }${
                latest.kubernetes && latest.fedora
                  ? `, Fedora ${latest.fedora})`
                  : latest.kubernetes
                  ? ')'
                  : ''
              }.`
            : view.stage === 'waiting'
            ? 'Waiting for k4all-operator to report the release.'
            : 'No newer release.'}
        </Typography>
      )}
    </Frame>
  );
}

function LiveSummary() {
  const { cu, loading, error } = useClusterUpgrade();
  if (loading || error || !cu) {
    return null; // the Upgrades page explains these states
  }
  return <UpgradeSummary cu={cu} />;
}

/** On the Overview; with an operator before v0.4.0 it says which release brings upgrades. */
export function UpgradesCard() {
  const served = useClusterUpgradeServed();
  if (served === null) {
    return null;
  }
  if (!served) {
    return (
      <Frame>
        <Typography sx={{ fontWeight: 600 }}>Upgrades</Typography>
        <Typography variant="body2" color="text.secondary">
          Upgrading the cluster from here comes with k4all {CAPABILITY_RELEASE.clusterUpgrade}{' '}
          (k4all-operator {CAPABILITY_SINCE.clusterUpgrade}). Until then, run{' '}
          <code>sudo k4all-upgrade</code> on each node.
        </Typography>
      </Frame>
    );
  }
  return <LiveSummary />;
}
