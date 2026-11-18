/*
 * Building blocks of the Upgrades page: release kind chips, the hop trail,
 * the planned-path timeline, copyable node commands, the drain timer.
 */

import { Icon } from '@iconify/react';
import {
  alpha,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import React from 'react';
import { Tone } from '../../model/components';
import { Hop } from '../../model/types';
import {
  Command,
  DrainTimer,
  formatDuration,
  formatSpan,
  HopChange,
  OrderedNode,
  PlannedHop,
  span,
} from '../../model/upgrades';
import { toneColor } from '../common/ui';

export function KindChip(props: { kind?: string }) {
  if (props.kind !== 'minor' && props.kind !== 'patch') {
    return null;
  }
  const minor = props.kind === 'minor';
  return (
    <Tooltip
      title={
        minor
          ? 'Minor release: a mandatory stop. It can change the Kubernetes minor, the Fedora major or a platform component.'
          : 'Patch release: fixes inside the same stream; patches can be skipped.'
      }
    >
      <Chip
        size="small"
        label={props.kind}
        color={minor ? 'primary' : 'default'}
        variant={minor ? 'filled' : 'outlined'}
        sx={{ height: 20, fontSize: '0.7rem', fontWeight: 600 }}
      />
    </Tooltip>
  );
}

/** "Kubernetes 1.35.10 → 1.36.4" chips. */
export function HopChanges(props: { changes: HopChange[]; empty?: string }) {
  if (props.changes.length === 0) {
    return props.empty ? (
      <Typography variant="body2" color="text.secondary">
        {props.empty}
      </Typography>
    ) : null;
  }
  const icon: Record<HopChange['what'], string> = {
    Kubernetes: 'mdi:kubernetes',
    Fedora: 'mdi:fedora',
    'CRI-O': 'mdi:package-variant',
  };
  return (
    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
      {props.changes.map(c => (
        <Chip
          key={c.what}
          size="small"
          variant="outlined"
          icon={<Icon icon={icon[c.what]} width={14} height={14} />}
          label={c.from ? `${c.what} ${c.from} → ${c.to}` : `${c.what} ${c.to}`}
          sx={{ '& .MuiChip-icon': { ml: 0.75 } }}
        />
      ))}
    </Stack>
  );
}

const HOP_TONE: Record<string, Tone> = { Done: 'success', InProgress: 'info', Pending: 'neutral' };

function Dot(props: { tone: Tone; state: 'done' | 'active' | 'pending' | 'start' }) {
  const theme = useTheme();
  const color = toneColor(theme, props.tone);
  return (
    <Box
      sx={{
        width: 28,
        height: 28,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        color: props.state === 'pending' ? 'text.secondary' : '#fff',
        backgroundColor:
          props.state === 'pending' ? theme.palette.background.paper : alpha(color, 0.95),
        border: `2px solid ${props.state === 'pending' ? theme.palette.divider : color}`,
      }}
    >
      {props.state === 'done' && <Icon icon="mdi:check" width={16} height={16} />}
      {props.state === 'active' && (
        <CircularProgress size={14} thickness={6} sx={{ color: '#fff' }} aria-hidden />
      )}
      {props.state === 'start' && <Icon icon="mdi:map-marker-outline" width={16} height={16} />}
    </Box>
  );
}

/**
 * The upgrade path as a horizontal trail: where it started, each hop with
 * its state, the hop in progress spinning.
 */
export function HopTrail(props: { from?: string; path: Hop[]; now?: number }) {
  const theme = useTheme();
  const steps: {
    key: string;
    label: string;
    kind?: string;
    took?: string;
    state: 'done' | 'active' | 'pending' | 'start';
    tone: Tone;
  }[] = [];
  if (props.from) {
    steps.push({ key: 'from', label: props.from, state: 'start', tone: 'success' });
  }
  for (const hop of props.path) {
    const took =
      props.now !== undefined
        ? formatSpan(span(hop.startedAt, hop.completedAt, props.now))
        : undefined;
    steps.push({
      took,
      key: hop.release,
      label: hop.release,
      kind: hop.kind,
      state: hop.phase === 'Done' ? 'done' : hop.phase === 'InProgress' ? 'active' : 'pending',
      tone: HOP_TONE[hop.phase] ?? 'neutral',
    });
  }
  return (
    <Box sx={{ overflowX: 'auto', pb: 0.5 }} role="list" aria-label="Upgrade path">
      <Stack direction="row" alignItems="flex-start" sx={{ minWidth: steps.length * 110 }}>
        {steps.map((s, i) => (
          <React.Fragment key={s.key}>
            <Stack
              alignItems="center"
              spacing={0.5}
              sx={{ width: 96, flexShrink: 0 }}
              role="listitem"
            >
              <Dot tone={s.tone} state={s.state} />
              <Typography
                variant="body2"
                sx={{ fontFamily: 'monospace', fontWeight: s.state === 'active' ? 700 : 500 }}
              >
                {s.label}
              </Typography>
              {s.state === 'start' ? (
                <Typography variant="caption" color="text.secondary">
                  start
                </Typography>
              ) : (
                <KindChip kind={s.kind} />
              )}
              {s.took && (
                <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                  {s.took}
                </Typography>
              )}
            </Stack>
            {i < steps.length - 1 && (
              <Box
                aria-hidden
                sx={{
                  flex: 1,
                  minWidth: 16,
                  height: 2,
                  mt: '13px',
                  backgroundColor:
                    steps[i + 1].state === 'pending'
                      ? theme.palette.divider
                      : toneColor(theme, steps[i + 1].tone),
                }}
              />
            )}
          </React.Fragment>
        ))}
      </Stack>
    </Box>
  );
}

/** The planned hops, top to bottom, with what each one changes and its notes. */
export function PlanTimeline(props: { hops: PlannedHop[]; nodes: number }) {
  const theme = useTheme();
  return (
    <Box role="list" aria-label="Planned hops">
      {props.hops.map((hop, i) => (
        <Stack key={hop.release.version} direction="row" spacing={1.5} role="listitem">
          <Stack alignItems="center" sx={{ pt: 0.25 }}>
            <Box
              sx={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: '0.75rem',
                fontWeight: 700,
                color: theme.palette.primary.contrastText,
                backgroundColor: theme.palette.primary.main,
              }}
            >
              {i + 1}
            </Box>
            {i < props.hops.length - 1 && (
              <Box sx={{ flex: 1, width: 2, my: 0.5, backgroundColor: theme.palette.divider }} />
            )}
          </Stack>
          <Box sx={{ pb: i < props.hops.length - 1 ? 2 : 0, minWidth: 0, flex: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
                {hop.from} → {hop.release.version}
              </Typography>
              <KindChip kind={hop.kind} />
              <Typography variant="caption" color="text.secondary">
                {props.nodes === 1 ? 'one reboot' : `${props.nodes} reboots, one node at a time`}
              </Typography>
            </Stack>
            <Box sx={{ mt: 0.75 }}>
              <HopChanges
                changes={hop.changes}
                empty="Same Kubernetes and Fedora: tools, fixes and cluster components."
              />
            </Box>
            {hop.release.notes && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.75, whiteSpace: 'pre-line' }}
              >
                {hop.release.notes}
              </Typography>
            )}
          </Box>
        </Stack>
      ))}
    </Box>
  );
}

