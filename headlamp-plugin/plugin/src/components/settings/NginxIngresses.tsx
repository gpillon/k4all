/*
 * "Ingresses still on the nginx class" (k4all v2.6.0+, Traefik releases):
 * the Ingresses Traefik still serves through its ingress-nginx provider,
 * each with a "Switch to traefik" that applies planMoveToTraefik after a
 * review and a dry run. Applied at once, not part of the settings draft.
 */

import { Icon } from '@iconify/react';
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { Link } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import React from 'react';
import { annotateService, patchIngress } from '../../api/k4allApi';
import { classifyError } from '../../model/errors';
import {
  ingressHosts,
  IngressLike,
  MovePlan,
  nginxClassIngresses,
  planMoveToTraefik,
  TRAEFIK_SERVERS_SCHEME_ANNOTATION,
} from '../../model/ingressMigration';
import { Mono, Panel } from '../common/ui';

const keyOf = (ing: IngressLike) => `${ing.metadata.namespace ?? ''}/${ing.metadata.name}`;

/**
 * Applies a move: everything as a dry run first, so nothing is half done
 * when the API server refuses a part; then the Services (so the backend
 * scheme is in place), then the Ingress.
 */
export async function moveToTraefik(ing: IngressLike, plan: MovePlan): Promise<void> {
  const ns = ing.metadata.namespace ?? 'default';
  const writes = (dryRun: boolean) => [
    ...plan.httpsServices.map(
      svc => () => annotateService(ns, svc, TRAEFIK_SERVERS_SCHEME_ANNOTATION, 'https', dryRun)
    ),
    () => patchIngress(ns, ing.metadata.name, plan.ops, dryRun),
  ];
  for (const write of writes(true)) {
    await write();
  }
  for (const write of writes(false)) {
    await write();
  }
}

