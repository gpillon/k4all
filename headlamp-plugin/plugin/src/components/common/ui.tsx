/*
 * The plugin's small visual vocabulary, built on MUI and the Headlamp theme so
 * it follows light/dark mode: tone pills, page headers, setting rows, cards.
 */

import { Icon } from '@iconify/react';
import {
  alpha,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Theme,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import React from 'react';
import { Tone } from '../../model/components';

export function toneColor(theme: Theme, tone: Tone): string {
  switch (tone) {
    case 'success':
      return theme.palette.success.main;
    case 'info':
      return theme.palette.info.main;
    case 'warning':
      return theme.palette.warning.main;
    case 'error':
      return theme.palette.error.main;
    default:
      return theme.palette.text.disabled;
  }
}

/** A rounded label with a coloured dot (or a spinner while busy). */
export function TonePill(props: {
  tone: Tone;
  label: React.ReactNode;
  busy?: boolean;
  title?: string;
}) {
  const theme = useTheme();
  const color = toneColor(theme, props.tone);
  const pill = (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        py: 0.25,
        borderRadius: 999,
        fontSize: '0.8125rem',
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
        color: props.tone === 'neutral' ? 'text.secondary' : 'text.primary',
        backgroundColor: alpha(color, theme.palette.mode === 'dark' ? 0.2 : 0.1),
        border: `1px solid ${alpha(color, 0.35)}`,
      }}
    >
      {props.busy ? (
        <CircularProgress size={10} thickness={6} sx={{ color }} aria-hidden />
      ) : (
        <Box
          component="span"
          aria-hidden
          sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color }}
        />
      )}
      {props.label}
    </Box>
  );
  return props.title ? <Tooltip title={props.title}>{pill}</Tooltip> : pill;
}

