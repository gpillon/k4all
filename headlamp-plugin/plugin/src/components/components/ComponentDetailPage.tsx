import { Icon } from '@iconify/react';
import { Router, Utils } from '@kinvolk/headlamp-plugin/lib';
import { Link } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Grid,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import React from 'react';
import { useHistory, useParams } from 'react-router-dom';
import { K4allData, useK4allData, usePermissions } from '../../api/hooks';
import { forceResync } from '../../api/k4allApi';
import { acceptsValues, buildRows, ComponentRow } from '../../model/components';
import { editorReducer, initialEditorState } from '../../model/editor';
import { classifyError } from '../../model/errors';
import { toYaml } from '../../model/textDiff';
import { ReleaseManifestObject } from '../../model/types';
import { K4allGate } from '../common/states';
import { Mono, PageHeader, Panel, TonePill } from '../common/ui';
import { ReviewDialog } from '../review/ReviewDialog';
import { useSaveFlow } from '../review/useSaveFlow';
import { ManagementChip } from './ManagementChip';
import { ManagementDialog } from './ManagementDialog';
import { OverridesEditor } from './OverridesEditor';

export function ComponentDetailPage() {
  const { name } = useParams<{ name: string }>();
  const data = useK4allData();
  return (
    <Box sx={{ p: { xs: 1, md: 3 }, pb: 6 }}>
      <K4allGate data={data} needReleaseManifest>
        {/* keyed: Headlamp keeps the route mounted when only :name changes */}
        {data.rm && data.cc && <ComponentDetail key={name} name={name} data={data} />}
      </K4allGate>
    </Box>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 0.75 }} justifyContent="space-between">
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        {props.label}
      </Typography>
      <Box sx={{ textAlign: 'right', minWidth: 0, wordBreak: 'break-all' }}>{props.children}</Box>
    </Stack>
  );
}

function DepLinks(props: { names: string[] }) {
  if (props.names.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        none
      </Typography>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap justifyContent="flex-end">
      {props.names.map(n => (
        <Chip
          key={n}
          size="small"
          variant="outlined"
          label={
            <Link routeName="k4all-component" params={{ name: n }}>
              {n}
            </Link>
          }
        />
      ))}
    </Stack>
  );
}

function UpgradePath({ row }: { row: ComponentRow }) {
  if (!row.upgrade) {
    return null;
  }
  const steps = [row.installedVersion ?? '', ...row.upgrade.remaining];
  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="overline" color="text.secondary">
        Upgrade path, one step per reconcile
      </Typography>
      <Stepper activeStep={1} alternativeLabel sx={{ mt: 1 }}>
        {steps.map((v, i) => (
          <Step key={`${v}-${i}`} completed={i === 0}>
            <StepLabel
              optional={
                i === 0 ? (
                  <Typography variant="caption">installed</Typography>
                ) : i === 1 ? (
                  <Typography variant="caption">next</Typography>
                ) : i === steps.length - 1 ? (
                  <Typography variant="caption">target</Typography>
                ) : undefined
              }
            >
              <Mono>{v}</Mono>
            </StepLabel>
          </Step>
        ))}
      </Stepper>
    </Box>
  );
}

