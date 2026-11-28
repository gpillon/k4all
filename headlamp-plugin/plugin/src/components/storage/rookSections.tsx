/*
 * The k4all v2.7.2 parts of /k4all/settings/storage (k4all-operator
 * v0.7.0): named OSD devices (#120), the cephcsi build (#121), and the
 * crash collector, monitoring and CephFS (#122). The ClusterConfig parts
 * edit the settings draft; the crash collector is the CephCluster's own
 * setting, read live and patched there (Cairn's too), never through the
 * ClusterConfig. Controls a user may not use are hidden or disabled.
 */

import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';
import { CapabilityId } from '../../model/capabilities';
import { FIELDS } from '../../model/fields';
import { findCondition } from '../../model/health';
import { setPruned } from '../../model/objects';
import {
  belowV3,
  CEPHFS_FILESYSTEM,
  CEPHFS_SELINUX,
  CEPHFS_STORAGE_CLASS,
  ConditionView,
  crashCollectorOf,
  CSI_VARIANT_LABEL,
  csiImageView,
  CsiVariant,
  csiVariant,
  FILESYSTEM_MODE_TEXT,
  FilesystemMode,
  filesystemMode,
  isLogicalVolumePath,
  managerLabel,
  MAX_MONITORING_LABELS,
  MAX_NODE_DEVICES,
  MONITORING_ENABLED_PATH,
  MONITORING_LABELS_PATH,
  monitoringView,
  nodeCpuLevels,
  PROMETHEUS_OPERATOR_MISSING,
  PrometheusOperatorApis,
  prometheusOperatorServed,
  rookReadyHint,
  setCsiVariant,
  setFilesystemMode,
  setStorageNodes,
  storageNodes,
} from '../../model/rookSettings';
import {
  CephClusterLike,
  Condition,
  CONDITION_ROOK_CSI_IMAGE,
  CONDITION_ROOK_MONITORING,
  NodeLike,
  RookStorageNode,
  StorageClassLike,
} from '../../model/types';
import { CAIRN_URL, clusterURL } from '../common/nav';
import { ApplyBadge, CapabilityChip, Mono, Panel, SettingRow, TonePill } from '../common/ui';
import { FieldMessages, isChanged, SectionProps } from '../settings/common';

/** A badge for a v0.7.0 field: Live, or which operator brings it. */
function Badge(props: { has: boolean; id: CapabilityId }) {
  return props.has ? <ApplyBadge mode="live" /> : <CapabilityChip id={props.id} />;
}