/** The nodes in upgrade order, as numbered chips. */
export function NodeOrder(props: { order: OrderedNode[] }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
      {props.order.map((n, i) => (
        <React.Fragment key={n.name}>
          <Chip
            size="small"
            variant="outlined"
            label={
              <span>
                <b>{i + 1}.</b> {n.name}{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  {n.role}
                </Typography>
              </span>
            }
          />
          {i < props.order.length - 1 && (
            <Icon icon="mdi:chevron-right" width={16} height={16} aria-hidden />
          )}
        </React.Fragment>
      ))}
    </Stack>
  );
}

/** A shell command with where to run it and a copy button. */
export function CommandLine(props: Command) {
  const theme = useTheme();
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(props.command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined
    );
  };
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        pl: 1.25,
        pr: 0.5,
        py: 0.25,
        borderRadius: 1,
        backgroundColor: alpha(
          theme.palette.text.primary,
          theme.palette.mode === 'dark' ? 0.12 : 0.05
        ),
        border: `1px solid ${theme.palette.divider}`,
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
        {props.where}
      </Typography>
      <Box
        component="code"
        sx={{ fontFamily: 'monospace', fontSize: '0.82rem', flex: 1, wordBreak: 'break-all' }}
      >
        {props.command}
      </Box>
      <Tooltip title={copied ? 'Copied' : 'Copy'}>
        <IconButton size="small" onClick={copy} aria-label={`Copy ${props.command}`}>
          <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={16} height={16} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/** Drain progress against the timeout. */
export function DrainTimerBar(props: { timer: DrainTimer; continueOnTimeout: boolean }) {
  const { timer } = props;
  return (
    <Box sx={{ minWidth: 160 }}>
      <LinearProgress
        variant="determinate"
        value={timer.fraction * 100}
        color={timer.overdue ? 'error' : timer.fraction > 0.75 ? 'warning' : 'primary'}
        aria-label="Drain time used"
        sx={{ height: 6, borderRadius: 3 }}
      />
      <Typography variant="caption" color="text.secondary">
        {timer.overdue
          ? `timed out after ${formatDuration(timer.timeoutMs)}`
          : `${formatDuration(timer.elapsedMs)} of ${formatDuration(timer.timeoutMs)}, then ${
              props.continueOnTimeout ? 'the hop runs anyway' : 'the node fails'
            }`}
      </Typography>
    </Box>
  );
}