function ComponentDetail({ name, data }: { name: string; data: K4allData }) {
  const rm = data.rm as ReleaseManifestObject;
  const cc = data.cc!;
  const rows = React.useMemo(() => buildRows(rm, cc.spec ?? {}), [rm, cc]);
  const row = rows.find(r => r.name === name);
  const perms = usePermissions();
  const history = useHistory();
  const { enqueueSnackbar } = useSnackbar();
  const [managementOpen, setManagementOpen] = React.useState(false);

  const [state, dispatch] = React.useReducer(editorReducer, initialEditorState);
  React.useEffect(() => {
    dispatch({ type: 'server', object: cc });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cc.metadata.resourceVersion]);
  const flow = useSaveFlow(state, dispatch, rm.spec?.components ?? {});

  if (!row) {
    return (
      <Alert severity="warning">
        <AlertTitle>No component named {name}</AlertTitle>
        The ReleaseManifest <Mono>{rm.metadata.name}</Mono> does not list it.{' '}
        <Link routeName="k4all-components">All components</Link>
      </Alert>
    );
  }

  const { spec, status } = row;
  const resync = async () => {
    try {
      await forceResync(rm, row.name);
      enqueueSnackbar(`k4all-operator will apply ${row.name} again.`, { variant: 'success' });
    } catch (err) {
      const e = classifyError(err);
      enqueueSnackbar(`${e.hint} ${e.message}`, { variant: 'error' });
    }
  };
  const canResync =
    perms.patchReleaseManifest && row.status?.state === 'Installed' && row.management === 'Managed';

  return (
    <>
      <PageHeader
        icon="mdi:package-variant"
        title={row.name}
        subtitle={
          <>
            {row.category} · {spec.type} component of ReleaseManifest{' '}
            <Mono>{rm.metadata.name}</Mono>
          </>
        }
        actions={
          <>
            <TonePill tone={row.state.tone} busy={row.state.busy} label={row.state.label} />
            <ManagementChip management={row.management} />
            <Tooltip
              title={
                canResync
                  ? 'Apply this component again (force-resync)'
                  : 'Only installed, managed components can be re-applied'
              }
            >
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<Icon icon="mdi:sync" />}
                  disabled={!canResync || row.resyncPending}
                  onClick={resync}
                >
                  {row.resyncPending ? 'Re-apply requested' : 'Re-apply'}
                </Button>
              </span>
            </Tooltip>
            <Button
              size="small"
              variant="outlined"
              startIcon={<Icon icon="mdi:cog-outline" />}
              disabled={!perms.patchReleaseManifest}
              onClick={() => setManagementOpen(true)}
            >
              Management
            </Button>
          </>
        }
      />

      <Stack spacing={1.5} sx={{ mb: 2 }}>
        {row.state.tone === 'error' && status?.message && (
          <Alert severity="error">
            <AlertTitle>The last reconcile failed</AlertTitle>
            <Box
              component="pre"
              sx={{ m: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.8rem' }}
            >
              {status.message}
            </Box>
          </Alert>
        )}
        {!row.activation.active && row.management === 'Managed' && (
          <Alert
            severity="info"
            action={
              row.activation.feature && (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() =>
                    history.push(`${Router.createRouteURL('k4all-settings')}?tab=features`)
                  }
                >
                  Open features
                </Button>
              )
            }
          >
            {row.activation.reason}
          </Alert>
        )}
        {row.management === 'Unmanaged' && (
          <Alert severity="warning">
            k4all-operator does not install, upgrade or remove this component, and k4all releases
            keep it Unmanaged on upgrade. Set it back to Managed to receive the release version
            again.
          </Alert>
        )}
        {row.management === 'Removed' && (
          <Alert severity="warning">
            k4all-operator uninstalls this component. A future k4all release can set it back to
            Managed: the release sync only keeps Unmanaged choices.
          </Alert>
        )}
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={12} lg={6}>
          <Panel title="Version" icon="mdi:tag-outline">
            <Field label="Release version">
              <Mono>{spec.version}</Mono>
            </Field>
            <Field label="Installed">
              {row.installedVersion ? <Mono>{row.installedVersion}</Mono> : 'not installed'}
            </Field>
            {status?.lastTransitionTime && (
              <Field label="Last change">{Utils.timeAgo(status.lastTransitionTime)} ago</Field>
            )}
            {status?.message && row.state.tone !== 'error' && (
              <Field label="Operator message">{status.message}</Field>
            )}
            <UpgradePath row={row} />
          </Panel>
        </Grid>
        <Grid item xs={12} lg={6}>
          <Panel title="Source" icon="mdi:source-repository">
            {spec.repo && (
              <Field label={spec.type === 'helm-oci' ? 'OCI chart' : 'Helm repository'}>
                <Mono>{spec.repo}</Mono>
              </Field>
            )}
            {spec.chart && (
              <Field label="Chart">
                <Mono>{spec.chart}</Mono>
              </Field>
            )}
            {spec.source && (
              <Field label="Source">
                <Mono>{spec.source}</Mono>
              </Field>
            )}
            {(spec.sources ?? []).map((s, i) => (
              <Field key={s} label={i === 0 ? 'Sources' : ''}>
                <Mono>{s}</Mono>
              </Field>
            ))}
            {spec.image && (
              <Field label="Image">
                <Mono>{spec.image}</Mono>
              </Field>
            )}
            {spec.namespace && (
              <Field label="Namespace">
                <Link routeName="namespace" params={{ name: spec.namespace }}>
                  {spec.namespace}
                </Link>
              </Field>
            )}
            {spec.featureGate && (
              <Field label="Feature gate">
                <Mono>{spec.featureGate}</Mono>
              </Field>
            )}
            <Field label="Depends on">
              <DepLinks names={row.dependsOn} />
            </Field>
            <Field label="Required by">
              <DepLinks names={row.requiredBy} />
            </Field>
          </Panel>
        </Grid>

        {acceptsValues(spec) && (
          <Grid item xs={12}>
            <OverridesEditor
              component={row.name}
              componentType={String(spec.type)}
              state={state}
              dispatch={dispatch}
              flow={flow}
              disabled={!perms.patchClusterConfig}
            />
          </Grid>
        )}

        {Boolean(
          spec.values ||
            spec.helmArgs?.length ||
            spec.patches?.length ||
            spec.inlineManifests?.length
        ) && (
          <Grid item xs={12}>
            <Accordion disableGutters variant="outlined">
              <AccordionSummary expandIcon={<Icon icon="mdi:chevron-down" />}>
                <Typography sx={{ fontWeight: 600 }}>Release definition (read-only)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  As shipped by the k4all release. A release sync replaces any edit made here
                  directly: use the overrides above, which live in the ClusterConfig.
                </Typography>
                <Box
                  component="pre"
                  sx={{ m: 0, fontSize: '0.8rem', overflow: 'auto', maxHeight: 420 }}
                >
                  {toYaml({
                    values: spec.values,
                    helmArgs: spec.helmArgs,
                    upgradePath: spec.upgradePath,
                    patches: spec.patches,
                    inlineManifests: spec.inlineManifests,
                  })}
                </Box>
              </AccordionDetails>
            </Accordion>
          </Grid>
        )}
      </Grid>

      <ManagementDialog
        open={managementOpen}
        onClose={() => setManagementOpen(false)}
        rm={rm}
        row={row}
        config={cc.spec ?? {}}
      />
      <ReviewDialog flow={flow} title={`Apply overrides of ${row.name}`} />
    </>
  );
}