/** A condition in words, with the operator's message as written. */
export function ConditionViewAlert(props: { view: ConditionView | null; label: string }) {
  const v = props.view;
  if (!v) {
    return null;
  }
  return (
    <Alert severity={v.severity} sx={{ mb: 1.5 }}>
      <AlertTitle>{v.title}</AlertTitle>
      {v.message && (
        <Box component="span" sx={{ whiteSpace: 'pre-line', display: 'block' }}>
          {v.message}
        </Box>
      )}
      {v.hint && (
        <Typography variant="body2" sx={{ mt: 0.75 }}>
          {v.hint}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        Condition <Mono>{props.label}</Mono>, reported by k4all-operator
      </Typography>
    </Alert>
  );
}

/**
 * RookReady as the operator writes it, with what to do for the reasons of
 * named devices (StorageNodesUnusable, NamedDevicesWithoutOSD).
 */
export function RookReadyAlert(props: { condition?: Condition }) {
  const c = props.condition;
  if (!c || !c.message) {
    return null;
  }
  const hint = rookReadyHint(c);
  return (
    <Alert
      severity={c.status === 'True' ? 'success' : c.status === 'False' ? 'warning' : 'info'}
      sx={{ mb: 2 }}
    >
      <AlertTitle>RookReady{c.reason ? `: ${c.reason}` : ''}</AlertTitle>
      <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
        {c.message}
      </Box>
      {hint && (
        <Typography variant="body2" sx={{ mt: 0.75 }}>
          {hint}
        </Typography>
      )}
    </Alert>
  );
}

// ----------------------------------------------------------- named devices

export interface NamedDevicesProps extends SectionProps {
  /** The cluster's node names, offered for a new entry. */
  nodeNames: string[];
}

/**
 * features.rook.storage.nodes: per node, the devices that become OSDs
 * (logical volumes included). Exclusive with Disks for Ceph (deviceFilter).
 */
export function NamedDevicesRow(props: NamedDevicesProps) {
  const { draft, update, caps } = props;
  const info = FIELDS.rookStorageNodes;
  const named = storageNodes(draft);
  const filterSet = !!draft.features?.rook?.storage?.deviceFilter;
  const editable = !props.disabled && caps.rookOptions;
  const write = (next: RookStorageNode[]) => update(d => setStorageNodes(d, next));
  const setEntry = (i: number, entry: RookStorageNode) =>
    write(named.map((e, j) => (j === i ? entry : e)));
  const unused = props.nodeNames.filter(n => !named.some(e => e.name === n));
  const lv = named.some(e => (e.devices ?? []).some(d => isLogicalVolumePath(d.name)));
  return (
    <SettingRow
      label={info.label}
      help={info.help}
      badge={<Badge has={caps.rookOptions} id="rookOptions" />}
      changed={isChanged(props, info.path)}
      control={
        editable && !filterSet ? (
          <Button
            size="small"
            startIcon={<Icon icon="mdi:database-plus-outline" />}
            onClick={() => write([...named, { name: unused[0] ?? '', devices: [{ name: '' }] }])}
          >
            Add a node
          </Button>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {named.length === 0 ? 'none' : `${named.length} node${named.length === 1 ? '' : 's'}`}
          </Typography>
        )
      }
      messages={
        <Stack spacing={1}>
          {filterSet && named.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Disks for Ceph is set: the two are exclusive. Clear it to name devices instead.
            </Typography>
          )}
          {named.map((entry, i) =>
            editable ? (
              <NamedNodeEditor
                key={i}
                index={i}
                entry={entry}
                options={unused}
                onChange={e => setEntry(i, e)}
                onRemove={() => write(named.filter((_, j) => j !== i))}
              />
            ) : (
              <Typography key={i} variant="body2">
                <Mono>{entry.name || '(no node)'}</Mono>:{' '}
                {(entry.devices ?? []).map((d, j) => (
                  <React.Fragment key={j}>
                    {j > 0 && ', '}
                    <Mono>{d.name}</Mono>
                  </React.Fragment>
                ))}
              </Typography>
            )
          )}
          {lv && (
            <Alert severity="info" sx={{ py: 0 }}>
              A logical volume must exist, be thick (not in a thin pool, as TopoLVM&apos;s are) and
              carry no signature, or Rook&apos;s OSD preparation refuses it:{' '}
              <Mono>
                lvcreate -L &lt;size&gt; -n &lt;lv&gt; --wipesignatures y --zero y &lt;vg&gt;
              </Mono>
              . No encryption, one OSD per device.
            </Alert>
          )}
          <FieldMessages issues={props.issues} field="rookStorageNodes" />
        </Stack>
      }
    />
  );
}

function NamedNodeEditor(props: {
  index: number;
  entry: RookStorageNode;
  options: string[];
  onChange: (e: RookStorageNode) => void;
  onRemove: () => void;
}) {
  const { entry } = props;
  const devices = entry.devices ?? [];
  const label = entry.name || `node ${props.index + 1}`;
  const setDevice = (j: number, name: string) =>
    props.onChange({ ...entry, devices: devices.map((d, k) => (k === j ? { name } : d)) });
  return (
    <Box
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}
      role="group"
      aria-label={`Named devices of ${label}`}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <Autocomplete
          freeSolo
          size="small"
          options={props.options}
          inputValue={entry.name}
          onInputChange={(_, value) => props.onChange({ ...entry, name: value })}
          renderInput={params => (
            <TextField
              {...params}
              placeholder="node name"
              inputProps={{
                ...params.inputProps,
                'aria-label': `Node of entry ${props.index + 1}`,
              }}
            />
          )}
          sx={{ width: 280 }}
        />
        <Box sx={{ flex: 1 }} />
        <Tooltip title={`Remove ${label} and its devices`}>
          <IconButton size="small" aria-label={`Remove ${label}`} onClick={props.onRemove}>
            <Icon icon="mdi:delete-outline" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack spacing={0.75} sx={{ mt: 1, pl: 1 }}>
        {devices.map((d, j) => (
          <Stack key={j} direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              value={d.name}
              placeholder="/dev/vg_data/ceph0"
              onChange={e => setDevice(j, e.target.value.trim())}
              inputProps={{ 'aria-label': `Device ${j + 1} of ${label}` }}
              sx={{ width: 320, '& input': { fontFamily: 'monospace' } }}
            />
            <IconButton
              size="small"
              aria-label={`Remove device ${j + 1} of ${label}`}
              onClick={() =>
                props.onChange({ ...entry, devices: devices.filter((_, k) => k !== j) })
              }
            >
              <Icon icon="mdi:delete-outline" />
            </IconButton>
          </Stack>
        ))}
        {devices.length < MAX_NODE_DEVICES && (
          <Box>
            <Button
              size="small"
              onClick={() => props.onChange({ ...entry, devices: [...devices, { name: '' }] })}
            >
              Add a device to {label}
            </Button>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

// ----------------------------------------------------------- cephcsi build

export interface CsiImagePanelProps extends SectionProps {
  nodes: NodeLike[];
}

/** features.rook.csi.imageVariant and RookCSIImage: which build runs, and why. */
export function CsiImagePanel(props: CsiImagePanelProps) {
  const { draft, update, caps } = props;
  const info = FIELDS.rookCSIImageVariant;
  const variant = csiVariant(draft);
  const levels = nodeCpuLevels(props.nodes);
  const view = csiImageView(findCondition(props.status?.conditions, CONDITION_ROOK_CSI_IMAGE));
  return (
    <Panel title="Ceph CSI image" icon="mdi:chip" id="csi-image">
      <ConditionViewAlert view={view} label={CONDITION_ROOK_CSI_IMAGE} />
      <SettingRow
        label={info.label}
        htmlFor="k4all-rook-csi-variant"
        help={info.help}
        badge={<Badge has={caps.rookOptions} id="rookOptions" />}
        changed={isChanged(props, info.path)}
        last
        control={
          <Select
            id="k4all-rook-csi-variant"
            size="small"
            value={variant}
            disabled={props.disabled || !caps.rookOptions}
            onChange={e => update(d => setCsiVariant(d, e.target.value as CsiVariant))}
            inputProps={{ 'aria-label': info.label }}
            sx={{ minWidth: 240 }}
          >
            {(Object.keys(CSI_VARIANT_LABEL) as CsiVariant[]).map(v => (
              <MenuItem key={v} value={v}>
                {CSI_VARIANT_LABEL[v]}
              </MenuItem>
            ))}
          </Select>
        }
        messages={
          <Stack spacing={1}>
            <FieldMessages issues={props.issues} field="rookCSIImageVariant" />
            {levels.length > 0 && (
              <Stack
                direction="row"
                spacing={0.75}
                flexWrap="wrap"
                useFlexGap
                aria-label="CPU level per node"
              >
                {levels.map(n => (
                  <TonePill
                    key={n.name}
                    tone={
                      n.arch !== 'amd64'
                        ? 'neutral'
                        : belowV3(n.level)
                        ? 'warning'
                        : n.level
                        ? 'success'
                        : 'neutral'
                    }
                    label={`${n.name}: ${
                      n.arch !== 'amd64'
                        ? `${n.arch}, either build`
                        : n.level
                        ? `x86-64-${n.level}`
                        : 'no level reported'
                    }`}
                    title={
                      n.arch === 'amd64' && !n.level
                        ? 'k4all v2.7.2 and later publish the level on the Node (k4all.magesgate.com/x86-64-level).'
                        : undefined
                    }
                  />
                ))}
              </Stack>
            )}
            <Typography variant="body2" color="text.secondary">
              A different build restarts the CSI plugins one node at a time (the controller plugin
              once: provisioning and attach pause for its restart). Mounted volumes stay mounted.
            </Typography>
          </Stack>
        }
      />
    </Panel>
  );
}

// --------------------------------------------------------- crash collector

export interface CrashCollectorPanelProps {
  clusters: CephClusterLike[];
  /** Per namespace/name: the user may patch the CephCluster. */
  canPatch: Record<string, boolean>;
  /** Patches spec.crashCollector.disable; rejects with the error to show. */
  onSet: (cluster: CephClusterLike, on: boolean) => Promise<void>;
}

/**
 * The crash collector of each CephCluster, as the CephCluster has it now,
 * with an on/off that patches the CephCluster (a day-2 edit, like Cairn's).
 * Not a ClusterConfig setting: k4all seeds it once and never sets it again.
 */
export function CrashCollectorPanel(props: CrashCollectorPanelProps) {
  const [confirm, setConfirm] = React.useState<{ c: CephClusterLike; on: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = async () => {
    if (!confirm) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSet(confirm.c, confirm.on);
      setConfirm(null);
    } catch (err) {
      setError((err as { message?: string })?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Crash collector" icon="mdi:alert-octagon-outline" id="crash-collector">
      {props.clusters.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          k4all creates the Ceph cluster with the crash collector on, keeping crash reports for 30
          days. After that it is the CephCluster&apos;s own setting (here or in Cairn): k4all never
          changes it again.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {props.clusters.map(c => {
            const key = `${c.metadata.namespace}/${c.metadata.name}`;
            const view = crashCollectorOf(c);
            return (
              <SettingRow
                key={key}
                label={
                  <>
                    <Mono>{key}</Mono> crash collector
                  </>
                }
                help={
                  <>
                    Ceph daemons that crash are restarted either way; with the collector on, Ceph
                    records why (Cairn, Crashes).{' '}
                    {view.set
                      ? [
                          view.daysToRetain !== undefined
                            ? `Reports are kept ${view.daysToRetain} days.`
                            : '',
                          view.managers.length
                            ? `Last set by ${view.managers.map(managerLabel).join(', ')}.`
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')
                      : 'Not in the CephCluster: Rook runs it.'}
                  </>
                }
                last
                control={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TonePill
                      tone={view.on ? 'success' : 'neutral'}
                      label={view.on ? 'On' : 'Off'}
                    />
                    {props.canPatch[key] && (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => {
                          setError(null);
                          setConfirm({ c, on: !view.on });
                        }}
                      >
                        {view.on ? 'Turn off' : 'Turn on'}
                      </Button>
                    )}
                  </Stack>
                }
              />
            );
          })}
          <Typography variant="body2" color="text.secondary">
            The value shown is the CephCluster&apos;s: a change made in{' '}
            <a href={clusterURL(CAIRN_URL)}>Cairn</a> shows here, and k4all keeps it.
          </Typography>
        </Stack>
      )}
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {confirm?.on ? 'Turn the crash collector on?' : 'Turn the crash collector off?'}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Typography>
              Sets <Mono>spec.crashCollector.disable: {confirm?.on ? 'false' : 'true'}</Mono> on the
              CephCluster{' '}
              <Mono>
                {confirm?.c.metadata.namespace}/{confirm?.c.metadata.name}
              </Mono>
              , nothing else.
            </Typography>
            <Typography color="text.secondary">
              {confirm?.on
                ? 'Rook runs a collector pod on each node with Ceph daemons. It posts the crash dumps the nodes kept, so a RECENT_CRASH warning may show at once: archive the reports in Cairn.'
                : 'Rook removes the collector pods: crashed daemons are still restarted, but Ceph no longer records why.'}
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={run} disabled={busy}>
            {confirm?.on ? 'Turn on' : 'Turn off'}
          </Button>
        </DialogActions>
      </Dialog>
    </Panel>
  );
}

// -------------------------------------------------------------- monitoring

export interface MonitoringPanelProps extends SectionProps {
  /** null until the first answer. */
  apis: PrometheusOperatorApis | null;
  /** The check itself failed (not a 404). */
  apisError?: string | null;
}

/** features.rook.monitoring: the switch, the Prometheus Operator check, the labels, RookMonitoring. */
export function MonitoringPanel(props: MonitoringPanelProps) {
  const { draft, update, caps } = props;
  const info = FIELDS.rookMonitoringEnabled;
  const labelsInfo = FIELDS.rookMonitoringLabels;
  const m = draft.features?.rook?.monitoring ?? {};
  const enabled = m.enabled === true;
  const labels = Object.entries(m.labels ?? {});
  const editable = !props.disabled && caps.rookOptions;
  const cond = findCondition(props.status?.conditions, CONDITION_ROOK_MONITORING);
  const view = monitoringView(cond);
  // The condition says it already: the page's own check is for before the switch is on.
  const saidByCondition = enabled && cond?.reason === 'PrometheusOperatorMissing';
  const writeLabels = (entries: [string, string][]) =>
    update(d =>
      setPruned(d, MONITORING_LABELS_PATH, entries.length ? Object.fromEntries(entries) : undefined)
    );
  return (
    <Panel title="Monitoring" icon="mdi:chart-line" id="monitoring">
      <ConditionViewAlert view={view} label={CONDITION_ROOK_MONITORING} />
      <SettingRow
        label={info.label}
        htmlFor="k4all-rook-monitoring"
        help={info.help}
        badge={<Badge has={caps.rookOptions} id="rookOptions" />}
        changed={isChanged(props, info.path)}
        control={
          <Switch
            id="k4all-rook-monitoring"
            checked={enabled}
            disabled={!editable}
            onChange={(_, checked) =>
              update(d => setPruned(d, MONITORING_ENABLED_PATH, checked ? true : undefined))
            }
            inputProps={{ 'aria-label': info.label }}
          />
        }
        messages={
          <Stack spacing={1}>
            {props.apis === null ? (
              <Typography variant="body2" color="text.secondary">
                {props.apisError
                  ? `Could not check for a Prometheus Operator: ${props.apisError}`
                  : 'Checking for a Prometheus Operator…'}
              </Typography>
            ) : prometheusOperatorServed(props.apis) ? (
              <Typography variant="body2" color="text.secondary">
                The cluster serves ServiceMonitor and PrometheusRule (monitoring.coreos.com).
              </Typography>
            ) : saidByCondition ? null : (
              <Alert severity={enabled ? 'warning' : 'info'} sx={{ py: 0 }}>
                {PROMETHEUS_OPERATOR_MISSING}
              </Alert>
            )}
            <Typography variant="body2" color="text.secondary">
              Once on, k4all owns <Mono>spec.monitoring.enabled</Mono> and{' '}
              <Mono>spec.labels.monitoring</Mono> of the CephCluster it created (Cairn shows them
              read-only); off removes them and the alert rules.
            </Typography>
          </Stack>
        }
      />
      <SettingRow
        label={labelsInfo.label}
        help={labelsInfo.help}
        badge={<Badge has={caps.rookOptions} id="rookOptions" />}
        changed={isChanged(props, labelsInfo.path)}
        last
        control={
          editable && labels.length < MAX_MONITORING_LABELS && !labels.some(([k]) => k === '') ? (
            <Button size="small" onClick={() => writeLabels([...labels, ['', '']])}>
              Add a label
            </Button>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {labels.length === 0 ? 'none' : `${labels.length} of ${MAX_MONITORING_LABELS}`}
            </Typography>
          )
        }
        messages={
          <Stack spacing={0.75}>
            {labels.map(([k, v], i) =>
              editable ? (
                <Stack key={i} direction="row" spacing={1} alignItems="center">
                  <TextField
                    size="small"
                    value={k}
                    placeholder="release"
                    onChange={e => {
                      const key = e.target.value.trim();
                      if (key !== k && labels.some(([other]) => other === key)) {
                        return; // a key once
                      }
                      writeLabels(labels.map((x, j) => (j === i ? [key, v] : x)));
                    }}
                    inputProps={{ 'aria-label': `Key of label ${i + 1}` }}
                    sx={{ width: 220, '& input': { fontFamily: 'monospace' } }}
                  />
                  <Typography>=</Typography>
                  <TextField
                    size="small"
                    value={v}
                    placeholder="kube-prometheus-stack"
                    onChange={e =>
                      writeLabels(labels.map((x, j) => (j === i ? [k, e.target.value.trim()] : x)))
                    }
                    inputProps={{ 'aria-label': `Value of label ${i + 1}` }}
                    sx={{ width: 240, '& input': { fontFamily: 'monospace' } }}
                  />
                  <IconButton
                    size="small"
                    aria-label={`Remove label ${k || i + 1}`}
                    onClick={() => writeLabels(labels.filter((_, j) => j !== i))}
                  >
                    <Icon icon="mdi:delete-outline" />
                  </IconButton>
                </Stack>
              ) : (
                <Typography key={i} variant="body2">
                  <Mono>
                    {k}={v}
                  </Mono>
                </Typography>
              )
            )}
            <FieldMessages issues={props.issues} field="rookMonitoringLabels" />
          </Stack>
        }
      />
    </Panel>
  );
}

// ------------------------------------------------------------------ CephFS

export interface CephFsPanelProps extends SectionProps {
  /** null until read. */
  storageClasses: StorageClassLike[] | null;
}

const FILESYSTEM_OPTIONS: { value: FilesystemMode; label: string }[] = [
  { value: 'default', label: 'Not set: with a new Ceph cluster' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** features.rook.filesystem.enabled: absent, on or off, with what exists and the SELinux limit. */
export function CephFsPanel(props: CephFsPanelProps) {
  const { draft, update, caps } = props;
  const info = FIELDS.rookFilesystemEnabled;
  const mode = filesystemMode(draft);
  const present = props.storageClasses?.some(s => s.metadata.name === CEPHFS_STORAGE_CLASS);
  return (
    <Panel title="CephFS" icon="mdi:folder-network-outline" id="cephfs">
      <SettingRow
        label={info.label}
        htmlFor="k4all-rook-cephfs"
        help={info.help}
        badge={<Badge has={caps.rookOptions} id="rookOptions" />}
        changed={isChanged(props, info.path)}
        last
        control={
          <Select
            id="k4all-rook-cephfs"
            size="small"
            value={mode}
            disabled={props.disabled || !caps.rookOptions}
            onChange={e => update(d => setFilesystemMode(d, e.target.value as FilesystemMode))}
            inputProps={{ 'aria-label': info.label }}
            sx={{ minWidth: 240 }}
          >
            {FILESYSTEM_OPTIONS.map(o => (
              <MenuItem key={o.value} value={o.value}>
                {o.label}
              </MenuItem>
            ))}
          </Select>
        }
        messages={
          <Stack spacing={1}>
            <Typography variant="body2">{FILESYSTEM_MODE_TEXT[mode]}</Typography>
            <Typography variant="body2" color="text.secondary">
              StorageClass <Mono>{CEPHFS_STORAGE_CLASS}</Mono>:{' '}
              {present === undefined ? 'checking…' : present ? 'present' : 'not created'} (CephFS{' '}
              <Mono>{CEPHFS_FILESYSTEM}</Mono>, two pools and two MDS daemons of up to 1 GiB of
              memory each).
            </Typography>
            <Alert severity="info" sx={{ py: 0 }}>
              {CEPHFS_SELINUX}
            </Alert>
          </Stack>
        }
      />
    </Panel>
  );
}
