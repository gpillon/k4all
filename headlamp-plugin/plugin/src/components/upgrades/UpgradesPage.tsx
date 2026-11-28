/*
 * Upgrades: move every node of the cluster to a newer k4all release through
 * the ClusterUpgrade "k4all" (k4all-operator v0.4.0+). The operator plans the
 * hops on the upgrade graph, cordons and drains one node at a time and asks
 * k4all-upgrade on it for the hop; this page chooses the target, follows the
 * progress and helps when a node gets stuck. With k4all-operator v0.7.0
 * (capability upgradeReadiness): "Before you upgrade" (the readiness
 * report, Check again, the fixes), the live blockers with Apply fix and
 * Accept, and "What k4all changed" with Put back now.
 */

import { Icon } from '@iconify/react';
import { Utils } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Grid,
  Stack,
  Typography,
} from '@mui/material';
import React from 'react';
import { useHeadlampNode } from '../../api/clusterObjects';
import {
  K4allData,
  useCanPatchClusterUpgrade,
  useClusterUpgrade,
  useClusterUpgradeServed,
  useK4allData,
  useNow,
} from '../../api/hooks';
import { capabilities, CAPABILITY_RELEASE, CAPABILITY_SINCE } from '../../model/capabilities';
import { kubeletVersions } from '../../model/health';
import { readinessView } from '../../model/readiness';
import {
  ClusterUpgradeObject,
  CONDITION_BLOCKED,
  CONDITION_RULES_INVALID,
  DEFAULT_UPGRADE_GRAPH_URL,
  NodeLike,
} from '../../model/types';
import {
  canRetry,
  DEFAULT_DRAIN_TIMEOUT_MINUTES,
  drainBehaviour,
  estimate,
  findUpgradeCondition,
  PLAN_FAILURE,
  upgradeOrder,
  UpgradeView,
  upgradeView,
} from '../../model/upgrades';
import { LiveStatusBar } from '../common/live';
import { Centered, K4allGate } from '../common/states';
import { Mono, PageHeader, Panel, TonePill } from '../common/ui';
import { CommandLine, NodeOrder } from './parts';
import { ReadinessPanel, RemediationsPanel } from './readiness';
import { ReleaseList } from './ReleaseList';
import { UpgradeNodesTable, UpgradeProgressPanel } from './UpgradeProgress';
import { UpgradeReviewDialog } from './UpgradeReviewDialog';
import { UpgradeSettingsDialog } from './UpgradeSettingsDialog';
import { UpgradeFlow, useUpgradeFlow } from './useUpgradeFlow';

export function UpgradesPage() {
  const data = useK4allData();
  return (
    <Box sx={{ p: { xs: 1, md: 3 } }}>
      <K4allGate data={data}>
        <UpgradesGate data={data} />
      </K4allGate>
    </Box>
  );
}

function Spinner() {
  return (
    <Stack alignItems="center" sx={{ py: 10 }}>
      <CircularProgress />
    </Stack>
  );
}

function UpgradesGate({ data }: { data: K4allData }) {
  const served = useClusterUpgradeServed();
  if (served === null) {
    return <Spinner />;
  }
  if (!served) {
    return <ClusterUpgradeUnavailable data={data} />;
  }
  return <UpgradesLive data={data} />;
}

/** The operator does not serve ClusterUpgrade: say which release brings it. */
export function ClusterUpgradeUnavailable({ data }: { data: K4allData }) {
  const caps = capabilities(data.rm);
  const since = CAPABILITY_SINCE.clusterUpgrade;
  return (
    <Centered icon="mdi:update" title={`Upgrades from Headlamp need k4all-operator ${since}`}>
      <Stack spacing={1.5} alignItems="center">
        <Typography variant="body2">
          {caps.clusterUpgrade
            ? `This cluster runs k4all-operator ${caps.operatorVersion}, which should serve the ClusterUpgrade API, but the API server does not: check the k4all-operator installation (its CRDs) in k4all-operator-system.`
            : `This cluster runs k4all-operator ${
                caps.operatorVersion ?? '(unknown version)'
              }. k4all ${
                CAPABILITY_RELEASE.clusterUpgrade
              } brings the ClusterUpgrade API (k4all-operator ${since} or later); from then on every upgrade can be run from here.`}
        </Typography>
        {!caps.clusterUpgrade && (
          <>
            <Typography variant="body2">
              Until then, upgrade on the nodes, one at a time: the bootstrap node, then the other
              control planes, then the workers.
            </Typography>
            <Box sx={{ width: '100%', maxWidth: 520, textAlign: 'left' }}>
              <CommandLine
                command={`sudo k4all-upgrade run --to ${CAPABILITY_RELEASE.clusterUpgrade}`}
                where="on each node"
              />
            </Box>
            <Typography variant="caption">
              Nodes on v2.0 – v2.2.3 move to the v2.2.4 bridge first (docs/upgrades.md).
            </Typography>
          </>
        )}
      </Stack>
    </Centered>
  );
}

