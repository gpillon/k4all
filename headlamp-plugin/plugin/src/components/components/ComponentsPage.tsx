import { Icon } from '@iconify/react';
import { Link, Table } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import React from 'react';
import { K4allData, useK4allData, usePermissions } from '../../api/hooks';
import { forceResync } from '../../api/k4allApi';
import { buildRows, ComponentRow, summarize } from '../../model/components';
import { classifyError } from '../../model/errors';
import { sameVersion } from '../../model/semver';
import { K4allGate } from '../common/states';
import { Mono, PageHeader, TonePill } from '../common/ui';
import { ManagementChip } from './ManagementChip';

type Filter = 'all' | 'attention' | 'active' | 'off';

const FILTERS: Record<Filter, (r: ComponentRow) => boolean> = {
  all: () => true,
  attention: r =>
    r.state.tone === 'error' || r.state.busy || !!r.upgrade || r.management === 'Unmanaged',
  active: r => r.activation.active,
  off: r => !r.activation.active,
};

export function VersionCell({ row }: { row: ComponentRow }) {
  const installed = row.installedVersion;
  const desired = row.spec.version;
  if (!installed || sameVersion(installed, desired)) {
    return (
      <Typography sx={{ fontFamily: 'monospace', fontSize: '0.875rem' }}>
        {installed ?? desired}
      </Typography>
    );
  }
  return (
    <Tooltip
      title={
        row.upgrade && row.upgrade.remaining.length > 1
          ? `Upgrade path: ${row.upgrade.remaining.join(' → ')}`
          : ''
      }
    >
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
      >
        <span>{installed}</span>
        <Icon icon="mdi:arrow-right" width={14} height={14} />
        <Box component="span" sx={{ fontWeight: 600 }}>
          {desired}
        </Box>
      </Stack>
    </Tooltip>
  );
}

export function ComponentsPage() {
  const data = useK4allData();
  return (
    <Box sx={{ p: { xs: 1, md: 3 } }}>
      <K4allGate data={data} needReleaseManifest>
        {data.rm && data.cc && <ComponentsContent data={data} />}
      </K4allGate>
    </Box>
  );
}

function ComponentsContent({ data }: { data: K4allData }) {
  const rm = data.rm!;
  const rows = React.useMemo(() => buildRows(rm, data.cc?.spec ?? {}), [rm, data.cc]);
  const summary = summarize(rows);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [confirmAll, setConfirmAll] = React.useState(false);
  const perms = usePermissions();
  const { enqueueSnackbar } = useSnackbar();

  const resyncAll = async () => {
    setConfirmAll(false);
    try {
      await forceResync(rm, 'all');
      enqueueSnackbar('k4all-operator will re-apply every installed component.', {
        variant: 'success',
      });
    } catch (err) {
      const e = classifyError(err);
      enqueueSnackbar(`${e.hint} ${e.message}`, { variant: 'error' });
    }
  };

  return (
    <>
      <PageHeader
        icon="mdi:package-variant-closed"
        title="Components"
        subtitle={
          <>
            ReleaseManifest <Mono>{rm.metadata.name}</Mono> · {summary.installed} of{' '}
            {summary.active} active components installed
          </>
        }
        actions={
          <Tooltip
            title={
              perms.patchReleaseManifest
                ? 'Ask the operator to apply every installed component again'
                : 'Needs patch on releasemanifests'
            }
          >
            <span>
              <Button
                variant="outlined"
                startIcon={<Icon icon="mdi:sync" />}
                disabled={!perms.patchReleaseManifest}
                onClick={() => setConfirmAll(true)}
              >
                Re-apply all
              </Button>
            </span>
          </Tooltip>
        }
      />

      <ToggleButtonGroup
        size="small"
        exclusive
        value={filter}
        onChange={(_, v) => v && setFilter(v)}
        aria-label="Filter components"
        sx={{ mb: 2 }}
      >
        <ToggleButton value="all">All {rows.length}</ToggleButton>
        <ToggleButton value="attention">
          Needs attention {rows.filter(FILTERS.attention).length}
        </ToggleButton>
        <ToggleButton value="active">Active {summary.active}</ToggleButton>
        <ToggleButton value="off">Off {rows.length - summary.active}</ToggleButton>
      </ToggleButtonGroup>

      <Table<ComponentRow>
        data={rows.filter(FILTERS[filter])}
        emptyMessage="No component matches this filter."
        enableRowSelection={false}
        initialState={{ sorting: [{ id: 'category', desc: false }] }}
        columns={[
          {
            id: 'name',
            header: 'Component',
            accessorFn: r => r.name,
            gridTemplate: 'minmax(180px, 1.4fr)',
            Cell: ({ row }) => (
              <Stack direction="row" spacing={1} alignItems="center">
                <Link routeName="k4all-component" params={{ name: row.original.name }}>
                  {row.original.name}
                </Link>
                {row.original.hasOverride && (
                  <Tooltip title="Has componentOverrides in the ClusterConfig">
                    <Box component="span" sx={{ display: 'inline-flex', color: 'primary.main' }}>
                      <Icon icon="mdi:tune-vertical" width={16} height={16} />
                    </Box>
                  </Tooltip>
                )}
                {row.original.resyncPending && (
                  <Tooltip title="Re-apply requested">
                    <Box component="span" sx={{ display: 'inline-flex', color: 'info.main' }}>
                      <Icon icon="mdi:sync" width={16} height={16} />
                    </Box>
                  </Tooltip>
                )}
              </Stack>
            ),
          },
          {
            id: 'category',
            header: 'Category',
            accessorFn: r => r.category,
            gridTemplate: 'min-content',
          },
          {
            id: 'state',
            header: 'State',
            accessorFn: r => r.state.label,
            gridTemplate: 'min-content',
            Cell: ({ row }) => (
              <TonePill
                tone={row.original.state.tone}
                busy={row.original.state.busy}
                label={row.original.state.label}
                title={row.original.status?.message || row.original.activation.reason}
              />
            ),
          },
          {
            id: 'version',
            header: 'Version',
            accessorFn: r => r.installedVersion ?? r.spec.version,
            gridTemplate: 'minmax(140px, 1fr)',
            Cell: ({ row }) => <VersionCell row={row.original} />,
          },
          {
            id: 'management',
            header: 'Management',
            accessorFn: r => r.management,
            gridTemplate: 'min-content',
            Cell: ({ row }) => <ManagementChip management={row.original.management} />,
          },
          {
            id: 'note',
            header: 'Notes',
            accessorFn: r => r.activation.reason ?? r.status?.message ?? '',
            gridTemplate: 'minmax(200px, 2fr)',
            Cell: ({ row }) => (
              <Typography
                variant="body2"
                color={row.original.state.tone === 'error' ? 'error' : 'text.secondary'}
                noWrap
                title={row.original.status?.message || row.original.activation.reason}
              >
                {row.original.state.tone === 'error'
                  ? row.original.status?.message
                  : row.original.activation.reason ?? row.original.status?.message}
              </Typography>
            ),
          },
        ]}
      />

      <Dialog open={confirmAll} onClose={() => setConfirmAll(false)}>
        <DialogTitle>Re-apply every component?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            k4all-operator sets every installed, managed component back to Pending and applies it
            again (helm upgrade, manifests re-applied). Workloads are not deleted, but some restart.
            It takes a few minutes.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmAll(false)}>Cancel</Button>
          <Button variant="contained" onClick={resyncAll}>
            Re-apply all
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
