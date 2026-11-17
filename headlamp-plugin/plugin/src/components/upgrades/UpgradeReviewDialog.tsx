/*
 * Review of an upgrade before it starts: the planned path hop by hop, what
 * each hop changes, the node order, the drain behaviour (editable), the
 * reboots and downtime to expect, then the server dry run of the patch.
 * Also reviews a change of the upgrade settings.
 */

import { Icon } from '@iconify/react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import { NodeConfigObject, NodeLike } from '../../model/types';
import {
  changesKubernetesMinor,
  clusterFacts,
  DEFAULT_DRAIN_TIMEOUT_MINUTES,
  drainBehaviour,
  estimate,
  normalizeRelease,
  planPath,
  upgradeOrder,
} from '../../model/upgrades';
import { Mono } from '../common/ui';
import { ChangeList } from '../review/ReviewDialog';
import { YamlDiff } from '../review/YamlDiff';
import { NodeOrder, PlanTimeline } from './parts';
import { UpgradeFlow, UpgradeReviewData } from './useUpgradeFlow';

function Section(props: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Icon icon={props.icon} width={18} height={18} />
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.5 }}>
          {props.title}
        </Typography>
      </Stack>
      {props.children}
    </Box>
  );
}

function StartPlan(props: {
  data: UpgradeReviewData;
  nodes: NodeLike[];
  nodeConfigs: NodeConfigObject[];
  timeout: string;
  setTimeout: (v: string) => void;
  cont: boolean;
  setCont: (v: boolean) => void;
  timeoutError?: string;
}) {
  const { data } = props;
  const status = data.base.status ?? {};
  const current = status.currentRelease ?? '';
  const target = data.desired.targetRelease ?? '';
  const facts = clusterFacts(props.nodes);
  const plan = planPath(current, target, status.availableReleases ?? [], facts);
  const order = upgradeOrder(status.nodes, props.nodes, props.nodeConfigs);
  const est = estimate(plan.hops.length, order, data.desired.drain);
  const last = plan.hops[plan.hops.length - 1]?.release;
  const k8sMinor = plan.hops.some(h => h.changes.some(changesKubernetesMinor));

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h3" sx={{ fontSize: '1.15rem', fontWeight: 600 }}>
          {current} → {target}
          {plan.hops.length > 0 && (
            <Typography component="span" color="text.secondary" sx={{ ml: 1 }}>
              in {plan.hops.length} hop{plan.hops.length === 1 ? '' : 's'}
            </Typography>
          )}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          From Kubernetes {facts.kubernetes ?? '?'}
          {facts.fedora ? `, Fedora ${facts.fedora}` : ''} to Kubernetes{' '}
          {last?.kubernetes ?? facts.kubernetes ?? '?'}
          {last?.fedora
            ? `, Fedora ${last.fedora}`
            : facts.fedora
            ? `, Fedora ${facts.fedora}`
            : ''}
          . Every node finishes a hop before any node starts the next.
        </Typography>
      </Box>

      {plan.error && (
        <Alert severity="warning">
          <AlertTitle>The plugin could not plan this path</AlertTitle>
          {plan.error} k4all-operator plans the path itself and reports it once the upgrade starts.
        </Alert>
      )}

      {plan.hops.length > 0 && (
        <Section icon="mdi:map-marker-path" title="Path">
          <PlanTimeline hops={plan.hops} nodes={est.nodes} />
          {!plan.exact && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Planned by the plugin with the k4all versioning rules (every minor is a stop, a
              stream's latest patch comes first). k4all-operator plans the final path from the
              upgrade graph and shows it once the upgrade starts.
            </Typography>
          )}
        </Section>
      )}

      <Section icon="mdi:server-outline" title="Node order">
        <NodeOrder order={order} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          One node at a time: the bootstrap node, then the other control planes, then the workers.
        </Typography>
      </Section>

      <Section icon="mdi:tray-arrow-down" title="Drain">
        <Typography variant="body2">{drainBehaviour(est)}</Typography>
        {!est.singleNode && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ sm: 'center' }}
            sx={{ mt: 1.5 }}
          >
            <TextField
              size="small"
              type="number"
              label="Drain timeout (minutes)"
              value={props.timeout}
              onChange={e => props.setTimeout(e.target.value)}
              error={!!props.timeoutError}
              helperText={props.timeoutError}
              inputProps={{ min: 1, 'aria-label': 'Drain timeout in minutes' }}
              sx={{ width: 220 }}
            />
            <FormControlLabel
              control={
                <Switch checked={props.cont} onChange={(_, checked) => props.setCont(checked)} />
              }
              label="Continue when the drain times out"
            />
          </Stack>
        )}
      </Section>

      {plan.hops.length > 0 && (
        <Section icon="mdi:restart" title="Reboots and downtime">
          <Stack spacing={0.75}>
            <Typography variant="body2">
              <b>
                {est.reboots} reboot{est.reboots === 1 ? '' : 's'}
              </b>{' '}
              in total ({est.hops} hop{est.hops === 1 ? '' : 's'} × {est.nodes} node
              {est.nodes === 1 ? '' : 's'}). Expect roughly {est.minutes[0]}–{est.minutes[1]}{' '}
              minutes
              {est.singleNode ? '' : ', plus the drains'}; the image download speed decides most of
              it.
            </Typography>
            {est.notes.map(n => (
              <Typography key={n} variant="body2" color="text.secondary">
                {n}
              </Typography>
            ))}
            <Typography variant="body2" color="text.secondary">
              This page loses its connection while the node that runs Headlamp reboots; it comes
              back by itself, or reload it.
              {k8sMinor &&
                ' Hops that change the Kubernetes minor run kubeadm upgrade on each node before its reboot.'}
            </Typography>
          </Stack>
        </Section>
      )}
    </Stack>
  );
}

