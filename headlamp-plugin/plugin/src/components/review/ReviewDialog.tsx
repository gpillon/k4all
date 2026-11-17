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
  Typography,
  useTheme,
} from '@mui/material';
import React from 'react';
import { ChangeItem, ChangeSeverity, formatValue, needsAcknowledgement } from '../../model/changes';
import { Issue } from '../../model/validation';
import { Mono } from '../common/ui';
import { SaveFlow } from './useSaveFlow';
import { YamlDiff } from './YamlDiff';

const SEVERITY_ICON: Record<ChangeSeverity, { icon: string; color: 'info' | 'warning' | 'error' }> =
  {
    info: { icon: 'mdi:information-outline', color: 'info' },
    warning: { icon: 'mdi:alert-outline', color: 'warning' },
    danger: { icon: 'mdi:alert-octagon-outline', color: 'error' },
  };

export function ChangeList(props: { items: ChangeItem[] }) {
  const theme = useTheme();
  return (
    <Stack spacing={1.25}>
      {props.items.map(item => {
        const sev = SEVERITY_ICON[item.severity];
        return (
          <Stack
            key={item.key}
            direction="row"
            spacing={1.5}
            sx={{ p: 1.5, borderRadius: 1.5, border: `1px solid ${theme.palette.divider}` }}
          >
            <Box sx={{ color: `${sev.color}.main`, pt: 0.25 }}>
              <Icon icon={sev.icon} width={22} height={22} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography sx={{ fontWeight: 600 }}>{item.label}</Typography>
                <Chip size="small" variant="outlined" label={item.from} sx={{ maxWidth: 260 }} />
                <Icon icon="mdi:arrow-right" width={16} height={16} />
                <Chip size="small" color="primary" label={item.to} sx={{ maxWidth: 260 }} />
              </Stack>
              {item.consequence && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {item.consequence}
                </Typography>
              )}
            </Box>
          </Stack>
        );
      })}
    </Stack>
  );
}

export interface ReviewDialogProps {
  flow: SaveFlow;
  title: string;
  /** Non-blocking validation messages to repeat in the review. */
  warnings?: Issue[];
}

export function ReviewDialog({ flow, title, warnings = [] }: ReviewDialogProps) {
  const { phase } = flow;
  const [ack, setAck] = React.useState(false);
  const open = phase.kind !== 'idle';
  const reviewData = phase.kind === 'review' || phase.kind === 'applying' ? phase.data : null;
  const needsAck = reviewData ? needsAcknowledgement(reviewData.items) : false;

  React.useEffect(() => {
    if (phase.kind === 'dryRun') {
      setAck(false);
    }
  }, [phase.kind]);

  return (
    <Dialog
      open={open}
      onClose={phase.kind === 'applying' ? undefined : flow.close}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle>{title}</DialogTitle>
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

        {phase.kind === 'conflict' && (
          <Stack spacing={2}>
            <Alert severity="warning">
              <AlertTitle>Someone else changed the same settings while you were editing</AlertTitle>
              Choose which values to keep. The other changes they made are kept either way.
            </Alert>
            <Table size="small" aria-label="Conflicting fields">
              <TableHead>
                <TableRow>
                  <TableCell>Field</TableCell>
                  <TableCell>When you started</TableCell>
                  <TableCell>Saved meanwhile</TableCell>
                  <TableCell>Yours</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {phase.result.conflicts.map(c => (
                  <TableRow key={c.label}>
                    <TableCell>
                      <Mono>{c.label}</Mono>
                    </TableCell>
                    <TableCell>{formatValue(c.base)}</TableCell>
                    <TableCell>{formatValue(c.theirs)}</TableCell>
                    <TableCell>{formatValue(c.mine)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Stack>
        )}

        {reviewData && (
          <Stack spacing={2.5}>
            {reviewData.rebasedFrom !== undefined && (
              <Alert severity="info">
                The settings were saved by someone else while you were editing. Your changes were
                replayed on the newer version; check them again before applying.
              </Alert>
            )}
            <Box>
              <Typography variant="overline" color="text.secondary">
                {reviewData.items.length} change{reviewData.items.length === 1 ? '' : 's'}
              </Typography>
              <ChangeList items={reviewData.items} />
            </Box>
            {reviewData.reapplied.length > 0 && (
              <Alert severity="info" icon={<Icon icon="mdi:sync" />}>
                <AlertTitle>After saving, k4all-operator applies these components again</AlertTitle>
                {reviewData.reapplied.join(', ')}. Their workloads only restart where the rendered
                manifests change.
                {reviewData.reapplied.includes('headlamp') && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    Re-applying headlamp resets its Ingress to{' '}
                    <Mono>dashboard.&lt;node-ip&gt;.nip.io</Mono>
                    {'; '}if you reach this dashboard through another host name, keep NodePort 32323
                    at hand.
                  </Typography>
                )}
              </Alert>
            )}
            {warnings.length > 0 && (
              <Alert severity="warning">
                {warnings.map(w => (
                  <div key={w.field + w.message}>{w.message}</div>
                ))}
              </Alert>
            )}
            {reviewData.adjustments.length > 0 && (
              <Alert severity="info">
                <AlertTitle>The API server will store a few values differently</AlertTitle>
                {reviewData.adjustments.map(a => (
                  <div key={a.path}>
                    <Mono>{a.path}</Mono>: {formatValue(a.sent)} →{' '}
                    {formatValue(a.stored, 'removed')}
                  </div>
                ))}
              </Alert>
            )}
            <Accordion defaultExpanded disableGutters variant="outlined">
              <AccordionSummary expandIcon={<Icon icon="mdi:chevron-down" />}>
                <Typography sx={{ fontWeight: 600 }}>Resulting spec (server dry run)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <YamlDiff before={reviewData.base.spec} after={reviewData.result.spec} />
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
                  {JSON.stringify(reviewData.ops, null, 2)}
                </Box>
              </AccordionDetails>
            </Accordion>
            {needsAck && (
              <FormControlLabel
                control={<Checkbox checked={ack} onChange={e => setAck(e.target.checked)} />}
                label={
                  reviewData.items.some(
                    i => i.severity === 'danger' && /^features\.\w+\.enabled$/.test(i.key)
                  ) && !reviewData.items.some(i => i.key === 'features.ovsBridge.enabled')
                    ? 'I understand that this uninstalls components and can delete their data.'
                    : 'I understand the consequences listed above.'
                }
              />
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {phase.kind === 'conflict' ? (
          <>
            <Button onClick={flow.close}>Cancel</Button>
            <Button onClick={() => flow.resolve('theirs')}>Keep their values</Button>
            <Button variant="contained" onClick={() => flow.resolve('mine')}>
              Keep my values
            </Button>
          </>
        ) : phase.kind === 'error' ? (
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
            <Button
              variant="contained"
              onClick={flow.apply}
              disabled={!reviewData || phase.kind === 'applying' || (needsAck && !ack)}
              startIcon={
                phase.kind === 'applying' ? (
                  <CircularProgress size={16} color="inherit" />
                ) : undefined
              }
            >
              Apply changes
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
