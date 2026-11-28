/*
 * The sections of /k4all/settings/virtualization (k4all v2.7.0): feature
 * gates (#feature-gates), VM state (#vm-state), Hangar's node agent and,
 * from k4all v2.7.2, its guest bridge, the metadata service (#metadata).
 * Each edits the settings draft only.
 */

import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Chip,
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';
import {
  componentActivation,
  displayState,
  HANGAR_GUEST_BRIDGE,
  hookFailure,
} from '../../model/components';
import { FIELDS } from '../../model/fields';
import {
  GateRow,
  gateRows,
  gateTableFor,
  hasDisabledList,
  kubevirtVersion,
  Maturity,
  setK4allGate,
} from '../../model/gates';
import { setPruned } from '../../model/objects';
import {
  ComponentSpec,
  ComponentStatus,
  KubeVirtLike,
  METADATA_OPT_IN_LABEL,
  METADATA_SERVICE_ACCOUNT_LABEL,
  StorageClassLike,
  StorageProfileLike,
} from '../../model/types';
import { vmStateInfo } from '../../model/virtSettings';
import { clusterURL, HANGAR_SETTINGS_URL, HANGAR_URL } from '../common/nav';
import { ApplyBadge, CapabilityChip, Mono, Panel, SettingRow, TonePill } from '../common/ui';
import { FieldMessages, isChanged, SectionProps } from '../settings/common';

// ------------------------------------------------------------ Feature gates

const MATURITY_ORDER: Record<string, number> = {
  Alpha: 0,
  Beta: 1,
  Deprecated: 2,
  GA: 3,
  Discontinued: 4,
};

const MATURITY_COLOR: Record<Maturity, 'warning' | 'info' | 'success' | 'default'> = {
  Alpha: 'warning',
  Beta: 'info',
  GA: 'success',
  Deprecated: 'default',
  Discontinued: 'default',
};

function sortRows(rows: GateRow[]): GateRow[] {
  const ownerRank = { k4all: 0, elsewhere: 1, none: 2 };
  return [...rows].sort(
    (a, b) =>
      ownerRank[a.owner] - ownerRank[b.owner] ||
      (MATURITY_ORDER[a.maturity ?? ''] ?? 5) - (MATURITY_ORDER[b.maturity ?? ''] ?? 5) ||
      a.name.localeCompare(b.name)
  );
}

/** The gates worth showing by default: set by someone, or Alpha/Beta (the ones a choice matters for). */
export function relevantGate(row: GateRow): boolean {
  return (
    row.owner !== 'none' ||
    row.maturity === 'Alpha' ||
    row.maturity === 'Beta' ||
    row.maturity === null
  );
}

function OnPill(props: { on: boolean | null; label?: string }) {
  if (props.on === null) {
    return <TonePill tone="neutral" label={props.label ?? 'unknown'} />;
  }
  return <TonePill tone={props.on ? 'success' : 'neutral'} label={props.on ? 'on' : 'off'} />;
}