function UpgradesLive({ data }: { data: K4allData }) {
  const { cu, loading, error } = useClusterUpgrade();
  const canPatch = useCanPatchClusterUpgrade();
  const flow = useUpgradeFlow(cu);
  const now = useNow(5000);
  if (loading) {
    return <Spinner />;
  }
  if (error?.status === 403) {
    return (
      <Centered icon="mdi:shield-lock-outline" title="No access to the cluster upgrade">
        Your user cannot read <Mono>clusterupgrades</Mono> in <Mono>k4all.magesgate.com</Mono>. Ask
        an administrator for the <Mono>k4all-viewer</Mono> role.
      </Centered>
    );
  }
  if (error) {
    return (
      <Alert severity="error">
        <AlertTitle>Could not load the cluster upgrade</AlertTitle>
        {error.message}
      </Alert>
    );
  }
  if (!cu) {
    return (
      <Centered icon="mdi:file-question-outline" title="No ClusterUpgrade yet">
        <Stack spacing={1.5} alignItems="center">
          <Typography variant="body2">
            k4all-operator creates the ClusterUpgrade <Mono>k4all</Mono> when it starts, so it
            always shows the cluster's release. It is not there: check that k4all-operator is
            running.
          </Typography>
          <Box sx={{ width: '100%', maxWidth: 520, textAlign: 'left' }}>
            <CommandLine command="kubectl -n k4all-operator-system get pods" where="with kubectl" />
          </Box>
        </Stack>
      </Centered>
    );
  }
  return (
    <UpgradesContent
      cu={cu}
      data={data}
      flow={flow}
      canPatch={canPatch === true}
      checking={canPatch === null}
      now={now}
    />
  );
}

/** The Blocked condition's reasons (operator v0.7.0), as a title. */
export const BLOCKED_TITLE: Record<string, string> = {
  DrainBlocked: 'Something stops the next drain',
  WaitingForApproval: 'The next node waits for your answer',
  Remediating: 'Applying fixes before the next drain',
  Restoring: 'Putting back what k4all changed',
  RestoreFailed: 'Putting back a fix failed',
  CephNotHealthy: 'Ceph is not healthy: no node is drained',
};

