/*
 * How fresh the page is: "Updated 12 s ago", a Refresh button, and a
 * discreet notice while the cluster does not answer (the API server or
 * Headlamp restarting during an upgrade), with the retry under way.
 */

import { Icon } from '@iconify/react';
import { Alert, Box, Button, CircularProgress, Stack, Tooltip, Typography } from '@mui/material';
import React from 'react';
import { LiveStatus, useLiveStatus } from '../../api/live';
import { formatDuration } from '../../model/upgrades';

function useTick(ms: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "just now", "12 s ago", "3 min ago". */
export function agoText(updatedAt: number | null, now: number): string {
  if (updatedAt === null) {
    return 'not yet';
  }
  const ms = Math.max(0, now - updatedAt);
  return ms < 3000 ? 'just now' : `${formatDuration(ms)} ago`;
}

export function LiveStatusView(props: { status: LiveStatus; now: number }) {
  const { status, now } = props;
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="flex-end"
        sx={{ color: 'text.secondary' }}
      >
        <Tooltip
          title={`The page follows the cluster live and also checks it every ${formatDuration(
            status.intervalMs
          )}.`}
        >
          <Typography variant="caption" aria-live="polite">
            Updated {agoText(status.updatedAt, now)}
          </Typography>
        </Tooltip>
        <Button
          size="small"
          variant="text"
          startIcon={<Icon icon="mdi:refresh" width={16} height={16} />}
          onClick={status.refresh}
          sx={{ minWidth: 0 }}
        >
          Refresh
        </Button>
      </Stack>
      {status.down && (
        <Alert
          severity="warning"
          variant="outlined"
          icon={<CircularProgress size={16} thickness={6} color="inherit" />}
          sx={{ py: 0 }}
        >
          <Box component="span" sx={{ fontWeight: 600 }}>
            The cluster is not answering
          </Box>
          {status.downSince !== null && ` (for ${formatDuration(now - status.downSince)})`}. During
          an upgrade the API server and Headlamp restart; the page shows the last known state.
          Retrying every {formatDuration(status.intervalMs)}…
        </Alert>
      )}
    </Stack>
  );
}

export function LiveStatusBar() {
  const status = useLiveStatus();
  const now = useTick(1000);
  return <LiveStatusView status={status} now={now} />;
}
