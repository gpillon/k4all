import { Icon } from '@iconify/react';
import { Router, Utils } from '@kinvolk/headlamp-plugin/lib';
import { Link } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Grid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { useK4allData, useNow } from '../../api/hooks';
import { buildRows, ComponentRow, releaseVersion, summarize, Tone } from '../../model/components';
import {
  clusterHealth,
  findCondition,
  HealthLevel,
  kubeletVersions,
  nodeRows,
} from '../../model/health';
import { effectiveTraefik } from '../../model/settings';
import { ClusterConfigObject } from '../../model/types';
import { K4allGate } from '../common/states';
import { Metric, Mono, PageHeader, Panel, SegmentBar, TonePill } from '../common/ui';

const LEVEL_TONE: Record<HealthLevel, Tone> = {
  healthy: 'success',
  progressing: 'info',
  upgrading: 'info',
  degraded: 'error',
  unknown: 'neutral',
};

function settingsURL(tab: string): string {
  return `${Router.createRouteURL('k4all-settings')}?tab=${tab}`;
}

function FeatureLine(props: {
  icon: string;
  label: string;
  enabled: boolean;
  ready?: boolean;
  note?: string;
}) {
  const tone: Tone = !props.enabled ? 'neutral' : props.ready === false ? 'info' : 'success';
  const label = !props.enabled ? 'Off' : props.ready === false ? 'Installing' : 'On';
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ py: 0.75 }}>
      <Stack direction="row" spacing={1.25} alignItems="center">
        <Icon icon={props.icon} width={20} height={20} />
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {props.label}
          </Typography>
          {props.note && (
            <Typography variant="caption" color="text.secondary">
              {props.note}
            </Typography>
          )}
        </Box>
      </Stack>
      <TonePill tone={tone} label={label} busy={props.enabled && props.ready === false} />
    </Stack>
  );
}

function FeaturesPanel(props: { cc: ClusterConfigObject }) {
  const history = useHistory();
  const spec = props.cc.spec ?? {};
  const status = props.cc.status?.features ?? {};
  return (
    <Panel
      title="Features"
      icon="mdi:puzzle-outline"
      action={
        <Button size="small" onClick={() => history.push(settingsURL('features'))}>
          Change
        </Button>
      }
    >
      <FeatureLine
        icon="mdi:monitor-multiple"
        label="Virtualization"
        enabled={!!spec.features?.virt?.enabled}
        ready={status.virtReady}
        note={
          spec.features?.virt?.enabled
            ? `emulation: ${spec.features?.virt?.emulation || 'auto'}`
            : undefined
        }
      />
      <FeatureLine
        icon="mdi:source-branch-sync"
        label="Argo CD"
        enabled={!!spec.features?.argocd?.enabled}
        ready={status.argocdReady}
      />
      <FeatureLine
        icon="mdi:lan"
        label="OVS secondary networks"
        enabled={!!spec.features?.ovsCni?.enabled}
        ready={status.ovsCniReady}
      />
      <FeatureLine
        icon="mdi:bridge"
        label="OVS bridge"
        enabled={!!spec.features?.ovsBridge?.enabled}
        note="set at installation"
      />
    </Panel>
  );
}

function IngressPanel(props: { cc: ClusterConfigObject }) {
  const history = useHistory();
  const spec = props.cc.spec ?? {};
  const traefik = effectiveTraefik(spec);
  const ciliumIP = spec.ingress?.cilium?.dedicatedIP;
  return (
    <Panel
      title="Ingress"
      icon="mdi:routes"
      action={
        <Button size="small" onClick={() => history.push(settingsURL('ingress'))}>
          Change
        </Button>
      }
    >
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Traefik address
          </Typography>
          <Typography sx={{ fontFamily: 'monospace', fontSize: '1.05rem' }}>
            {traefik.dedicatedIP || 'node address'}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <TonePill
            tone={traefik.isDefault ? 'success' : 'neutral'}
            label={traefik.isDefault ? 'Default IngressClass' : 'Not the default class'}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`CNI: ${spec.networking?.cni?.type ?? 'unknown'}`}
          />
        </Stack>
        {traefik.source === 'nginx' && (
          <Typography variant="caption" color="text.secondary">
            Read from <Mono>spec.ingress.nginx</Mono> (cluster installed before v2.6.0).
          </Typography>
        )}
        {ciliumIP && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Cilium ingress address
            </Typography>
            <Typography sx={{ fontFamily: 'monospace' }}>{ciliumIP}</Typography>
          </Box>
        )}
      </Stack>
    </Panel>
  );
}