function StageBanner(props: {
  cu: ClusterUpgradeObject;
  view: UpgradeView;
  flow: UpgradeFlow;
  canPatch: boolean;
}) {
  const { cu, view, flow, canPatch } = props;
  const blocked = findUpgradeCondition(cu, CONDITION_BLOCKED);
  const rules = findUpgradeCondition(cu, CONDITION_RULES_INVALID);
  return (
    <Stack spacing={1.5} sx={{ mb: 2 }}>
      {blocked?.status === 'True' && (
        <Alert
          severity={blocked.reason === 'RestoreFailed' ? 'error' : 'warning'}
          icon={<Icon icon="mdi:hand-back-left-outline" />}
        >
          <AlertTitle>
            {BLOCKED_TITLE[blocked.reason ?? ''] ?? `Blocked: ${blocked.reason ?? 'waiting'}`}
          </AlertTitle>
          {blocked.message}
        </Alert>
      )}
      {rules?.status === 'True' && (
        <Alert severity="warning">
          <AlertTitle>A readiness rule of k4all-operator does not work</AlertTitle>
          {rules.message || rules.reason} The report may miss what that rule finds.
        </Alert>
      )}
      {view.stage === 'waiting' && (
        <Alert severity="info" icon={<CircularProgress size={18} />}>
          <AlertTitle>Waiting for k4all-operator</AlertTitle>
          It has not reported the cluster's release yet. This takes a few seconds after the operator
          starts.
        </Alert>
      )}
      {view.stage === 'failed' && (
        <Alert
          severity="error"
          action={
            canRetry(cu) && canPatch ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => flow.retry()}
                disabled={flow.busy !== null}
              >
                Retry
              </Button>
            ) : undefined
          }
        >
          <AlertTitle>The upgrade stopped</AlertTitle>
          {cu.status?.message || 'A node needs attention: see below.'}
          {view.failedReason && PLAN_FAILURE[view.failedReason] && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {PLAN_FAILURE[view.failedReason]}
            </Typography>
          )}
        </Alert>
      )}
      {view.stage === 'paused' && (
        <Alert
          severity="warning"
          action={
            canPatch ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => flow.act({ kind: 'resume' })}
                disabled={flow.busy !== null}
              >
                Resume
              </Button>
            ) : undefined
          }
        >
          <AlertTitle>Paused</AlertTitle>
          No node starts its hop until you resume.
        </Alert>
      )}
      {view.stage === 'succeeded' && (
        <Alert severity="success">
          <AlertTitle>Upgrade complete</AlertTitle>
          Every node runs {view.current ?? view.target}
          {view.succeededAt ? ` (since ${Utils.timeAgo(view.succeededAt)} ago).` : '.'}
          {view.available.length > 0 && ' A newer release is already available below.'}
        </Alert>
      )}
      {view.stale && (
        <Alert severity="info">
          k4all-operator has not processed the latest change yet (generation{' '}
          {cu.metadata.generation}, processed {cu.status?.observedGeneration}).
        </Alert>
      )}
      {view.graph.available === false && (
        <Alert severity="warning" icon={<Icon icon="mdi:cloud-alert-outline" />}>
          <AlertTitle>k4all-operator cannot read the upgrade graph</AlertTitle>
          {view.graph.error}
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            Until it can, the releases to move to are unknown and an upgrade does not start its next
            hop. It tries again by itself; check the graph URL
            {view.graph.url ? (
              <>
                {' '}
                (<Mono>{view.graph.url}</Mono>)
              </>
            ) : (
              ''
            )}{' '}
            and that the cluster can reach it.
          </Typography>
        </Alert>
      )}
    </Stack>
  );
}

function HowPanel(props: {
  cu: ClusterUpgradeObject;
  nodes: NodeLike[];
  data: K4allData;
  canPatch: boolean;
  readiness: boolean;
  onEdit: () => void;
}) {
  const { cu } = props;
  const spec = cu.spec ?? {};
  const order = upgradeOrder(cu.status?.nodes, props.nodes, props.data.nodeConfigs);
  const est = estimate(1, order, spec.drain);
  const graph = spec.graphUrl || cu.status?.graphUrl || '';
  return (
    <Panel
      title="How upgrades run"
      icon="mdi:cog-outline"
      action={
        <Button size="small" onClick={props.onEdit} disabled={!props.canPatch}>
          Change
        </Button>
      }
    >
      <Stack spacing={2}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Node order ({order.length} node{order.length === 1 ? '' : 's'}, one at a time)
          </Typography>
          <Box sx={{ mt: 0.5 }}>
            <NodeOrder order={order} />
          </Box>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Drain
          </Typography>
          <Typography variant="body2">{drainBehaviour(est)}</Typography>
          {!est.singleNode && (
            <Stack direction="row" spacing={1} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                variant="outlined"
                icon={<Icon icon="mdi:timer-outline" width={14} height={14} />}
                label={`timeout ${spec.drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES} min`}
              />
              <Chip
                size="small"
                variant="outlined"
                label={spec.drain?.continueOnTimeout ? 'then continue' : 'then fail and wait'}
              />
              {props.readiness && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={
                    spec.drain?.confirmDisruptions
                      ? 'asks also for disruptions'
                      : 'asks only for what blocks'
                  }
                />
              )}
            </Stack>
          )}
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Upgrade graph
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {!graph || graph === DEFAULT_UPGRADE_GRAPH_URL ? 'k4all releases (default)' : graph}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          k4all-operator plans the hops on the graph: every minor release is a stop, and a stream's
          latest patch comes before the next minor. Each node reboots once per hop; the operator
          pauses component changes while a node is mid-hop.
        </Typography>
      </Stack>
    </Panel>
  );
}