function OwnerCell({ row }: { row: GateRow }) {
  if (row.owner === 'k4all') {
    return (
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Chip size="small" color="primary" label="k4all" />
        {row.pending && (
          <Tooltip title="Saved in the ClusterConfig; k4all-operator has not applied it to the KubeVirt CR yet.">
            <Chip size="small" variant="outlined" label="not applied yet" />
          </Tooltip>
        )}
      </Stack>
    );
  }
  if (row.owner === 'elsewhere') {
    return (
      <Tooltip title="In the KubeVirt CR but not in k4all's annotation: set in Hangar or by an admin. k4all keeps it.">
        <Chip size="small" variant="outlined" label="set elsewhere" />
      </Tooltip>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      {row.pending ? 'k4all removes its entry' : '—'}
    </Typography>
  );
}

export interface GatesSectionProps extends SectionProps {
  kv: KubeVirtLike | null;
  /** The release's KubeVirt version, for the table without a KubeVirt CR. */
  releaseVersion?: string;
  /** Reports the other hot-plug gate a change turned off. */
  onAlso?: (gates: string[]) => void;
}

export function GatesSection(props: GatesSectionProps) {
  const { draft, base, update, disabled, kv } = props;
  const [filter, setFilter] = React.useState<'relevant' | 'all'>('relevant');
  const [search, setSearch] = React.useState('');
  const [newGate, setNewGate] = React.useState('');
  const running = kubevirtVersion(kv);
  const version = running ?? props.releaseVersion;
  const table = gateTableFor(version);
  const ctx = { kv, version };
  const rows = sortRows(gateRows({ ...ctx, spec: draft }));
  const before = new Map(gateRows({ ...ctx, spec: base }).map(r => [r.name, r]));
  const shown = rows.filter(
    r =>
      (filter === 'all' || relevantGate(r)) &&
      (!search || r.name.toLowerCase().includes(search.toLowerCase()))
  );
  const set = (name: string, value: 'on' | 'off' | undefined) => {
    // What else changes, from the draft on screen; the update itself runs later.
    const { also } = setK4allGate(draft, name, value, ctx);
    update(d => setK4allGate(d, name, value, ctx).spec);
    if (also.length) {
      props.onAlso?.(also);
    }
  };
  const changed =
    isChanged(props, ['features', 'virt', 'kubevirt', 'featureGates']) ||
    isChanged(props, ['features', 'virt', 'kubevirt', 'disabledFeatureGates']);

  return (
    <Panel
      id="feature-gates"
      title="KubeVirt feature gates"
      icon="mdi:toggle-switch-outline"
      action={
        <Stack direction="row" spacing={1} alignItems="center">
          {changed && <Chip size="small" color="primary" label="changed" />}
          <Chip
            size="small"
            variant="outlined"
            label={
              running
                ? `KubeVirt ${running}${table ? '' : ', no table'}`
                : version
                ? `KubeVirt not running (release: ${version})`
                : 'KubeVirt not running'
            }
          />
        </Stack>
      }
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        k4all adds the gates you turn <b>on</b> to the KubeVirt CR, next to the ones Hangar or an
        admin set, which stay. <b>Off</b> removes a gate even where someone else set it
        {hasDisabledList(version)
          ? ', and lists it in disabledFeatureGates (a Beta gate is on by default from KubeVirt 1.9)'
          : ''}
        . <b>Not set</b> leaves the gate to Hangar. GA gates are always on and cannot be turned off.
        What each gate unlocks in Hangar:{' '}
        <a href={clusterURL(HANGAR_SETTINGS_URL)}>Hangar, Settings</a>.
      </Typography>
      {!table && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {version
            ? `No gate table for KubeVirt ${version} in this plugin: maturity is unknown, and only the gates listed somewhere are shown.`
            : 'The KubeVirt version is unknown: only the gates listed somewhere are shown.'}
        </Alert>
      )}
      <FieldMessages issues={props.issues} field="kubevirtGates" />
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        alignItems={{ sm: 'center' }}
        sx={{ my: 1.5 }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          aria-label="Which gates"
        >
          <ToggleButton value="relevant">Set, Alpha and Beta</ToggleButton>
          <ToggleButton value="all">All {rows.length}</ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder="Search gates"
          value={search}
          onChange={e => setSearch(e.target.value)}
          inputProps={{ 'aria-label': 'Search gates' }}
        />
      </Stack>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label="KubeVirt feature gates">
          <TableHead>
            <TableRow>
              <TableCell>Gate</TableCell>
              <TableCell>Maturity</TableCell>
              <TableCell>Default</TableCell>
              <TableCell>Now</TableCell>
              <TableCell>Set by</TableCell>
              <TableCell>k4all</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map(row => {
              const was = before.get(row.name);
              const rowChanged = was?.k4all !== row.k4all;
              return (
                <TableRow
                  key={row.name}
                  sx={
                    rowChanged
                      ? { boxShadow: theme => `inset 3px 0 ${theme.palette.primary.main}` }
                      : undefined
                  }
                >
                  <TableCell sx={{ fontFamily: 'monospace' }}>{row.name}</TableCell>
                  <TableCell>
                    {row.maturity ? (
                      <Chip
                        size="small"
                        variant={row.maturity === 'GA' ? 'filled' : 'outlined'}
                        color={MATURITY_COLOR[row.maturity]}
                        label={row.maturity}
                      />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        unknown
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {row.defaultOn === null ? '—' : row.defaultOn ? 'on' : 'off'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <OnPill on={row.onNow} label={kv ? 'unknown' : '—'} />
                      {row.onAfter !== row.onNow && row.onAfter !== null && (
                        <Tooltip title="Once k4all-operator applied the settings">
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Icon icon="mdi:arrow-right" width={14} height={14} />
                            <OnPill on={row.onAfter} />
                          </Stack>
                        </Tooltip>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <OwnerCell row={row} />
                  </TableCell>
                  <TableCell>
                    <Select
                      size="small"
                      value={row.k4all ?? 'none'}
                      disabled={disabled}
                      onChange={e => {
                        const v = e.target.value as string;
                        set(row.name, v === 'none' ? undefined : (v as 'on' | 'off'));
                      }}
                      inputProps={{ 'aria-label': `k4all setting of ${row.name}` }}
                      sx={{ minWidth: 120 }}
                    >
                      <MenuItem value="none">Not set</MenuItem>
                      <MenuItem value="on">On</MenuItem>
                      <MenuItem value="off" disabled={!row.canDisable}>
                        {row.canDisable ? 'Off' : 'Off (GA: always on)'}
                      </MenuItem>
                    </Select>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
        <TextField
          size="small"
          placeholder="Another gate, by name"
          value={newGate}
          disabled={disabled}
          onChange={e => setNewGate(e.target.value.trim())}
          inputProps={{ 'aria-label': 'Gate name' }}
        />
        <Button
          size="small"
          disabled={disabled || !/^[A-Za-z0-9]+$/.test(newGate)}
          onClick={() => {
            set(newGate, 'on');
            setNewGate('');
          }}
        >
          Turn on
        </Button>
        <Typography variant="caption" color="text.secondary">
          For gates of a KubeVirt newer than this plugin&apos;s tables.
        </Typography>
      </Stack>
    </Panel>
  );
}

// ---------------------------------------------------------------- VM state

export interface VmStateSectionProps extends SectionProps {
  kv: KubeVirtLike | null;
  storageClasses: StorageClassLike[];
  profiles: StorageProfileLike[];
}

const HOW: Record<string, string> = {
  k4all: 'set by k4all',
  'kubevirt-cr': 'set in the KubeVirt CR (Hangar or an admin)',
  'virt-default': 'the default virtualization StorageClass',
  default: 'the default StorageClass',
  none: 'no default StorageClass',
};

export function VmStateSection(props: VmStateSectionProps) {
  const { draft, update, disabled } = props;
  const info = FIELDS.vmStateStorageClass;
  const value = draft.features?.virt?.kubevirt?.vmStateStorageClass ?? '';
  const names = props.storageClasses.map(s => s.metadata.name).sort();
  if (value && !names.includes(value)) {
    names.push(value);
  }
  const now = vmStateInfo(draft, props);
  const setValue = (v: string) => update(d => setPruned(d, info.path, v || undefined));
  return (
    <Panel id="vm-state" title="VM state" icon="mdi:chip">
      <SettingRow
        label={info.label}
        htmlFor="k4all-vm-state-class"
        help={info.help}
        badge={<ApplyBadge mode="live" />}
        changed={isChanged(props, info.path)}
        last
        control={
          <Select
            id="k4all-vm-state-class"
            size="small"
            value={value}
            displayEmpty
            disabled={disabled}
            onChange={e => setValue(String(e.target.value))}
            inputProps={{ 'aria-label': info.label }}
            sx={{ minWidth: 240 }}
          >
            <MenuItem value="">Not set by k4all</MenuItem>
            {names.map(n => (
              <MenuItem key={n} value={n}>
                {n}
              </MenuItem>
            ))}
          </Select>
        }
        messages={
          <Stack spacing={0.75}>
            <Typography variant="body2" color="text.secondary">
              {now.effective ? (
                <>
                  New VM state volumes go to <Mono>{now.effective}</Mono> ({HOW[now.how]}), as{' '}
                  {now.access === 'RWX' ? 'ReadWriteMany' : 'ReadWriteOnce'} Filesystem volumes.
                </>
              ) : (
                'There is no StorageClass for the VM state: VMs with persistent EFI or TPM state cannot start.'
              )}
            </Typography>
            <FieldMessages issues={props.issues} field="vmStateStorageClass" />
          </Stack>
        }
      />
    </Panel>
  );
}

// ------------------------------------------------------- Hangar node agent

export interface HangarSectionProps extends SectionProps {
  components: Record<string, ComponentSpec>;
  statuses?: Record<string, ComponentStatus>;
}

/** A Hangar component's state pill (hangar-node-agent, hangar-guest-bridge), when the release has it. */
function useHangarComponentState(props: HangarSectionProps, name: string) {
  const spec = props.components[name];
  return spec
    ? displayState(props.statuses?.[name], componentActivation(name, spec, props.draft))
    : null;
}

export function HangarSection(props: HangarSectionProps) {
  const { draft, base, update, disabled } = props;
  const info = FIELDS.hangarNodeAgent;
  const on = draft.features?.virt?.hangar?.nodeAgent !== false;
  const baseValue = base.features?.virt?.hangar?.nodeAgent;
  const state = useHangarComponentState(props, 'hangar-node-agent');
  const bridgeInfo = FIELDS.hangarGuestBridge;
  const bridgeOn = draft.features?.virt?.hangar?.guestBridge !== false;
  const bridgeBase = base.features?.virt?.hangar?.guestBridge;
  const bridgeState = useHangarComponentState(props, HANGAR_GUEST_BRIDGE);
  const bridgeFailure = hookFailure(props.statuses?.[HANGAR_GUEST_BRIDGE]);
  const bridgeDisabled = disabled || !props.caps.guestBridge;
  // Off is explicit; on goes back to the release default unless it was set to true.
  const setOn = (checked: boolean) =>
    update(d => setPruned(d, info.path, checked ? (baseValue === true ? true : undefined) : false));
  const setBridgeOn = (checked: boolean) =>
    update(d =>
      setPruned(d, bridgeInfo.path, checked ? (bridgeBase === true ? true : undefined) : false)
    );
  return (
    <Panel
      title="Hangar"
      icon="mdi:monitor-dashboard"
      action={
        <Button
          size="small"
          href={clusterURL(HANGAR_URL)}
          startIcon={<Icon icon="mdi:open-in-new" />}
        >
          Open Hangar
        </Button>
      }
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Hangar is the virtual machine console of this dashboard; k4all installs it with
        Virtualization.
      </Typography>
      <SettingRow
        label={info.label}
        htmlFor="k4all-hangar-node-agent"
        help={
          <>
            {info.help} Privileged (spc_t under SELinux), without API access: it only acts on the
            ConfigMap <Mono>hangar-passthrough</Mono> Hangar writes.
          </>
        }
        badge={<ApplyBadge mode="live" />}
        changed={isChanged(props, info.path)}
        control={
          <Stack direction="row" spacing={1} alignItems="center">
            {state && (
              <TonePill
                tone={state.tone}
                busy={state.busy}
                label={state.label}
                title={props.statuses?.['hangar-node-agent']?.message}
              />
            )}
            <Switch
              id="k4all-hangar-node-agent"
              checked={on}
              disabled={disabled}
              onChange={(_, checked) => setOn(checked)}
              inputProps={{ 'aria-label': info.label }}
            />
          </Stack>
        }
      />
      <SettingRow
        label={bridgeInfo.label}
        htmlFor="k4all-hangar-guest-bridge"
        help={
          <>
            {bridgeInfo.help} It runs as root with a read-only view of kubelet&apos;s pod
            directories (spc_t under SELinux) to reach each VM&apos;s guest agent. Who may read or
            change a guest&apos;s files is RBAC on the subresources (Hangar&apos;s{' '}
            <Mono>hangar-guest-admin</Mono> role).
          </>
        }
        badge={
          props.caps.guestBridge ? <ApplyBadge mode="live" /> : <CapabilityChip id="guestBridge" />
        }
        changed={isChanged(props, bridgeInfo.path)}
        last
        control={
          <Stack direction="row" spacing={1} alignItems="center">
            {bridgeState && (
              <TonePill
                tone={bridgeFailure ? 'warning' : bridgeState.tone}
                busy={bridgeState.busy}
                label={bridgeFailure ? 'Unavailable' : bridgeState.label}
                title={props.statuses?.[HANGAR_GUEST_BRIDGE]?.message}
              />
            )}
            <Switch
              id="k4all-hangar-guest-bridge"
              checked={bridgeOn}
              disabled={bridgeDisabled}
              onChange={(_, checked) => setBridgeOn(checked)}
              inputProps={{ 'aria-label': bridgeInfo.label }}
            />
          </Stack>
        }
        messages={
          bridgeFailure ? (
            <Alert severity="warning" sx={{ py: 0 }}>
              <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
                {bridgeFailure}
              </Box>
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                Meanwhile kubectl warns and namespace deletions may wait. Turning the bridge off
                removes its APIService first.
              </Typography>
            </Alert>
          ) : undefined
        }
      />
    </Panel>
  );
}

// -------------------------------------------------------- Metadata service

export function MetadataSection(props: SectionProps) {
  const { draft, update, disabled } = props;
  const md = draft.features?.virt?.metadata ?? {};
  const enabled = md.enabled === true;
  const baseEnabled = props.base.features?.virt?.metadata?.enabled;
  const sub = disabled || !enabled;
  const setMd = (key: string[], value: unknown) =>
    update(d => setPruned(d, ['features', 'virt', 'metadata', ...key], value));
  const audiences = md.tokens?.audiences ?? [];
  return (
    <Panel id="metadata" title="Metadata service" icon="mdi:cloud-outline">
      <Alert severity="info" icon={<Icon icon="mdi:information-outline" />} sx={{ mb: 1 }}>
        A server on <Mono>169.254.169.254</Mono> inside each VM&apos;s pod answers OpenStack and EC2
        metadata requests from the VM&apos;s own spec (SSH keys, user-data, hostname), and hands out
        workload-identity tokens. With <b>Labelled</b>, a VM opts in with the template label{' '}
        <Mono>{METADATA_OPT_IN_LABEL}: enabled</Mono>, and picks its ServiceAccount with{' '}
        <Mono>{METADATA_SERVICE_ACCOUNT_LABEL}: &lt;name&gt;</Mono>; Hangar&apos;s wizard sets both.
        The VM needs a masquerade (pod network) interface. In namespaces that enforce PodSecurity{' '}
        <Mono>baseline</Mono> or <Mono>restricted</Mono> it is not injected (it needs NET_ADMIN in
        the VM pod): those VMs keep a cloud-init disk.
      </Alert>
      <SettingRow
        label={FIELDS.metadataEnabled.label}
        htmlFor="k4all-metadata-enabled"
        help={FIELDS.metadataEnabled.help}
        badge={<ApplyBadge mode="live" />}
        changed={isChanged(props, FIELDS.metadataEnabled.path)}
        control={
          <Switch
            id="k4all-metadata-enabled"
            checked={enabled}
            disabled={disabled}
            // Off: leave it unset unless it was explicitly false.
            onChange={(_, checked) =>
              setMd(['enabled'], checked ? true : baseEnabled === false ? false : undefined)
            }
            inputProps={{ 'aria-label': FIELDS.metadataEnabled.label }}
          />
        }
      />
      <SettingRow
        label={FIELDS.metadataScope.label}
        htmlFor="k4all-metadata-scope"
        help={FIELDS.metadataScope.help}
        changed={isChanged(props, FIELDS.metadataScope.path)}
        control={
          <Select
            id="k4all-metadata-scope"
            size="small"
            value={md.scope === 'All' ? 'All' : 'Labelled'}
            disabled={sub}
            onChange={e => setMd(['scope'], e.target.value === 'All' ? 'All' : undefined)}
            inputProps={{ 'aria-label': FIELDS.metadataScope.label }}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="Labelled">Labelled VMs</MenuItem>
            <MenuItem value="All">All VMs</MenuItem>
          </Select>
        }
      />
      <SettingRow
        label="Token audiences"
        help={FIELDS.metadataAudiences.help}
        changed={isChanged(props, FIELDS.metadataAudiences.path)}
        control={
          <Autocomplete
            multiple
            freeSolo
            size="small"
            disabled={sub}
            options={[] as string[]}
            value={audiences}
            onChange={(_, value) => {
              const list = value.map(v => String(v).trim()).filter(Boolean);
              setMd(['tokens', 'audiences'], list.length ? list : undefined);
            }}
            renderTags={(value, getTagProps) =>
              value.map((option, index) => {
                const { key, ...tagProps } = getTagProps({ index });
                return <Chip key={key} size="small" label={option} {...tagProps} />;
              })
            }
            renderInput={params => (
              <TextField
                {...params}
                placeholder={audiences.length ? '' : "operator's default"}
                inputProps={{ ...params.inputProps, 'aria-label': 'Token audiences' }}
              />
            )}
            sx={{ width: 300 }}
          />
        }
        messages={<FieldMessages issues={props.issues} field="metadataAudiences" />}
      />
      <SettingRow
        label="Token lifetime"
        htmlFor="k4all-metadata-expiration"
        help={FIELDS.metadataExpiration.help}
        changed={isChanged(props, FIELDS.metadataExpiration.path)}
        control={
          <TextField
            id="k4all-metadata-expiration"
            size="small"
            type="number"
            disabled={sub}
            placeholder="operator's default"
            value={md.tokens?.expirationSeconds ?? ''}
            onChange={e => {
              const v = e.target.value.trim();
              setMd(['tokens', 'expirationSeconds'], v === '' ? undefined : Number(v));
            }}
            inputProps={{ 'aria-label': 'Token lifetime in seconds', min: 600, step: 60 }}
            InputProps={{ endAdornment: <Typography variant="caption">s</Typography> }}
            sx={{ width: 200 }}
          />
        }
        messages={<FieldMessages issues={props.issues} field="metadataExpiration" />}
      />
      <SettingRow
        label="Vendor-data ConfigMap"
        htmlFor="k4all-metadata-vendor-data"
        help={FIELDS.metadataVendorData.help}
        changed={isChanged(props, FIELDS.metadataVendorData.path)}
        last
        control={
          <TextField
            id="k4all-metadata-vendor-data"
            size="small"
            disabled={sub}
            placeholder="none"
            value={md.vendorDataConfigMap ?? ''}
            onChange={e => {
              const v = e.target.value.trim();
              setMd(['vendorDataConfigMap'], v === '' ? undefined : v);
            }}
            inputProps={{ 'aria-label': 'Vendor-data ConfigMap' }}
            sx={{ width: 240 }}
          />
        }
        messages={<FieldMessages issues={props.issues} field="metadataVendorData" />}
      />
    </Panel>
  );
}

/** A condition of the ClusterConfig about these settings, when it reports a problem. */
export function ConditionAlert(props: {
  condition?: { status: string; reason?: string; message?: string };
  title: string;
}) {
  const c = props.condition;
  if (!c || c.status === 'True' || !c.message) {
    return null;
  }
  return (
    <Alert severity={c.status === 'False' ? 'warning' : 'info'} sx={{ mb: 2 }}>
      <AlertTitle>
        {props.title}
        {c.reason ? `: ${c.reason}` : ''}
      </AlertTitle>
      <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
        {c.message}
      </Box>
    </Alert>
  );
}
