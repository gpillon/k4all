/*
 * The sections of /k4all/settings/storage (k4all v2.7.0): the Ceph cluster
 * (creation inputs, or the cluster k4all created and the way to Cairn), the
 * disks Ceph would take, and turning Rook off (D24: k4all never wipes disks).
 */

import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  Button,
  Chip,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import type { AgentInventories } from '../../api/clusterObjects';
import { FIELDS } from '../../model/fields';
import { setPruned } from '../../model/objects';
import { diskCandidates, rookDefaults, RookView } from '../../model/storage';
import { CephClusterLike } from '../../model/types';
import { CAIRN_OSDS_URL, CAIRN_POOLS_URL, CAIRN_URL, clusterURL } from '../common/nav';
import { ApplyBadge, Mono, Panel, SettingRow, TonePill } from '../common/ui';
import { FieldMessages, isChanged, SectionProps } from '../settings/common';

const GiB = 2 ** 30;
function fmtSize(bytes: number | null): string {
  if (bytes === null) {
    return '';
  }
  return bytes >= 1024 * GiB
    ? `${Math.round((bytes / (1024 * GiB)) * 10) / 10} TiB`
    : `${Math.round(bytes / GiB)} GiB`;
}

/** The disks Rook would take per node, from Hangar's node agent; unknown without it. */
export function DiskPreview(props: { inventories: AgentInventories | null; filter?: string }) {
  const inv = props.inventories;
  if (!inv) {
    return (
      <Typography variant="body2" color="text.secondary">
        Reading the disks of the nodes…
      </Typography>
    );
  }
  if (inv.denied || inv.missing) {
    return (
      <Typography variant="body2" color="text.secondary">
        Which disks Ceph would take: unknown.{' '}
        {inv.denied
          ? "Your user cannot read the host inventory of Hangar's node agent."
          : "Hangar's node agent (Virtualization) reports the disks of each node; it is not running."}
      </Typography>
    );
  }
  return (
    <Table size="small" aria-label="Disks per node">
      <TableHead>
        <TableRow>
          <TableCell>Node</TableCell>
          <TableCell>Disk</TableCell>
          <TableCell>Size</TableCell>
          <TableCell>For Ceph</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {inv.nodes.flatMap(n =>
          n.disks === null
            ? [
                <TableRow key={n.node}>
                  <TableCell>{n.node}</TableCell>
                  <TableCell colSpan={3}>
                    <Typography variant="body2" color="text.secondary">
                      unknown ({n.error})
                    </Typography>
                  </TableCell>
                </TableRow>,
              ]
            : diskCandidates(n.disks, props.filter).map(d => (
                <TableRow key={`${n.node}/${d.name}`}>
                  <TableCell>{n.node}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{d.name}</TableCell>
                  <TableCell>{fmtSize(d.sizeBytes)}</TableCell>
                  <TableCell>
                    {d.osd ? (
                      <TonePill tone="success" label="becomes an OSD" />
                    ) : !d.matches ? (
                      <TonePill tone="neutral" label="not matched by the filter" />
                    ) : (
                      <TonePill
                        tone="neutral"
                        label="in use: skipped"
                        title={[...d.partitions, ...d.signatures, ...d.holders, ...d.mounts].join(
                          ', '
                        )}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))
        )}
      </TableBody>
    </Table>
  );
}

function CephClustersList(props: { clusters: CephClusterLike[] }) {
  return (
    <Stack spacing={0.75}>
      {props.clusters.map(c => (
        <Stack
          key={`${c.metadata.namespace}/${c.metadata.name}`}
          direction="row"
          spacing={1}
          alignItems="center"
        >
          <Mono>
            {c.metadata.namespace}/{c.metadata.name}
          </Mono>
          {c.status?.phase && <Chip size="small" variant="outlined" label={c.status.phase} />}
          {c.status?.ceph?.health && (
            <TonePill
              tone={
                c.status.ceph.health === 'HEALTH_OK'
                  ? 'success'
                  : c.status.ceph.health === 'HEALTH_WARN'
                  ? 'warning'
                  : 'error'
              }
              label={c.status.ceph.health}
            />
          )}
        </Stack>
      ))}
    </Stack>
  );
}

export interface CephSectionProps extends SectionProps {
  view: RookView;
  clusters: CephClusterLike[];
  nodes: number;
  inventories: AgentInventories | null;
}

/** The creation inputs, or the cluster k4all created, with the way to Cairn. */
export function CephSection(props: CephSectionProps) {
  const { draft, update, disabled, view } = props;
  const filter = draft.features?.rook?.storage?.deviceFilter ?? '';
  const policy = draft.features?.rook?.smallCluster === 'Allow' ? 'Allow' : 'Refuse';
  const d = rookDefaults(props.nodes);
  if (view.created) {
    return (
      <Panel
        title="Ceph cluster"
        icon="mdi:database-check-outline"
        action={
          <Button
            size="small"
            href={clusterURL(CAIRN_URL)}
            startIcon={<Icon icon="mdi:open-in-new" />}
          >
            Open Cairn
          </Button>
        }
      >
        <Alert severity="success" icon={<Icon icon="mdi:check-circle-outline" />} sx={{ mb: 1.5 }}>
          <AlertTitle>Created: manage it in Cairn</AlertTitle>
          k4all created the CephCluster, the pool <Mono>vm-pool</Mono> and the StorageClass{' '}
          <Mono>ceph-rbd</Mono> once; from now on they are Cairn&apos;s: disks and OSDs, mon and mgr
          counts, pools. k4all only keeps the Ceph image in step with the Rook release it pins.{' '}
          <a href={clusterURL(CAIRN_OSDS_URL)}>Hosts and OSDs</a> ·{' '}
          <a href={clusterURL(CAIRN_POOLS_URL)}>Pools</a>
        </Alert>
        <CephClustersList clusters={props.clusters} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          Creation inputs, read when the cluster was created and doing nothing now: disks{' '}
          <Mono>{filter || 'every blank disk'}</Mono>, below 3 nodes <Mono>{policy}</Mono>.
        </Typography>
      </Panel>
    );
  }
  return (
    <Panel title="Ceph cluster k4all creates" icon="mdi:database-plus-outline">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Read once, when k4all creates the cluster; after that Cairn manages it. For {props.nodes}{' '}
        node{props.nodes === 1 ? '' : 's'}: {d.mons} mon{d.mons === 1 ? '' : 's'}, {d.mgrs} mgr
        {d.mgrs === 1 ? '' : 's'}, pool <Mono>vm-pool</Mono> of size {d.poolSize}, StorageClass{' '}
        <Mono>ceph-rbd</Mono> (ReadWriteMany block, for live migration).
      </Typography>
      <SettingRow
        label={FIELDS.rookDeviceFilter.label}
        htmlFor="k4all-rook-device-filter"
        help={FIELDS.rookDeviceFilter.help}
        badge={<ApplyBadge mode="live" />}
        changed={isChanged(props, FIELDS.rookDeviceFilter.path)}
        control={
          <TextField
            id="k4all-rook-device-filter"
            size="small"
            placeholder="every blank disk"
            value={filter}
            disabled={disabled}
            onChange={e => {
              const next = e.target.value || undefined;
              update(dr => setPruned(dr, FIELDS.rookDeviceFilter.path, next));
            }}
            inputProps={{ 'aria-label': FIELDS.rookDeviceFilter.label }}
            sx={{ width: 240, '& input': { fontFamily: 'monospace' } }}
          />
        }
        messages={
          <Stack spacing={1}>
            <FieldMessages issues={props.issues} field="rookDeviceFilter" />
            <DiskPreview inventories={props.inventories} filter={filter || undefined} />
          </Stack>
        }
      />
      <SettingRow
        label={FIELDS.rookSmallCluster.label}
        htmlFor="k4all-rook-small"
        help={FIELDS.rookSmallCluster.help}
        changed={isChanged(props, FIELDS.rookSmallCluster.path)}
        last
        control={
          <Select
            id="k4all-rook-small"
            size="small"
            value={policy}
            disabled={disabled}
            onChange={e => {
              const next = e.target.value === 'Allow' ? 'Allow' : undefined;
              update(dr => setPruned(dr, FIELDS.rookSmallCluster.path, next));
            }}
            inputProps={{ 'aria-label': FIELDS.rookSmallCluster.label }}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="Refuse">Refuse (create nothing)</MenuItem>
            <MenuItem value="Allow">Allow, without redundancy</MenuItem>
          </Select>
        }
        messages={
          <Stack spacing={1}>
            {view.small && (
              <Alert severity={view.small.policy === 'Allow' ? 'warning' : 'info'}>
                {view.small.text}
              </Alert>
            )}
            <FieldMessages issues={props.issues} field="rookSmallCluster" />
          </Stack>
        }
      />
    </Panel>
  );
}

/** Turning Rook off: refused while a CephCluster exists; the steps; disks are never wiped (D24). */
export function TeardownPanel(props: { view: RookView }) {
  const { view } = props;
  return (
    <Panel title="Turning Rook off" icon="mdi:database-remove-outline">
      {view.offRefused && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          <AlertTitle>k4all-operator keeps Rook installed while a CephCluster exists</AlertTitle>
          {view.notices
            .filter(n => n.kind === 'refused')
            .map(n => (
              <div key={n.name}>
                <Mono>{n.name}</Mono>: {n.text}
              </div>
            ))}
        </Alert>
      )}
      {view.created ? (
        <Stack component="ol" spacing={0.75} sx={{ m: 0, pl: 2.5 }}>
          {view.offSteps.map(s => (
            <li key={s}>
              <Typography variant="body2">{s}</Typography>
            </li>
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Without a CephCluster, turning Rook off uninstalls the Rook operator, the CSI driver and
          Cairn at once.
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
        k4all never wipes disks. Before turning Rook on again on the same nodes, wipe{' '}
        <Mono>/var/lib/rook</Mono> on every node and the disks the OSDs used (for example{' '}
        <Mono>sgdisk --zap-all /dev/sdX</Mono> and <Mono>wipefs -a /dev/sdX</Mono>): Rook does not
        reuse a disk with Ceph data on it.
      </Typography>
    </Panel>
  );
}
