/*
 * Live progress of an upgrade: the hop trail, overall progress, the nodes
 * with their phase on the operator and on the node, the drain timer, and
 * what to do about a node that is stuck. Pause, resume, stop and retry.
 */

import { Icon } from '@iconify/react';
import { Link } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';
import { findCondition } from '../../model/health';
import { ClusterUpgradeObject, NodeLike, NodeUpgradeStatus } from '../../model/types';
import {
  canRetry,
  drainTimer,
  Guidance,
  HOST_PHASES,
  hostPhaseLabel,
  NODE_PHASE,
  nodeGuidance,
  upgradeOrder,
  UpgradeView,
} from '../../model/upgrades';
import { Mono, Panel, TonePill } from '../common/ui';
import { CommandLine, DrainTimerBar, HopTrail } from './parts';
import { UpgradeFlow } from './useUpgradeFlow';

function nodeHealth(node: NodeLike | undefined): {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
} {
  if (!node) {
    return { label: 'unknown', tone: 'neutral' };
  }
  const ready = findCondition(node.status?.conditions, 'Ready')?.status === 'True';
  if (!ready) {
    return { label: 'Not ready', tone: 'error' };
  }
  return node.spec?.unschedulable
    ? { label: 'Ready, cordoned', tone: 'warning' }
    : { label: 'Ready', tone: 'success' };
}