function UpgradesContent(props: {
  cu: ClusterUpgradeObject;
  data: K4allData;
  flow: UpgradeFlow;
  canPatch: boolean;
  checking: boolean;
  now: number;
}) {
  const { cu, data, flow, canPatch } = props;
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const view = upgradeView(cu);
  const kubelets = kubeletVersions(data.nodes);
  const order = upgradeOrder(cu.status?.nodes, data.nodes, data.nodeConfigs);
  const singleNode = order.length <= 1;
  // Operator v0.7.0: the readiness report, blockers, records and their writes.
  const readiness = capabilities(data.rm).upgradeReadiness;
  const headlamp = useHeadlampNode(readiness);
  const report = readiness ? cu.status?.readiness : undefined;
  const target = cu.spec?.targetRelease || undefined;
  const rView = report
    ? readinessView(report, { release: target, headlampNode: headlamp.node })
    : null;
  const records = readiness ? cu.status?.remediations ?? [] : [];
  // Answers are written at once while an upgrade runs; before, in the start review.
  const answerNow = canPatch && view.active && !!target;

  return (
    <>
      <PageHeader
        icon="mdi:update"
        title="Upgrades"
        subtitle="Move every node to a newer k4all release, one hop and one node at a time"
        actions={
          <>
            {view.current && (
              <Chip icon={<Icon icon="mdi:tag" />} label={`k4all ${view.current}`} />
            )}
            {kubelets.length > 0 && (
              <Chip
                icon={<Icon icon="mdi:kubernetes" />}
                label={`Kubernetes ${kubelets.join(', ')}`}
              />
            )}
            <TonePill tone={view.tone} busy={view.busy} label={view.label} />
          </>
        }
      />
      <LiveStatusBar />
      {!props.checking && !canPatch && (
        <Alert severity="info" icon={<Icon icon="mdi:eye-outline" />} sx={{ mb: 2 }}>
          You can follow upgrades but not start or change them: your user lacks <Mono>patch</Mono>{' '}
          permission on <Mono>clusterupgrades</Mono>.
        </Alert>
      )}
      <StageBanner cu={cu} view={view} flow={flow} canPatch={canPatch} />

      <Grid container spacing={2}>
        {view.active && (
          <Grid item xs={12}>
            <UpgradeProgressPanel
              cu={cu}
              view={view}
              nodes={data.nodes}
              flow={flow}
              canPatch={canPatch}
              now={props.now}
              readiness={readiness}
            />
          </Grid>
        )}
        {readiness && records.length > 0 && (
          <Grid item xs={12}>
            <RemediationsPanel
              records={records}
              now={props.now}
              what="this upgrade"
              onRestore={canPatch ? r => flow.restore(r.id) : undefined}
              busy={flow.busy !== null}
            />
          </Grid>
        )}
        {readiness && (
          <Grid item xs={12}>
            <ReadinessPanel
              view={rView}
              now={props.now}
              onCheck={canPatch ? () => flow.checkReadiness() : undefined}
              checking={flow.checking}
              busy={flow.busy !== null}
              approvals={cu.spec?.approvals}
              binding={target ? { release: target } : undefined}
              headlampUnknown={headlamp.denied}
              controls={
                answerNow
                  ? () => () => ({
                      kind: 'act',
                      onAnswer: answer => flow.approve(answer),
                      busy: flow.busy !== null,
                    })
                  : undefined
              }
              hint={
                !view.active && rView && canPatch
                  ? 'You choose the fixes in the first step of the review, when you start the upgrade.'
                  : undefined
              }
            />
          </Grid>
        )}
        <Grid item xs={12} lg={8}>
          <ReleaseList
            cu={cu}
            view={view}
            canPatch={canPatch && view.stage !== 'waiting'}
            onChoose={version => flow.review({ kind: 'start', target: version })}
          />
        </Grid>
        <Grid item xs={12} lg={4}>
          <HowPanel
            cu={cu}
            nodes={data.nodes}
            data={data}
            canPatch={canPatch}
            readiness={readiness}
            onEdit={() => setSettingsOpen(true)}
          />
        </Grid>
        {!view.active && (
          <Grid item xs={12}>
            <Panel title="Nodes" icon="mdi:server-outline" dense>
              <UpgradeNodesTable cu={cu} nodes={data.nodes} now={props.now} />
            </Panel>
          </Grid>
        )}
      </Grid>

      <UpgradeSettingsDialog
        open={settingsOpen}
        spec={cu.spec ?? {}}
        singleNode={singleNode}
        readiness={readiness}
        onClose={() => setSettingsOpen(false)}
        onReview={intent => {
          setSettingsOpen(false);
          flow.review(intent);
        }}
      />
      <UpgradeReviewDialog
        flow={flow}
        nodes={data.nodes}
        nodeConfigs={data.nodeConfigs}
        readiness={readiness}
        report={report ?? null}
        headlampNode={headlamp.node}
        headlampUnknown={headlamp.denied}
        now={props.now}
      />
    </>
  );
}
