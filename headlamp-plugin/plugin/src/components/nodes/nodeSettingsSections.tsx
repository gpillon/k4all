/*
 * The sections of /k4all/settings/nodes (k4all v2.7.0): kubelet settings,
 * hugepages with the memory per node, IOMMU, the plan of a change, and the
 * rollout as the operator reports it.
 */

import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import { FieldId, FIELDS } from '../../model/fields';
import {
  ACTION_LABEL,
  HUGEPAGE_REFUSE_PERCENT,
  HUGEPAGE_WARN_PERCENT,
  hugepageMath,
  nodeCpus,
  RolloutPlan,
  RolloutView,
} from '../../model/nodeSettings';
import { getIn, setPruned } from '../../model/objects';
import { NodeLike } from '../../model/types';
import { ApplyBadge, Mono, Panel, SettingRow, TonePill } from '../common/ui';
import { FieldMessages, isChanged, SectionProps } from '../settings/common';

export interface NodeSectionProps extends SectionProps {
  nodes: NodeLike[];
}

const GiB = 2 ** 30;
const fmtGiB = (bytes: number) => `${Math.round((bytes / GiB) * 10) / 10} GiB`;

function NotSetSelect(props: {
  id: string;
  field: FieldId;
  options: string[];
  value: string | undefined;
  disabled: boolean;
  onChange: (v: string | undefined) => void;
}) {
  const info = FIELDS[props.field];
  return (
    <Select
      id={props.id}
      size="small"
      value={props.value ?? ''}
      displayEmpty
      disabled={props.disabled}
      onChange={e => props.onChange(e.target.value === '' ? undefined : String(e.target.value))}
      inputProps={{ 'aria-label': info.label }}
      sx={{ minWidth: 200 }}
    >
      <MenuItem value="">Not set by k4all</MenuItem>
      {props.options.map(o => (
        <MenuItem key={o} value={o}>
          {o}
        </MenuItem>
      ))}
    </Select>
  );
}

function numberOrUndefined(text: string): number | undefined {
  const v = text.trim();
  return v === '' ? undefined : Number(v);
}