/** The nodes in upgrade order with their state in the current hop. */
export function UpgradeNodesTable(props: {
  cu: ClusterUpgradeObject;
  nodes: NodeLike[];
  now: number;
}) {
  const statusNodes = props.cu.status?.nodes ?? [];
  const byName = new Map(statusNodes.map(n => [n.name, n]));
  const k8s = new Map(props.nodes.map(n => [n.metadata.name, n]));
  const order = upgradeOrder(statusNodes, props.nodes);
  const drain = props.cu.spec?.drain;
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Upgrade nodes">
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell>
            <TableCell>Node</TableCell>
            <TableCell>Role</TableCell>
            <TableCell>Release</TableCell>
            <TableCell>Upgrade</TableCell>
            <TableCell>On the node</TableCell>
            <TableCell>Node status</TableCell>
            <TableCell sx={{ minWidth: 220 }}>Detail</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {order.map((o, i) => {
            const st: NodeUpgradeStatus | undefined = byName.get(o.name);
            const phase = st ? NODE_PHASE[st.phase] ?? { label: st.phase, tone: 'neutral' } : null;
            const timer = st?.phase === 'Draining' && st ? drainTimer(st, drain, props.now) : null;
            const health = nodeHealth(k8s.get(o.name));
            return (
              <TableRow key={o.name}>
                <TableCell>{i + 1}</TableCell>
                <TableCell>
                  <Link routeName="node" params={{ name: o.name }}>
                    {o.name}
                  </Link>
                </TableCell>
                <TableCell sx={{ textTransform: 'capitalize' }}>{o.role}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>
                  {st?.release ?? o.release ?? '—'}
                </TableCell>
                <TableCell>
                  {phase ? (
                    <TonePill tone={phase.tone} busy={phase.busy} label={phase.label} />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  {st?.hostPhase ? (
                    <Tooltip title={HOST_PHASES[st.hostPhase]?.detail ?? st.hostPhase}>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={
                          st.hostPhase === 'HOLD' || st.hostPhase === 'ROLLBACK_REBOOT'
                            ? 'warning'
                            : st.hostPhase === 'ABANDONED'
                            ? 'error'
                            : 'default'
                        }
                        label={hostPhaseLabel(st.hostPhase)}
                      />
                    </Tooltip>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <TonePill tone={health.tone} label={health.label} />
                </TableCell>
                <TableCell>
                  {timer ? (
                    <DrainTimerBar
                      timer={timer}
                      continueOnTimeout={drain?.continueOnTimeout === true}
                    />
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>
                      {st?.message ?? ''}
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}

export function GuidanceAlert(props: {
  guidance: Guidance;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const g = props.guidance;
  return (
    <Alert
      severity={g.severity}
      action={
        g.retry && props.onRetry ? (
          <Button
            color="inherit"
            size="small"
            onClick={props.onRetry}
            disabled={props.retryDisabled}
          >
            Retry
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>{g.title}</AlertTitle>
      <Typography variant="body2">{g.text}</Typography>
      {g.commands.length > 0 && (
        <Stack spacing={0.75} sx={{ mt: 1.25 }}>
          {g.commands.map(c => (
            <CommandLine key={c.command} {...c} />
          ))}
        </Stack>
      )}
    </Alert>
  );
}

function StopDialog(props: {
  open: boolean;
  view: UpgradeView;
  onClose: () => void;
  onStop: () => void;
}) {
  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Stop the upgrade?</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography>
            This clears the target release. A node in the middle of its hop finishes it; then no
            other node starts.
          </Typography>
          <Typography color="text.secondary">
            Nodes already upgraded stay on their release, so the cluster can run two releases side
            by side, one hop apart, until you start an upgrade again. Prefer Pause if you only need
            a break.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Cancel</Button>
        <Button color="error" variant="contained" onClick={props.onStop}>
          Stop upgrade
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** The upgrade under way: progress, nodes, guidance, actions. */
export function UpgradeProgressPanel(props: {
  cu: ClusterUpgradeObject;
  view: UpgradeView;
  nodes: NodeLike[];
  flow: UpgradeFlow;
  canPatch: boolean;
  now: number;
}) {
  const { cu, view, flow, canPatch } = props;
  const [stopOpen, setStopOpen] = React.useState(false);
  const spec = cu.spec ?? {};
  const statusNodes = cu.status?.nodes ?? [];
  const guidance = statusNodes
    .map(n => nodeGuidance(n, spec))
    .filter((g): g is Guidance => g !== null);
  const retryable = canRetry(cu);
  const paused = view.stage === 'paused' || view.stage === 'pausing';
  const anyDone = view.path.some(h => h.phase === 'Done');
  const inProgress = statusNodes.find(n => n.phase === 'Draining' || n.phase === 'Upgrading');
  const disabledTitle = canPatch ? '' : 'Your user lacks patch permission on clusterupgrades.';

  return (
    <Panel
      title={
        <>
          {view.current ?? '?'} → {view.target ?? '?'}
        </>
      }
      icon="mdi:progress-upload"
      action={
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap justifyContent="flex-end">
          {retryable && (
            <Tooltip title={disabledTitle}>
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="error"
                  startIcon={<Icon icon="mdi:replay" />}
                  disabled={!canPatch || flow.busy !== null}
                  onClick={() => flow.retry()}
                >
                  Retry
                </Button>
              </span>
            </Tooltip>
          )}
          <Tooltip title={disabledTitle}>
            <span>
              {paused ? (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<Icon icon="mdi:play" />}
                  disabled={!canPatch || flow.busy !== null}
                  onClick={() => flow.act({ kind: 'resume' })}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<Icon icon="mdi:pause" />}
                  disabled={!canPatch || flow.busy !== null}
                  onClick={() => flow.act({ kind: 'pause' })}
                >
                  Pause
                </Button>
              )}
            </span>
          </Tooltip>
          <Tooltip title={disabledTitle}>
            <span>
              <Button
                size="small"
                color="error"
                startIcon={<Icon icon="mdi:stop" />}
                disabled={!canPatch || flow.busy !== null}
                onClick={() => setStopOpen(true)}
              >
                Stop
              </Button>
            </span>
          </Tooltip>
        </Stack>
      }
    >
      <Stack spacing={2.5}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <TonePill tone={view.tone} busy={view.busy} label={view.label} />
          {view.hopIndex > 0 && (
            <Chip
              size="small"
              variant="outlined"
              label={`hop ${view.hopIndex} of ${view.path.length}: ${cu.status?.currentHop ?? ''}`}
            />
          )}
          {view.nodesTotal > 0 && view.hopIndex > 0 && (
            <Chip
              size="small"
              variant="outlined"
              label={`${view.nodesDone} of ${view.nodesTotal} node${
                view.nodesTotal === 1 ? '' : 's'
              } done in this hop`}
            />
          )}
        </Stack>

        {view.path.length > 0 && (
          <HopTrail from={anyDone ? undefined : view.current} path={view.path} />
        )}

        <Box>
          <LinearProgress
            variant="determinate"
            value={view.progress * 100}
            color={view.stage === 'failed' ? 'error' : paused ? 'warning' : 'primary'}
            aria-label="Upgrade progress"
            sx={{ height: 8, borderRadius: 4 }}
          />
          <Typography variant="caption" color="text.secondary">
            {Math.round(view.progress * 100)}% of the node hops
          </Typography>
        </Box>

        {cu.status?.message && (
          <Stack
            direction="row"
            spacing={1}
            alignItems="flex-start"
            sx={{ color: 'text.secondary' }}
          >
            <Icon icon="mdi:information-outline" width={18} height={18} />
            <Typography variant="body2">{cu.status.message}</Typography>
          </Stack>
        )}
        {view.stage === 'pausing' && (
          <Alert severity="info">
            Pausing: {inProgress ? <Mono>{inProgress.name}</Mono> : 'the node in progress'} finishes
            its hop, then no other node starts until you resume.
          </Alert>
        )}

        {guidance.map(g => (
          <GuidanceAlert
            key={g.node}
            guidance={g}
            onRetry={canPatch ? () => flow.retry() : undefined}
            retryDisabled={flow.busy !== null}
          />
        ))}

        <UpgradeNodesTable cu={cu} nodes={props.nodes} now={props.now} />
      </Stack>
      <StopDialog
        open={stopOpen}
        view={view}
        onClose={() => setStopOpen(false)}
        onStop={() => {
          setStopOpen(false);
          flow.act({ kind: 'stop' });
        }}
      />
    </Panel>
  );
}