function ComponentsPanel(props: { rows: ComponentRow[] }) {
  const history = useHistory();
  const s = summarize(props.rows);
  const attention = props.rows.filter(
    r => r.state.tone === 'error' || r.upgrade || (r.state.busy && r.activation.active)
  );
  return (
    <Panel
      title="Components"
      icon="mdi:package-variant-closed"
      action={
        <Button
          size="small"
          onClick={() => history.push(Router.createRouteURL('k4all-components'))}
        >
          View all
        </Button>
      }
    >
      <Stack spacing={2}>
        <Metric
          value={`${s.installed}/${s.active}`}
          caption="active components installed"
          tone={s.failed ? 'error' : s.installed === s.active ? 'success' : 'info'}
        />
        <SegmentBar
          segments={[
            { label: 'installed', value: s.installed, tone: 'success' },
            { label: 'in progress', value: s.busy, tone: 'info' },
            { label: 'failed', value: s.failed, tone: 'error' },
            { label: 'unmanaged', value: s.unmanaged, tone: 'warning' },
            { label: 'off', value: s.off, tone: 'neutral' },
          ]}
        />
        {attention.length > 0 && (
          <Stack spacing={0.75}>
            {attention.slice(0, 5).map(r => (
              <Stack
                key={r.name}
                direction="row"
                spacing={1}
                alignItems="center"
                justifyContent="space-between"
              >
                <Link routeName="k4all-component" params={{ name: r.name }}>
                  {r.name}
                </Link>
                <TonePill
                  tone={r.state.tone}
                  busy={r.state.busy}
                  label={
                    r.upgrade
                      ? `→ ${r.upgrade.next}${
                          r.upgrade.remaining.length > 1
                            ? ` (+${r.upgrade.remaining.length - 1})`
                            : ''
                        }`
                      : r.state.label
                  }
                  title={r.status?.message}
                />
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Panel>
  );
}

function ReleasePanel(props: {
  rows: ComponentRow[];
  rmReady?: string;
  lastReconcile?: string;
  observed?: number;
  generation?: number;
}) {
  const operator = props.rows.find(r => r.name === 'k4all-operator');
  return (
    <Panel title="Release" icon="mdi:tag-outline">
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            k4all-operator
          </Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>
            {operator?.installedVersion ?? operator?.spec.version ?? 'unknown'}
          </Typography>
        </Box>
        {props.rmReady && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Operator status
            </Typography>
            <Typography variant="body2">{props.rmReady}</Typography>
          </Box>
        )}
        {props.lastReconcile && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Last reconcile
            </Typography>
            <Typography variant="body2">{Utils.timeAgo(props.lastReconcile)} ago</Typography>
          </Box>
        )}
        {props.generation !== undefined && (
          <Typography variant="caption" color="text.secondary">
            Settings generation {props.generation}
            {props.observed !== undefined && props.observed < props.generation
              ? `, applied ${props.observed}`
              : ', applied'}
          </Typography>
        )}
      </Stack>
    </Panel>
  );
}

export function OverviewPage() {
  const data = useK4allData();
  const now = useNow();
  return (
    <Box sx={{ p: { xs: 1, md: 3 } }}>
      <K4allGate data={data} needReleaseManifest>
        {data.cc && data.rm && <OverviewContent data={data} now={now} />}
      </K4allGate>
    </Box>
  );
}

function OverviewContent({ data, now }: { data: ReturnType<typeof useK4allData>; now: number }) {
  const cc = data.cc!;
  const rm = data.rm!;
  const rows = React.useMemo(() => buildRows(rm, cc.spec ?? {}), [rm, cc]);
  const health = clusterHealth({ rm, cc, rows, nodes: data.nodes, now });
  const nodes = nodeRows(data.nodes, data.nodeConfigs);
  const version = releaseVersion(rm);
  const kubelets = kubeletVersions(data.nodes);
  const ready = findCondition(rm.status?.conditions, 'Ready');

  return (
    <>
      <PageHeader
        icon="mdi:hexagon-multiple-outline"
        title="k4all"
        subtitle="Kubernetes for All: release, components and node upgrades"
        actions={
          <>
            {version && <Chip icon={<Icon icon="mdi:tag" />} label={`k4all ${version}`} />}
            {kubelets.length > 0 && (
              <Chip
                icon={<Icon icon="mdi:kubernetes" />}
                label={`Kubernetes ${kubelets.join(', ')}`}
              />
            )}
            <TonePill
              tone={LEVEL_TONE[health.level]}
              label={health.headline}
              busy={health.level === 'progressing' || health.level === 'upgrading'}
            />
          </>
        }
      />

      <Stack spacing={1.5} sx={{ mb: 2 }}>
        {health.banners.map(b => (
          <Alert key={b.id} severity={b.severity}>
            <AlertTitle>{b.title}</AlertTitle>
            {b.detail}
          </Alert>
        ))}
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6} lg={3}>
          <ComponentsPanel rows={rows} />
        </Grid>
        <Grid item xs={12} md={6} lg={3}>
          <FeaturesPanel cc={cc} />
        </Grid>
        <Grid item xs={12} md={6} lg={3}>
          <IngressPanel cc={cc} />
        </Grid>
        <Grid item xs={12} md={6} lg={3}>
          <ReleasePanel
            rows={rows}
            rmReady={ready?.message || ready?.reason}
            lastReconcile={cc.status?.lastReconcileTime}
            observed={cc.status?.observedGeneration}
            generation={cc.metadata.generation}
          />
        </Grid>
        <Grid item xs={12}>
          <Panel title="Nodes" icon="mdi:server-outline" dense>
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Nodes">
                <TableHead>
                  <TableRow>
                    <TableCell>Node</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Kubernetes</TableCell>
                    <TableCell>OS image</TableCell>
                    <TableCell>Runtime</TableCell>
                    <TableCell>Address</TableCell>
                    <TableCell>k4all upgrade</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {nodes.map(n => (
                    <TableRow key={n.name}>
                      <TableCell>
                        <Link routeName="node" params={{ name: n.name }}>
                          {n.name}
                        </Link>
                      </TableCell>
                      <TableCell sx={{ textTransform: 'capitalize' }}>{n.role}</TableCell>
                      <TableCell>
                        <TonePill
                          tone={n.ready ? (n.schedulable ? 'success' : 'warning') : 'error'}
                          label={
                            n.ready ? (n.schedulable ? 'Ready' : 'Ready, cordoned') : 'Not ready'
                          }
                        />
                      </TableCell>
                      <TableCell>{n.kubelet}</TableCell>
                      <TableCell>{n.osImage}</TableCell>
                      <TableCell>{n.runtime}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{n.internalIP}</TableCell>
                      <TableCell>
                        {n.upgrade ? (
                          <TonePill
                            tone="info"
                            busy
                            label={
                              n.upgrade.from && n.upgrade.to
                                ? `${n.upgrade.from} → ${n.upgrade.to}`
                                : n.upgrade.raw
                            }
                          />
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            idle
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Node upgrades run on the nodes with <Mono>sudo k4all-upgrade status|plan|run</Mono>;
              k4all-operator pauses while a node carries the upgrade annotation.
            </Typography>
          </Panel>
        </Grid>
      </Grid>
    </>
  );
}