export function KubeletSection(props: NodeSectionProps) {
  const { draft, update, disabled, issues } = props;
  const kubelet = draft.nodes?.kubelet ?? {};
  const set = (field: FieldId, value: unknown) =>
    update(d => setPruned(d, FIELDS[field].path, value));
  const cpus = props.nodes
    .map(n => ({ node: n.metadata.name, cpus: nodeCpus(n) }))
    .sort((a, b) => a.node.localeCompare(b.node));
  return (
    <Panel title="kubelet" icon="mdi:cog-outline">
      <SettingRow
        label={FIELDS.nodesMaxPods.label}
        htmlFor="k4all-max-pods"
        help={
          <>
            {FIELDS.nodesMaxPods.help} Changing only this restarts kubelet, without a drain. Not
            set: kubeadm&apos;s value (110, or what an admin set in{' '}
            <Mono>kube-system/kubelet-config</Mono>) stays.
          </>
        }
        badge={<ApplyBadge mode="live" />}
        changed={isChanged(props, FIELDS.nodesMaxPods.path)}
        control={
          <TextField
            id="k4all-max-pods"
            size="small"
            type="number"
            placeholder="not set by k4all"
            value={kubelet.maxPods ?? ''}
            disabled={disabled}
            onChange={e => set('nodesMaxPods', numberOrUndefined(e.target.value))}
            inputProps={{ 'aria-label': FIELDS.nodesMaxPods.label, min: 10, max: 1000 }}
            sx={{ width: 200 }}
          />
        }
        messages={<FieldMessages issues={issues} field="maxPods" />}
      />
      <SettingRow
        label={FIELDS.nodesCpuManager.label}
        htmlFor="k4all-cpu-manager"
        help={FIELDS.nodesCpuManager.help}
        changed={isChanged(props, FIELDS.nodesCpuManager.path)}
        control={
          <NotSetSelect
            id="k4all-cpu-manager"
            field="nodesCpuManager"
            options={['none', 'static']}
            value={kubelet.cpuManagerPolicy}
            disabled={disabled}
            onChange={v => set('nodesCpuManager', v)}
          />
        }
      />
      <SettingRow
        label={FIELDS.nodesReservedCPUs.label}
        htmlFor="k4all-reserved-cpus"
        help={FIELDS.nodesReservedCPUs.help}
        changed={isChanged(props, FIELDS.nodesReservedCPUs.path)}
        control={
          <TextField
            id="k4all-reserved-cpus"
            size="small"
            placeholder={
              kubelet.cpuManagerPolicy === 'static' ? 'required, e.g. 0-1' : 'not set by k4all'
            }
            value={kubelet.reservedSystemCPUs ?? ''}
            disabled={disabled}
            onChange={e => set('nodesReservedCPUs', e.target.value.trim() || undefined)}
            inputProps={{ 'aria-label': FIELDS.nodesReservedCPUs.label }}
            sx={{ width: 200 }}
          />
        }
        messages={
          <Stack spacing={0.75}>
            <Stack
              direction="row"
              spacing={0.5}
              flexWrap="wrap"
              useFlexGap
              aria-label="CPUs per node"
            >
              {cpus.map(c => (
                <Chip
                  key={c.node}
                  size="small"
                  variant="outlined"
                  label={
                    c.cpus === null
                      ? `${c.node}: CPUs unknown`
                      : `${c.node}: ${c.cpus} CPUs (0-${c.cpus - 1})`
                  }
                />
              ))}
            </Stack>
            <FieldMessages issues={issues} field="reservedSystemCPUs" />
          </Stack>
        }
      />
      <SettingRow
        label={FIELDS.nodesTopologyPolicy.label}
        htmlFor="k4all-topology-policy"
        help={FIELDS.nodesTopologyPolicy.help}
        changed={isChanged(props, FIELDS.nodesTopologyPolicy.path)}
        control={
          <NotSetSelect
            id="k4all-topology-policy"
            field="nodesTopologyPolicy"
            options={['none', 'best-effort', 'restricted', 'single-numa-node']}
            value={kubelet.topologyManagerPolicy}
            disabled={disabled}
            onChange={v => set('nodesTopologyPolicy', v)}
          />
        }
        messages={<FieldMessages issues={issues} field="topologyManagerPolicy" />}
      />
      <SettingRow
        label={FIELDS.nodesTopologyScope.label}
        htmlFor="k4all-topology-scope"
        help={FIELDS.nodesTopologyScope.help}
        changed={isChanged(props, FIELDS.nodesTopologyScope.path)}
        last
        control={
          <NotSetSelect
            id="k4all-topology-scope"
            field="nodesTopologyScope"
            options={['container', 'pod']}
            value={kubelet.topologyManagerScope}
            disabled={disabled}
            onChange={v => set('nodesTopologyScope', v)}
          />
        }
      />
    </Panel>
  );
}