export function PageHeader(props: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      alignItems={{ xs: 'flex-start', md: 'center' }}
      justifyContent="space-between"
      spacing={2}
      sx={{ mb: 3 }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        {props.icon && (
          <Box
            sx={theme => ({
              width: 44,
              height: 44,
              borderRadius: 2,
              display: 'grid',
              placeItems: 'center',
              color: theme.palette.primary.contrastText,
              background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${alpha(
                theme.palette.primary.main,
                0.6
              )})`,
            })}
          >
            <Icon icon={props.icon} width={26} height={26} />
          </Box>
        )}
        <Box>
          <Typography variant="h1" sx={{ fontSize: '1.6rem', fontWeight: 600 }}>
            {props.title}
          </Typography>
          {props.subtitle && (
            <Typography variant="body2" color="text.secondary">
              {props.subtitle}
            </Typography>
          )}
        </Box>
      </Stack>
      {props.actions && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {props.actions}
        </Stack>
      )}
    </Stack>
  );
}

/** A titled card. */
export function Panel(props: {
  title?: React.ReactNode;
  icon?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  dense?: boolean;
}) {
  return (
    <Card variant="outlined" id={props.id} sx={{ height: '100%', borderRadius: 2 }}>
      <CardContent sx={{ p: props.dense ? 2 : 2.5, '&:last-child': { pb: props.dense ? 2 : 2.5 } }}>
        {(props.title || props.action) && (
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 1.5 }}
            spacing={1}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              {props.icon && <Icon icon={props.icon} width={20} height={20} />}
              <Typography variant="h2" sx={{ fontSize: '1.05rem', fontWeight: 600 }}>
                {props.title}
              </Typography>
            </Stack>
            {props.action}
          </Stack>
        )}
        {props.children}
      </CardContent>
    </Card>
  );
}

/** A big number with a caption, for the overview. */
export function Metric(props: { value: React.ReactNode; caption: React.ReactNode; tone?: Tone }) {
  const theme = useTheme();
  return (
    <Box>
      <Typography
        sx={{
          fontSize: '2rem',
          fontWeight: 700,
          lineHeight: 1.1,
          color: props.tone ? toneColor(theme, props.tone) : 'text.primary',
        }}
      >
        {props.value}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {props.caption}
      </Typography>
    </Box>
  );
}

export interface Segment {
  label: string;
  value: number;
  tone: Tone;
}

/** A stacked horizontal bar with a legend. */
export function SegmentBar(props: { segments: Segment[] }) {
  const theme = useTheme();
  const total = props.segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const visible = props.segments.filter(s => s.value > 0);
  return (
    <Box>
      <Box
        role="img"
        aria-label={visible.map(s => `${s.value} ${s.label}`).join(', ')}
        sx={{
          display: 'flex',
          height: 10,
          borderRadius: 999,
          overflow: 'hidden',
          backgroundColor: theme.palette.action.hover,
        }}
      >
        {visible.map(s => (
          <Box
            key={s.label}
            sx={{ width: `${(s.value / total) * 100}%`, backgroundColor: toneColor(theme, s.tone) }}
          />
        ))}
      </Box>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
        {visible.map(s => (
          <Stack key={s.label} direction="row" spacing={0.75} alignItems="center">
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: toneColor(theme, s.tone),
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {s.value} {s.label}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

export type ApplyBadgeMode = 'live' | 'install' | 'node';

const APPLY_BADGE: Record<ApplyBadgeMode, { label: string; icon: string; title: string }> = {
  live: {
    label: 'Live',
    icon: 'mdi:lightning-bolt',
    title: 'k4all-operator applies a change within seconds.',
  },
  install: {
    label: 'Install-time',
    icon: 'mdi:lock-outline',
    title: 'Fixed when the cluster was installed.',
  },
  node: {
    label: 'Node file',
    icon: 'mdi:file-lock-outline',
    title: 'Read by the nodes from /etc/k4all-config.yaml.',
  },
};

export function ApplyBadge(props: { mode: ApplyBadgeMode }) {
  const badge = APPLY_BADGE[props.mode];
  return (
    <Tooltip title={badge.title}>
      <Chip
        size="small"
        variant="outlined"
        icon={<Icon icon={badge.icon} width={14} height={14} />}
        label={badge.label}
        sx={{ height: 22, fontSize: '0.72rem', '& .MuiChip-icon': { ml: 0.75 } }}
      />
    </Tooltip>
  );
}

/**
 * One setting: label and help on the left, control on the right, with an
 * optional "changed" marker and messages below.
 */
export function SettingRow(props: {
  label: React.ReactNode;
  help?: React.ReactNode;
  control: React.ReactNode;
  changed?: boolean;
  badge?: React.ReactNode;
  messages?: React.ReactNode;
  htmlFor?: string;
  last?: boolean;
}) {
  const theme = useTheme();
  return (
    <Box
      sx={{
        py: 2,
        pl: 1.5,
        borderBottom: props.last ? 'none' : `1px solid ${theme.palette.divider}`,
        borderLeft: `3px solid ${props.changed ? theme.palette.primary.main : 'transparent'}`,
        transition: 'border-color 120ms',
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ sm: 'center' }}
        justifyContent="space-between"
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography
              component={props.htmlFor ? 'label' : 'span'}
              htmlFor={props.htmlFor}
              sx={{ fontWeight: 600 }}
            >
              {props.label}
            </Typography>
            {props.badge}
            {props.changed && (
              <Chip
                size="small"
                color="primary"
                label="changed"
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            )}
          </Stack>
          {props.help && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 720 }}>
              {props.help}
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            flexShrink: 0,
            minWidth: { sm: 260 },
            display: 'flex',
            justifyContent: { sm: 'flex-end' },
          }}
        >
          {props.control}
        </Box>
      </Stack>
      {props.messages && <Box sx={{ mt: 1 }}>{props.messages}</Box>}
    </Box>
  );
}

export function Mono(props: { children: React.ReactNode }) {
  return (
    <Box
      component="code"
      sx={{
        fontFamily: 'monospace',
        fontSize: '0.85em',
        px: 0.5,
        borderRadius: 0.5,
        backgroundColor: 'action.hover',
      }}
    >
      {props.children}
    </Box>
  );
}
