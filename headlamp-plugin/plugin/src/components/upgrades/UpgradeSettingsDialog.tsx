import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import { ClusterUpgradeSpec, DEFAULT_UPGRADE_GRAPH_URL } from '../../model/types';
import { DEFAULT_DRAIN_TIMEOUT_MINUTES } from '../../model/upgrades';
import { Mono } from '../common/ui';
import { ReviewIntent } from './useUpgradeFlow';

/** Edits spec.drain and spec.graphUrl; saving goes through the review (dry run). */
export function UpgradeSettingsDialog(props: {
  open: boolean;
  spec: ClusterUpgradeSpec;
  singleNode: boolean;
  onClose: () => void;
  onReview: (intent: ReviewIntent) => void;
}) {
  const { spec } = props;
  const [timeout, setTimeoutText] = React.useState('');
  const [cont, setCont] = React.useState(false);
  const [graph, setGraph] = React.useState('');

  // Fill the form when the dialog opens, not on every watch update: the
  // operator writes the status (and Headlamp a new object) while a drain runs.
  React.useEffect(() => {
    if (props.open) {
      setTimeoutText(String(spec.drain?.timeoutMinutes || DEFAULT_DRAIN_TIMEOUT_MINUTES));
      setCont(spec.drain?.continueOnTimeout === true);
      setGraph(spec.graphUrl ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const minutes = Number(timeout);
  const timeoutError =
    timeout.trim() === '' || !Number.isInteger(minutes) || minutes < 1
      ? 'A whole number of minutes, 1 or more.'
      : undefined;
  const graphError =
    graph.trim() !== '' && !/^https?:\/\/\S+$/.test(graph.trim())
      ? 'An http(s) URL, or empty for the k4all release graph.'
      : undefined;

  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Upgrade settings</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {props.singleNode && (
            <Alert severity="info">
              Single node: it is only cordoned before its hop, so the drain settings take effect
              once the cluster has more nodes.
            </Alert>
          )}
          <TextField
            label="Drain timeout (minutes)"
            type="number"
            size="small"
            value={timeout}
            onChange={e => setTimeoutText(e.target.value)}
            error={!!timeoutError}
            helperText={
              timeoutError ??
              'How long to wait for the evictions, which PodDisruptionBudgets can hold back.'
            }
            inputProps={{ min: 1 }}
          />
          <FormControlLabel
            control={<Switch checked={cont} onChange={(_, checked) => setCont(checked)} />}
            label={
              <span>
                Continue when the drain times out
                <Typography variant="body2" color="text.secondary" component="span" display="block">
                  The hop runs anyway; the pods left on the node stop at its reboot. Off: the node
                  fails and waits for a retry.
                </Typography>
              </span>
            }
          />
          <TextField
            label="Upgrade graph URL"
            size="small"
            value={graph}
            placeholder={DEFAULT_UPGRADE_GRAPH_URL}
            onChange={e => setGraph(e.target.value)}
            error={!!graphError}
            helperText={
              graphError ?? (
                <>
                  Empty means the k4all release graph. It must be the graph the nodes read (
                  <Mono>graphUrl</Mono> in <Mono>/etc/k4all-upgrade.yaml</Mono>), or they refuse the
                  hops.
                </>
              )
            }
            inputProps={{ spellCheck: false, style: { fontFamily: 'monospace' } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!!timeoutError || !!graphError}
          onClick={() =>
            props.onReview({
              kind: 'settings',
              drain: { timeoutMinutes: minutes, continueOnTimeout: cont },
              graphUrl: graph,
            })
          }
        >
          Review changes
        </Button>
      </DialogActions>
    </Dialog>
  );
}