export function MemorySection(props: NodeSectionProps) {
  const { draft, base, update, disabled, issues } = props;
  const hugepages = draft.nodes?.hugepages;
  const rows = hugepageMath(hugepages, props.nodes);
  const total = rows[0]?.hugepageBytes ?? 0;
  const set = (field: FieldId, value: unknown) =>
    update(d => setPruned(d, FIELDS[field].path, value));
  const iommu = draft.nodes?.iommu === true;
  const baseIommu = getIn(base, FIELDS.nodesIommu.path);
  return (
    <Panel title="Hugepages and IOMMU" icon="mdi:memory">
      {(['nodesHugepages1Gi', 'nodesHugepages2Mi'] as const).map(field => (
        <SettingRow
          key={field}
          label={FIELDS[field].label}
          htmlFor={`k4all-${field}`}
          help={`${FIELDS[field].help} A change reboots the nodes, one at a time.`}
          badge={<ApplyBadge mode="live" />}
          changed={isChanged(props, FIELDS[field].path)}
          control={
            <TextField
              id={`k4all-${field}`}
              size="small"
              type="number"
              placeholder="not set by k4all"
              value={(getIn(draft, FIELDS[field].path) as number | undefined) ?? ''}
              disabled={disabled}
              onChange={e => set(field, numberOrUndefined(e.target.value))}
              inputProps={{ 'aria-label': FIELDS[field].label, min: 0 }}
              sx={{ width: 200 }}
            />
          }
        />
      ))}
      <Box sx={{ py: 1.5, pl: 1.5 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {total > 0
            ? `${fmtGiB(
                total
              )} of hugepages on every node. Keep them at ${HUGEPAGE_WARN_PERCENT} % of a node's memory or less; k4all-operator refuses more than ${HUGEPAGE_REFUSE_PERCENT} %.`
            : 'No hugepages requested.'}
        </Typography>
        {total > 0 && (
          <Table size="small" aria-label="Hugepage memory per node">
            <TableHead>
              <TableRow>
                <TableCell>Node</TableCell>
                <TableCell>Memory</TableCell>
                <TableCell>Hugepages</TableCell>
                <TableCell sx={{ width: '40%' }}>Share</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.node}>
                  <TableCell>{r.node}</TableCell>
                  <TableCell>
                    {r.memoryBytes === null ? 'unknown' : fmtGiB(r.memoryBytes)}
                  </TableCell>
                  <TableCell>{fmtGiB(r.hugepageBytes)}</TableCell>
                  <TableCell>
                    {r.percent === null ? (
                      <Typography variant="body2" color="text.secondary">
                        unknown
                      </Typography>
                    ) : (
                      <Stack direction="row" spacing={1} alignItems="center">
                        <LinearProgress
                          variant="determinate"
                          value={Math.min(100, r.percent)}
                          color={
                            r.level === 'error'
                              ? 'error'
                              : r.level === 'warning'
                              ? 'warning'
                              : 'primary'
                          }
                          sx={{ flex: 1, height: 8, borderRadius: 999 }}
                          aria-label={`${r.node} hugepage share`}
                        />
                        <Typography variant="body2" sx={{ minWidth: 56 }}>
                          {Math.round(r.percent * 10) / 10} %
                        </Typography>
                      </Stack>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Box sx={{ mt: 1 }}>
          <FieldMessages issues={issues} field="hugepages" />
        </Box>
      </Box>
      <SettingRow
        label={FIELDS.nodesIommu.label}
        htmlFor="k4all-iommu"
        help={`${FIELDS.nodesIommu.help} A change reboots the nodes, one at a time.`}
        badge={<ApplyBadge mode="live" />}
        changed={isChanged(props, FIELDS.nodesIommu.path)}
        last
        control={
          <Switch
            id="k4all-iommu"
            checked={iommu}
            disabled={disabled}
            // Off: leave it unset unless it was explicitly false.
            onChange={(_, checked) =>
              set('nodesIommu', checked ? true : baseIommu === false ? false : undefined)
            }
            inputProps={{ 'aria-label': FIELDS.nodesIommu.label }}
          />
        }
      />
    </Panel>
  );
}

const DRAIN_LABEL = { none: 'no drain', drain: 'drain', cordon: 'cordon only' };

/** The plan of a change: what the nodes do, in which order, what stops. */
export function PlanView(props: { plan: RolloutPlan; title?: string }) {
  const { plan } = props;
  if (!plan.action) {
    return null;
  }
  return (
    <Alert
      severity={plan.action === 'restart' ? 'info' : 'warning'}
      icon={<Icon icon="mdi:format-list-numbered" />}
    >
      <AlertTitle>
        {props.title ?? 'What saving does'}: {ACTION_LABEL[plan.action]}
      </AlertTitle>
      <Typography variant="body2">{plan.summary}</Typography>
      <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 600 }}>
        {plan.downtime}
      </Typography>
      <Table size="small" aria-label="Rollout order" sx={{ mt: 1 }}>
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell>
            <TableCell>Node</TableCell>
            <TableCell>Role</TableCell>
            <TableCell>Drain</TableCell>
            <TableCell>Then</TableCell>
            <TableCell>Note</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {plan.steps.map((s, i) => (
            <TableRow key={s.node}>
              <TableCell>{s.skipped ? '—' : i + 1}</TableCell>
              <TableCell>{s.node}</TableCell>
              <TableCell sx={{ textTransform: 'capitalize' }}>{s.role}</TableCell>
              <TableCell>{s.skipped ? 'skipped' : DRAIN_LABEL[s.drain]}</TableCell>
              <TableCell>
                {s.skipped ? '—' : s.restart === 'reboot' ? 'reboot' : 'kubelet restart'}
              </TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  {s.note ?? ''}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Alert>
  );
}

const PHASE_TONE: Record<string, 'success' | 'info' | 'warning' | 'error' | 'neutral'> = {
  Idle: 'success',
  Rolling: 'info',
  Paused: 'warning',
  Blocked: 'error',
};

/** The rollout as status.nodes reports it, with Pause / Resume. */
export function RolloutPanel(props: {
  view: RolloutView;
  canPause: boolean;
  busy: boolean;
  onPause: (paused: boolean) => void;
}) {
  const { view } = props;
  const pausing = view.paused && view.phase === 'Rolling';
  return (
    <Panel
      title="Rollout"
      icon="mdi:progress-wrench"
      action={
        <Stack direction="row" spacing={1} alignItems="center">
          <TonePill
            tone={PHASE_TONE[view.phase] ?? 'neutral'}
            busy={view.phase === 'Rolling'}
            label={pausing ? 'Pausing' : view.phase}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={!props.canPause || props.busy}
            startIcon={<Icon icon={view.paused ? 'mdi:play' : 'mdi:pause'} />}
            onClick={() => props.onPause(!view.paused)}
          >
            {view.paused ? 'Resume' : 'Pause'}
          </Button>
        </Stack>
      }
    >
      <Stack spacing={1.25}>
        {view.stale && (
          <Alert severity="info">k4all-operator has not picked up the latest settings yet.</Alert>
        )}
        {view.message && (
          <Typography variant="body2">
            {view.currentNode && (
              <>
                <Mono>{view.currentNode}</Mono>:{' '}
              </>
            )}
            {view.message}
          </Typography>
        )}
        {view.condition?.message && view.condition.message !== view.message && (
          <Typography variant="body2" color="text.secondary">
            {view.condition.reason ? `${view.condition.reason}: ` : ''}
            {view.condition.message}
          </Typography>
        )}
        {pausing && (
          <Typography variant="body2" color="text.secondary">
            Paused: the node in progress finishes, then the rollout stops.
          </Typography>
        )}
        {view.total > 0 ? (
          <>
            <Stack direction="row" spacing={1} alignItems="center">
              <LinearProgress
                variant="determinate"
                value={(view.done / view.total) * 100}
                sx={{ flex: 1, height: 8, borderRadius: 999 }}
                aria-label="Nodes with the settings"
              />
              <Typography variant="body2">
                {view.done} of {view.total} nodes
              </Typography>
            </Stack>
            <Table size="small" aria-label="Rollout per node">
              <TableHead>
                <TableRow>
                  <TableCell>Node</TableCell>
                  <TableCell>Settings</TableCell>
                  <TableCell>Phase</TableCell>
                  <TableCell>Message</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {view.nodes.map(n => (
                  <TableRow key={n.name} selected={n.current}>
                    <TableCell>{n.name}</TableCell>
                    <TableCell>
                      <TonePill
                        tone={n.applied ? 'success' : n.current ? 'info' : 'neutral'}
                        busy={n.current && !n.applied}
                        label={n.applied ? 'applied' : n.current ? 'in progress' : 'pending'}
                      />
                    </TableCell>
                    <TableCell>{n.phase ?? '—'}</TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {n.message ?? ''}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No rollout yet: k4all owns no node setting, or the operator has not reported one.
          </Typography>
        )}
      </Stack>
    </Panel>
  );
}
