/*
 * The releases the cluster can move to (status.availableReleases), newest
 * first, each with its kind, Kubernetes, Fedora, notes and the hops it takes.
 */

import { Icon } from '@iconify/react';
import {
  Box,
  Button,
  Chip,
  Collapse,
  Link as MuiLink,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import React from 'react';
import { ClusterUpgradeObject, NodeLike, ReleaseInfo } from '../../model/types';
import { clusterFacts, planPath, sortedReleases, UpgradeView } from '../../model/upgrades';
import { Panel } from '../common/ui';
import { HopChanges, KindChip } from './parts';

function Notes(props: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const long = props.text.length > 160 || props.text.includes('\n');
  if (!long) {
    return (
      <Typography variant="body2" color="text.secondary">
        {props.text}
      </Typography>
    );
  }
  return (
    <Box>
      <Collapse in={open} collapsedSize={40}>
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-line' }}>
          {props.text}
        </Typography>
      </Collapse>
      <MuiLink component="button" variant="body2" onClick={() => setOpen(!open)}>
        {open ? 'Less' : 'Release notes'}
      </MuiLink>
    </Box>
  );
}

function ReleaseRow(props: {
  rel: ReleaseInfo;
  latest: boolean;
  target: boolean;
  via: string[];
  error?: string;
  actionLabel: string;
  canPatch: boolean;
  onChoose: () => void;
  facts: ReturnType<typeof clusterFacts>;
}) {
  const theme = useTheme();
  const { rel } = props;
  const changes = [
    rel.kubernetes ? { what: 'Kubernetes' as const, to: rel.kubernetes } : null,
    rel.fedora ? { what: 'Fedora' as const, to: String(rel.fedora) } : null,
  ].filter(Boolean) as { what: 'Kubernetes' | 'Fedora'; to: string }[];
  return (
    <Box
      sx={{
        py: 2,
        px: 1.5,
        borderBottom: `1px solid ${theme.palette.divider}`,
        borderLeft: `3px solid ${props.target ? theme.palette.primary.main : 'transparent'}`,
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ md: 'center' }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Icon icon="mdi:tag-outline" width={18} height={18} />
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1.05rem' }}>
              {rel.version}
            </Typography>
            <KindChip kind={rel.kind} />
            {props.latest && (
              <Chip size="small" color="success" label="latest" sx={{ height: 20 }} />
            )}
            {props.target && (
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                label="current target"
                sx={{ height: 20 }}
              />
            )}
          </Stack>
          <Box sx={{ mt: 0.75 }}>
            <HopChanges
              changes={changes.map(c => ({
                ...c,
                from:
                  c.what === 'Kubernetes'
                    ? props.facts.kubernetes !== c.to
                      ? props.facts.kubernetes
                      : undefined
                    : props.facts.fedora && String(props.facts.fedora) !== c.to
                    ? String(props.facts.fedora)
                    : undefined,
              }))}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
            {props.error
              ? props.error
              : props.via.length <= 1
              ? 'One hop: every node reboots once.'
              : `${props.via.length} hops: ${props.via.join(
                  ' → '
                )}. Every node reboots once per hop.`}
          </Typography>
          {rel.notes && (
            <Box sx={{ mt: 0.75 }}>
              <Notes text={rel.notes} />
            </Box>
          )}
        </Box>
        {!props.target && (
          <Tooltip
            title={props.canPatch ? '' : 'Your user lacks patch permission on clusterupgrades.'}
          >
            <span>
              <Button
                variant={props.latest ? 'contained' : 'outlined'}
                startIcon={<Icon icon="mdi:arrow-up-bold-circle-outline" />}
                disabled={!props.canPatch}
                onClick={props.onChoose}
              >
                {props.actionLabel} {rel.version}
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>
    </Box>
  );
}

export function ReleaseList(props: {
  cu: ClusterUpgradeObject;
  view: UpgradeView;
  nodes: NodeLike[];
  canPatch: boolean;
  onChoose: (version: string) => void;
}) {
  const { cu, view } = props;
  const releases = sortedReleases(cu.status?.availableReleases).reverse();
  const facts = clusterFacts(props.nodes);
  const current = cu.status?.currentRelease ?? '';
  return (
    <Panel
      title="Available releases"
      icon="mdi:cloud-download-outline"
      action={
        releases.length > 0 ? (
          <Typography variant="caption" color="text.secondary">
            {releases.length} newer than {current || 'the cluster'}
          </Typography>
        ) : undefined
      }
    >
      {releases.length === 0 ? (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 2 }}>
          <Icon icon="mdi:check-circle-outline" width={28} height={28} />
          <Box>
            <Typography sx={{ fontWeight: 600 }}>
              {current ? `Nothing newer than ${current}` : 'No newer release'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              New releases of the upgrade graph show up here. If you expected one, check that
              k4all-operator can read the graph (How upgrades run).
            </Typography>
          </Box>
        </Stack>
      ) : (
        <Box>
          {releases.map(rel => {
            const plan = planPath(current, rel.version, cu.status?.availableReleases ?? [], facts);
            return (
              <ReleaseRow
                key={rel.version}
                rel={rel}
                latest={rel.version === view.latest?.version}
                target={view.active && rel.version === view.target}
                via={plan.hops.map(h => h.release.version)}
                error={plan.error}
                actionLabel={view.active ? 'Change target to' : 'Upgrade to'}
                canPatch={props.canPatch}
                onChoose={() => props.onChoose(rel.version)}
                facts={facts}
              />
            );
          })}
        </Box>
      )}
    </Panel>
  );
}