function MoveDialog(props: {
  ingress: IngressLike | null;
  onClose: () => void;
  onMoved: (ing: IngressLike) => void;
}) {
  const { ingress } = props;
  const plan = React.useMemo(() => (ingress ? planMoveToTraefik(ingress) : null), [ingress]);
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { enqueueSnackbar } = useSnackbar();

  React.useEffect(() => {
    setAck(false);
    setError(null);
  }, [ingress]);

  if (!ingress || !plan) {
    return null;
  }
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await moveToTraefik(ingress, plan);
      enqueueSnackbar(`${keyOf(ingress)} now uses the traefik class.`, { variant: 'success' });
      props.onMoved(ingress);
    } catch (err) {
      const e = classifyError(err);
      setError(`${e.hint} ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : props.onClose} maxWidth="md" fullWidth>
      <DialogTitle>Switch {keyOf(ingress)} to traefik</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Box>
            <Typography variant="overline" color="text.secondary">
              Changes
            </Typography>
            <Stack spacing={0.75}>
              <Typography variant="body2">
                <Mono>spec.ingressClassName</Mono>: nginx → <b>traefik</b>
              </Typography>
              {plan.converted.map(c => (
                <Typography key={c.annotation} variant="body2">
                  <Mono>
                    {c.annotation}: {c.value}
                  </Mono>{' '}
                  → {c.becomes}
                </Typography>
              ))}
            </Stack>
          </Box>
          {plan.kept.length > 0 && (
            <Alert severity="warning">
              <AlertTitle>
                {plan.kept.length} nginx annotation{plan.kept.length === 1 ? '' : 's'} cannot be
                converted
              </AlertTitle>
              They stay on the Ingress but have no effect with the traefik class. Check that the
              routes do not depend on them, or express them as Traefik middlewares.
              <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
                {plan.kept.map(k => (
                  <li key={k.annotation}>
                    <Mono>
                      {k.annotation}: {k.value}
                    </Mono>
                  </li>
                ))}
              </Box>
            </Alert>
          )}
          {plan.managedBy.length > 0 && (
            <Alert severity="warning">
              <AlertTitle>
                Managed by {plan.managedBy.map(m => m.tool).join(' and ')}:{' '}
                {plan.managedBy.map(m => m.detail).join('; ')}
              </AlertTitle>
              Change the ingress class where this Ingress comes from (the chart values or the Git
              repository). A change made here is undone at the next{' '}
              {plan.managedBy.some(m => m.tool === 'Argo CD') ? 'sync' : 'helm upgrade'}.
            </Alert>
          )}
          {plan.notes.map(n => (
            <Alert key={n} severity="info">
              {n}
            </Alert>
          ))}
          {error && <Alert severity="error">{error}</Alert>}
          {plan.needsConfirmation && (
            <FormControlLabel
              control={<Checkbox checked={ack} onChange={e => setAck(e.target.checked)} />}
              label="I understand the warnings above and want to switch this Ingress now."
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={apply}
          disabled={busy || (plan.needsConfirmation && !ack)}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Switch to traefik
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** The list and its dialog, from Ingresses passed in (testable without Headlamp). */
export function NginxIngressesView(props: {
  items: IngressLike[] | null;
  canPatch: boolean;
  error?: string | null;
}) {
  const [moved, setMoved] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<IngressLike | null>(null);
  const rows = nginxClassIngresses(props.items ?? []).filter(i => !moved.has(keyOf(i)));

  return (
    <Panel title="Ingresses still on the nginx class" icon="mdi:swap-horizontal">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Traefik serves them through its ingress-nginx provider, with the nginx annotations it
        understands. Switching one to the traefik class converts the redirect and backend-protocol
        annotations and applies at once. Ingresses that Argo CD or Helm manage must be changed at
        the source (chart values, Git), or the next sync puts the nginx class back.
      </Typography>
      {props.error ? (
        <Alert severity="error">{props.error}</Alert>
      ) : props.items === null ? (
        <CircularProgress size={20} />
      ) : rows.length === 0 ? (
        <Stack direction="row" spacing={1} alignItems="center">
          <Icon icon="mdi:check-circle-outline" width={20} height={20} />
          <Typography variant="body2">No Ingress uses the nginx class.</Typography>
        </Stack>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Ingresses on the nginx class">
            <TableHead>
              <TableRow>
                <TableCell>Ingress</TableCell>
                <TableCell>Hosts</TableCell>
                <TableCell>Annotations</TableCell>
                <TableCell>Managed by</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(ing => {
                const plan = planMoveToTraefik(ing);
                return (
                  <TableRow key={keyOf(ing)}>
                    <TableCell>
                      <Link
                        routeName="ingress"
                        params={{
                          namespace: ing.metadata.namespace ?? '',
                          name: ing.metadata.name,
                        }}
                      >
                        {keyOf(ing)}
                      </Link>
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>
                      {ingressHosts(ing).join(', ') || '*'}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {plan.converted.length > 0 && (
                          <Chip size="small" label={`${plan.converted.length} converted`} />
                        )}
                        {plan.kept.length > 0 && (
                          <Tooltip title={plan.kept.map(k => k.annotation).join(', ')}>
                            <Chip
                              size="small"
                              color="warning"
                              variant="outlined"
                              label={`${plan.kept.length} not convertible`}
                            />
                          </Tooltip>
                        )}
                        {plan.converted.length === 0 && plan.kept.length === 0 && (
                          <Typography variant="body2" color="text.secondary">
                            none
                          </Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {plan.managedBy.length > 0 ? (
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {plan.managedBy.map(m => (
                            <Tooltip key={m.tool} title={m.detail}>
                              <Chip size="small" color="warning" label={m.tool} />
                            </Tooltip>
                          ))}
                        </Stack>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title={props.canPatch ? '' : 'Needs patch on ingresses'}>
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={!props.canPatch}
                            onClick={() => setSelected(ing)}
                            aria-label={`Switch ${keyOf(ing)} to traefik`}
                          >
                            Switch to traefik
                          </Button>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      )}
      <MoveDialog
        ingress={selected}
        onClose={() => setSelected(null)}
        onMoved={ing => {
          setMoved(prev => new Set(prev).add(keyOf(ing)));
          setSelected(null);
        }}
      />
    </Panel>
  );
}

/** The Ingresses of the cluster, watched by Headlamp. */
export function useIngresses(): { items: IngressLike[] | null; error: string | null } {
  const [list, error] = K8s.ResourceClasses.Ingress.useList();
  return {
    items: list ? list.map(i => i.jsonData as unknown as IngressLike) : null,
    error: error ? classifyError(error).hint : null,
  };
}

export function NginxIngressesPanel() {
  const { items, error } = useIngresses();
  const [canPatch, setCanPatch] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    K8s.ResourceClasses.Ingress.getAuthorization('patch')
      .then((r: any) => r?.status?.allowed === true)
      .catch(() => false)
      .then((ok: boolean) => {
        if (!cancelled) {
          setCanPatch(ok);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return <NginxIngressesView items={items} canPatch={canPatch} error={error} />;
}
