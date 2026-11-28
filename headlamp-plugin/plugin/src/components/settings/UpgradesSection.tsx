/*
 * Settings → Upgrades (k4all-operator v0.7.0): the mode of each remediation
 * of the catalog, for every drain of the operator (ClusterUpgrade and the
 * node-settings rollout), in ClusterConfig spec.upgrades.remediations. auto
 * only where the catalog allows it; an id the addon does not know is shown
 * read-only; the UnknownRemediation condition says what the operator
 * ignores. Saved through the settings flow (JSON Patch, dry run, review).
 */

import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';
import { findCondition } from '../../model/health';
import {
  DEFAULT_MODE,
  MODE_TEXT,
  ModeRow,
  modeRows,
  MODES,
  withRemediationMode,
} from '../../model/readiness';
import {
  CONDITION_UNKNOWN_REMEDIATION,
  REASON_AUTO_NOT_ALLOWED,
  RemediationMode,
} from '../../model/types';
import { CapabilityChip, Mono, Panel } from '../common/ui';
import { SectionProps } from './common';
import { CapabilityNotice } from './settingsLinks';

const RISK_LABEL: Record<string, string> = {
  None: 'No downtime',
  Downtime: 'Downtime',
  Disruption: 'The disruption as reported',
  BuiltIn: 'Built in',
};

function ModeSelect(props: {
  row: ModeRow;
  disabled: boolean;
  onChange: (mode: RemediationMode) => void;
}) {
  const { row } = props;
  const entry = row.entry!;
  const value = row.mode ?? DEFAULT_MODE;
  return (
    <Select
      size="small"
      value={value}
      disabled={props.disabled}
      onChange={e => props.onChange(e.target.value as RemediationMode)}
      inputProps={{ 'aria-label': `Mode of ${row.id}` }}
      renderValue={v => (row.mode === undefined ? `${v} (default)` : String(v))}
      sx={{ minWidth: 140 }}
    >
      {MODES.map(m => (
        <MenuItem key={m} value={m} disabled={m === 'auto' && !entry.autoAllowed}>
          <Stack>
            <span>
              {m}
              {m === DEFAULT_MODE ? ' (default)' : ''}
            </span>
            <Typography variant="caption" color="text.secondary">
              {m === 'auto' && !entry.autoAllowed
                ? `not allowed: ${entry.autoRefusal ?? 'the catalog does not allow it'}`
                : MODE_TEXT[m].replace(/^\w+: /, '')}
            </Typography>
          </Stack>
        </MenuItem>
      ))}
    </Select>
  );
}

export function UpgradesSection(props: SectionProps) {
  const { draft, base, update, caps, status } = props;
  const live = caps.upgradeReadiness;
  const disabled = props.disabled || !live;
  const rows = modeRows(draft);
  const baseModes = base.upgrades?.remediations ?? {};
  const cond = findCondition(status?.conditions, CONDITION_UNKNOWN_REMEDIATION);
  return (
    <Stack spacing={2}>
      <CapabilityNotice caps={caps} id="upgradeReadiness" what="Remediation modes" />
      {cond?.status === 'True' && (
        <Alert severity="warning">
          <AlertTitle>
            {cond.reason === REASON_AUTO_NOT_ALLOWED
              ? 'k4all-operator reads some auto entries as ask'
              : 'k4all-operator ignores some entries'}
          </AlertTitle>
          {cond.message || cond.reason} (<Mono>{CONDITION_UNKNOWN_REMEDIATION}</Mono>)
        </Alert>
      )}
      <Panel
        title="Fixes for drains"
        icon="mdi:wrench-check-outline"
        action={!live ? <CapabilityChip id="upgradeReadiness" /> : undefined}
      >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Before each node's drain, in an upgrade or a node-settings rollout, k4all-operator checks
          what the drain would stop or disrupt and offers these fixes. The mode says what it does
          with each: <b>auto</b> applies it by itself, <b>ask</b> waits for your approval for the
          object (the Upgrades page), <b>off</b> only reports it. Left out, a fix asks. k4all puts
          back what a fix changed once the node is done.
        </Typography>
        <Table size="small" aria-label="Remediation modes">
          <TableHead>
            <TableRow>
              <TableCell>Fix</TableCell>
              <TableCell sx={{ minWidth: 260 }}>What it does</TableCell>
              <TableCell sx={{ minWidth: 180 }}>Risk</TableCell>
              <TableCell>Mode</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(row => {
              const changed = (baseModes[row.id] ?? undefined) !== (row.mode ?? undefined);
              return (
                <TableRow
                  key={row.id}
                  sx={
                    changed
                      ? { boxShadow: theme => `inset 3px 0 ${theme.palette.primary.main}` }
                      : {}
                  }
                >
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {row.entry?.title ?? row.id}
                    </Typography>
                    <Mono>{row.id}</Mono>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {row.entry?.does ?? 'Unknown to this addon: a newer operator may know it.'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {row.entry ? (
                      <>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {RISK_LABEL[row.entry.risk]}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {row.entry.riskText}
                        </Typography>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {!row.entry ? (
                      <Tooltip title="Unknown to this addon: shown read-only. k4all-operator names the ids it does not know in the UnknownRemediation condition.">
                        <Stack>
                          <Mono>{row.mode}</Mono>
                          <Typography variant="caption" color="text.secondary">
                            unknown to this addon
                          </Typography>
                        </Stack>
                      </Tooltip>
                    ) : !row.entry.hasMode ? (
                      <Typography variant="body2" color="text.secondary">
                        built in, no mode
                      </Typography>
                    ) : (
                      <Stack spacing={0.5}>
                        <ModeSelect
                          row={row}
                          disabled={disabled}
                          onChange={mode => update(d => withRemediationMode(d, row.id, mode))}
                        />
                        {!row.entry.autoAllowed && (
                          <Typography variant="caption" color="text.secondary">
                            <Icon icon="mdi:lock-outline" width={12} height={12} /> auto not
                            allowed: {row.entry.autoRefusal}
                          </Typography>
                        )}
                        {row.autoRefused && (
                          <Typography variant="caption" color="error">
                            auto is not allowed here: k4all-operator reads it as ask.
                          </Typography>
                        )}
                      </Stack>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          By hand, quote <Mono>&quot;off&quot;</Mono> in YAML: unquoted, YAML reads it as false and
          the API server refuses it.
        </Typography>
      </Panel>
    </Stack>
  );
}