export interface UpgradeReviewDialogProps {
  flow: UpgradeFlow;
  nodes: NodeLike[];
  nodeConfigs: NodeConfigObject[];
}

export function UpgradeReviewDialog({ flow, nodes, nodeConfigs }: UpgradeReviewDialogProps) {
  const { phase } = flow;
  const open = phase.kind !== 'idle';
  const data = phase.kind === 'review' || phase.kind === 'applying' ? phase.data : null;
  const isStart =
    data?.intent.kind === 'start' || (phase.kind === 'dryRun' && phase.intent.kind === 'start');
  const [ack, setAck] = React.useState(false);
  const [timeout, setTimeoutText] = React.useState('');
  const [cont, setCont] = React.useState(false);

  React.useEffect(() => {
    if (data) {
      setTimeoutText(String(data.desired.drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES));
      setCont(data.desired.drain?.continueOnTimeout === true);
    }
    if (phase.kind === 'dryRun') {
      setAck(false);
    }
    // Reset the inputs when a new review arrives, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, data?.ops]);

  const timeoutNumber = Number(timeout);
  const timeoutError =
    timeout.trim() === '' || !Number.isInteger(timeoutNumber) || timeoutNumber < 1
      ? 'A whole number of minutes, 1 or more.'
      : undefined;
  const optionsChanged =
    !!data &&
    data.intent.kind === 'start' &&
    (timeoutNumber !== (data.desired.drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES) ||
      cont !== (data.desired.drain?.continueOnTimeout === true));

  const checkAgain = () => {
    if (data?.intent.kind === 'start') {
      flow.review({
        kind: 'start',
        target: data.intent.target,
        drain: { timeoutMinutes: timeoutNumber, continueOnTimeout: cont },
      });
    }
  };

  const intent =
    phase.kind === 'review' || phase.kind === 'applying'
      ? phase.data.intent
      : phase.kind === 'dryRun' || phase.kind === 'error'
      ? phase.intent
      : null;
  const title =
    intent?.kind === 'start' ? `Upgrade to ${normalizeRelease(intent.target)}` : 'Upgrade settings';

  return (
    <Dialog
      open={open}
      onClose={phase.kind === 'applying' ? undefined : flow.close}
      maxWidth="md"
      fullWidth
      aria-labelledby="k4all-upgrade-review-title"
    >
      <DialogTitle id="k4all-upgrade-review-title">{title}</DialogTitle>
      <DialogContent dividers>
        {phase.kind === 'dryRun' && (
          <Stack
            direction="row"
            spacing={2}
            alignItems="center"
            sx={{ py: 4, justifyContent: 'center' }}
          >
            <CircularProgress size={24} />
            <Typography>Checking the change with the API server (dry run)…</Typography>
          </Stack>
        )}

        {phase.kind === 'error' && (
          <Alert severity="error">
            <AlertTitle>{phase.error.hint}</AlertTitle>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
              {phase.error.message}
            </Typography>
          </Alert>
        )}

        {data && (
          <Stack spacing={3}>
            {data.changedMeanwhile && (
              <Alert severity="info">
                The upgrade changed while you were choosing (someone else, or k4all-operator). This
                review is built on the newest version: check it again.
              </Alert>
            )}
            {data.base.spec?.targetRelease &&
              data.intent.kind === 'start' &&
              ['Progressing', 'Paused', 'Failed'].includes(data.base.status?.phase ?? '') && (
                <Alert severity="warning">
                  An upgrade to <Mono>{data.base.spec.targetRelease}</Mono> is already set. This
                  replaces its target; a node in the middle of a hop finishes it first.
                </Alert>
              )}
            {data.intent.kind === 'start' && (
              <StartPlan
                data={data}
                nodes={nodes}
                nodeConfigs={nodeConfigs}
                timeout={timeout}
                setTimeout={setTimeoutText}
                cont={cont}
                setCont={setCont}
                timeoutError={timeoutError}
              />
            )}
            <Box>
              <Typography variant="overline" color="text.secondary">
                {data.items.length} change{data.items.length === 1 ? '' : 's'} to the ClusterUpgrade
              </Typography>
              <ChangeList items={data.items} />
            </Box>
            <Accordion disableGutters variant="outlined">
              <AccordionSummary expandIcon={<Icon icon="mdi:chevron-down" />}>
                <Typography sx={{ fontWeight: 600 }}>Resulting spec (server dry run)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <YamlDiff before={data.base.spec} after={data.result.spec} />
              </AccordionDetails>
            </Accordion>
            <Accordion disableGutters variant="outlined">
              <AccordionSummary expandIcon={<Icon icon="mdi:chevron-down" />}>
                <Typography sx={{ fontWeight: 600 }}>JSON Patch sent to the API server</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box
                  component="pre"
                  sx={{ m: 0, fontSize: '0.8rem', overflow: 'auto', maxHeight: 260 }}
                >
                  {JSON.stringify(data.ops, null, 2)}
                </Box>
              </AccordionDetails>
            </Accordion>
            {isStart && !optionsChanged && (
              <FormControlLabel
                control={<Checkbox checked={ack} onChange={e => setAck(e.target.checked)} />}
                label="I understand that every node reboots once per hop and that workloads are interrupted as described."
              />
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {phase.kind === 'error' ? (
          <>
            <Button onClick={flow.close}>Close</Button>
            <Button
              variant="contained"
              onClick={phase.error.kind === 'forbidden' ? flow.close : phase.retry}
            >
              {phase.error.kind === 'forbidden' ? 'OK' : 'Try again'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={flow.close} disabled={phase.kind === 'applying'}>
              Cancel
            </Button>
            {optionsChanged ? (
              <Button variant="contained" onClick={checkAgain} disabled={!!timeoutError}>
                Check again with these options
              </Button>
            ) : (
              <Button
                variant="contained"
                color={isStart ? 'warning' : 'primary'}
                onClick={flow.apply}
                disabled={!data || phase.kind === 'applying' || (isStart && !ack)}
                startIcon={
                  phase.kind === 'applying' ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : isStart ? (
                    <Icon icon="mdi:rocket-launch-outline" />
                  ) : undefined
                }
              >
                {isStart ? 'Start upgrade' : 'Save settings'}
              </Button>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
