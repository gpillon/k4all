import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Chip, Stack, Typography } from '@mui/material';
import React from 'react';
import { useK4allApiPresent } from '../../api/hooks';
import { NodeConfig } from '../../api/resources';
import { nodeUpgrades } from '../../model/health';
import {
  NODE_RELEASE_ANNOTATION,
  NODE_UPGRADE_MESSAGE_ANNOTATION,
  NODE_UPGRADE_PHASE_ANNOTATION,
  NodeLike,
} from '../../model/types';
import { HOST_PHASES, hostPhaseLabel } from '../../model/upgrades';
import { Mono, TonePill } from '../common/ui';

/** "k4all" section on Headlamp's Node details page; nothing on other clusters. */
export function NodeSection(props: { node: NodeLike }) {
  const present = useK4allApiPresent();
  return present ? <K4allNodeSection node={props.node} /> : null;
}

function K4allNodeSection(props: { node: NodeLike }) {
  const name = props.node.metadata.name;
  const [nodeConfig] = NodeConfig.useGet(name);
  const upgrade = nodeUpgrades([props.node])[0];
  if (!nodeConfig && !upgrade) {
    return null; // loading, not a k4all cluster, or no access: stay out of the way
  }
  const status = nodeConfig?.object.status;
  const annotations = props.node.metadata.annotations ?? {};
  const release = annotations[NODE_RELEASE_ANNOTATION];
  const hostPhase = annotations[NODE_UPGRADE_PHASE_ANNOTATION];
  const hostMessage = annotations[NODE_UPGRADE_MESSAGE_ANNOTATION];
  return (
    <SectionBox title="k4all">
      <Stack spacing={1.5} sx={{ py: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" color="text.secondary">
            Role
          </Typography>
          <Chip
            size="small"
            label={status?.nodeType ?? 'unknown'}
            sx={{ textTransform: 'capitalize' }}
          />
          {release && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                Release
              </Typography>
              <Chip
                size="small"
                variant="outlined"
                label={release}
                sx={{ fontFamily: 'monospace' }}
              />
            </>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
            Upgrade
          </Typography>
          {hostPhase ? (
            <TonePill
              tone={hostPhase === 'HOLD' || hostPhase === 'ABANDONED' ? 'warning' : 'info'}
              busy={hostPhase !== 'HOLD' && hostPhase !== 'ABANDONED'}
              label={hostPhaseLabel(hostPhase) ?? hostPhase}
              title={HOST_PHASES[hostPhase]?.detail}
            />
          ) : upgrade ? (
            <TonePill
              tone="info"
              busy
              label={upgrade.from && upgrade.to ? `${upgrade.from} → ${upgrade.to}` : upgrade.raw}
            />
          ) : (
            <TonePill tone="neutral" label="idle" />
          )}
        </Stack>
        {hostMessage && (
          <Typography variant="body2" color="text.secondary">
            k4all-upgrade: {hostMessage}
          </Typography>
        )}
        {upgrade && (
          <Typography variant="body2" color="text.secondary">
            k4all-upgrade is running a hop on this node; k4all-operator pauses component changes
            until it commits. Follow it on the node with <Mono>sudo k4all-upgrade status</Mono>.
          </Typography>
        )}
        {(status?.availableInterfaces?.length ?? 0) > 0 && (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" color="text.secondary">
              Interfaces
            </Typography>
            {status!.availableInterfaces!.map(i => (
              <Chip key={i.name} size="small" variant="outlined" label={`${i.name} · ${i.mac}`} />
            ))}
          </Stack>
        )}
      </Stack>
    </SectionBox>
  );
}
