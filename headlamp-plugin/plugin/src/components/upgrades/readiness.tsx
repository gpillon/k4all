/*
 * Upgrade readiness on the page (k4all-operator v0.7.0): a finding with its
 * fixes, a node's card of the readiness report, the "Before you upgrade"
 * panel, the live blockers of a node, and "What k4all changed".
 *
 * One component per thing, used by the Upgrades page, the start review and
 * the node-settings rollout. A finding's fixes come in three ways:
 *   view:   what each option does, its risk and mode, and the answers given;
 *   act:    Apply fix / Accept, written at once (live blockers, a running upgrade);
 *   select: radios (Blocks) and checkboxes (Disrupts) for the start review.
 * Without patch permission (act), or without the operator's capability, no
 * button is shown: the page is read-only.
 */

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
  Radio,
  RadioGroup,
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
import {
  acceptAnswer,
  ACKNOWLEDGE,
  Answer,
  answerable,
  AnyApproval,
  applyAnswer,
  Binding,
  canRestore,
  catalogEntry,
  Choice,
  findingAdvice,
  findingAnswers,
  findingChoices,
  findingKey,
  FOLLOW_COMMANDS,
  MODE_TEXT,
  NodeCard,
  ReadinessView,
  RECORD_PHASE,
  refText,
  remediationTitle,
  sameRef,
  Selection,
  SEVERITY_TEXT,
} from '../../model/readiness';
import {
  Finding,
  RemediationMode,
  RemediationOption,
  RemediationRecordStatus,
} from '../../model/types';
import { formatDuration } from '../../model/upgrades';
import { Mono, Panel, TonePill } from '../common/ui';
import { CommandLine } from './parts';

// ------------------------------------------------------------------ Small parts

/** "5 min ago", with the time as a tooltip. */
export function Ago(props: { at?: string; now: number; prefix?: string }) {
  const t = props.at ? Date.parse(props.at) : NaN;
  if (Number.isNaN(t)) {
    return <span>{props.prefix ? `${props.prefix} at an unknown time` : '—'}</span>;
  }
  return (
    <Tooltip title={props.at}>
      <span>
        {props.prefix ? `${props.prefix} ` : ''}
        {formatDuration(Math.max(0, props.now - t))} ago
      </span>
    </Tooltip>
  );
}

const SEVERITY_TONE: Record<string, 'error' | 'warning' | 'info'> = {
  Blocks: 'error',
  Disrupts: 'warning',
  Info: 'info',
};

export function SeverityChip(props: { severity: string }) {
  return (
    <Chip
      size="small"
      color={SEVERITY_TONE[props.severity] ?? 'default'}
      variant={props.severity === 'Blocks' ? 'filled' : 'outlined'}
      label={`${props.severity}${
        SEVERITY_TEXT[props.severity] ? `: ${SEVERITY_TEXT[props.severity]}` : ''
      }`}
      sx={{ height: 22, fontSize: '0.72rem', fontWeight: 600 }}
    />
  );
}

export function RiskChip(props: { risk: string; remediation?: string }) {
  const entry = props.remediation ? catalogEntry(props.remediation) : undefined;
  const none = props.risk === 'None';
  return (
    <Tooltip title={entry?.riskText ?? `Risk: ${props.risk}`}>
      <Chip
        size="small"
        variant="outlined"
        color={none ? 'success' : 'warning'}
        label={none ? 'no downtime' : props.risk === 'Downtime' ? 'downtime' : props.risk}
        sx={{ height: 20, fontSize: '0.7rem' }}
      />
    </Tooltip>
  );
}

export function ModeChip(props: { mode: string }) {
  const text = MODE_TEXT[props.mode as RemediationMode] ?? `mode ${props.mode}`;
  return (
    <Tooltip title={`${text} (Settings → Upgrades)`}>
      <Chip
        size="small"
        variant={props.mode === 'auto' ? 'filled' : 'outlined'}
        color={props.mode === 'auto' ? 'primary' : 'default'}
        label={props.mode}
        sx={{ height: 20, fontSize: '0.7rem' }}
      />
    </Tooltip>
  );
}

function AnswerChip(props: { label: string }) {
  return (
    <Chip
      size="small"
      color="success"
      icon={<Icon icon="mdi:check" width={14} height={14} />}
      label={props.label}
      sx={{ height: 22, fontSize: '0.72rem', '& .MuiChip-icon': { ml: 0.75 } }}
    />
  );
}

/** One option of a finding: what it does, its risk and mode, and a control. */
function OptionLine(props: {
  option: RemediationOption;
  control?: React.ReactNode;
  /** Name the object it changes (another one than the finding's). */
  showTarget?: boolean;
}) {
  const o = props.option;
  const entry = catalogEntry(o.remediation);
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      alignItems={{ sm: 'center' }}
      justifyContent="space-between"
      sx={{ py: 0.5 }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {remediationTitle(o.remediation)}
          </Typography>
          <RiskChip risk={o.risk} remediation={o.remediation} />
          <ModeChip mode={o.mode} />
          {o.mode === 'auto' && (
            <Typography variant="caption" color="text.secondary">
              k4all does it by itself
            </Typography>
          )}
          {o.mode === 'off' && (
            <Typography variant="caption" color="text.secondary">
              off in Settings → Upgrades: reported only
            </Typography>
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {o.summary || entry?.does || o.remediation}
          {props.showTarget && (
            <>
              {' '}
              (<Mono>{refText(o.target)}</Mono>)
            </>
          )}
        </Typography>
      </Box>
      {props.control && <Box sx={{ flexShrink: 0 }}>{props.control}</Box>}
    </Stack>
  );
}

// ----------------------------------------------------------------- Finding

export type FindingControls =
  | { kind: 'view' }
  | {
      kind: 'act';
      onAnswer: (answer: Answer) => void;
      busy?: boolean;
    }
  | {
      kind: 'select';
      choice: Choice | undefined;
      onChoice: (choice: Choice) => void;
    };

export interface FindingViewProps {
  finding: Finding;
  /** The node whose drain it is about (empty for a cluster finding). */
  node: string;
  controls: FindingControls;
  /** The answers given already, and what they are bound to. */
  approvals?: AnyApproval[];
  binding?: Binding;
}

/** Why Accept on a finding that blocks needs a confirmation. */
function AcceptConfirm(props: {
  open: boolean;
  finding: Finding;
  node: string;
  onClose: () => void;
  onAccept: () => void;
}) {
  const bare =
    findingChoices(props.finding).accept?.remediation === ACKNOWLEDGE &&
    props.finding.kind === 'BarePod';
  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Go on without a fix?</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          {bare ? (
            <Typography>
              <Mono>{props.node}</Mono> is cordoned and drained: the drain deletes{' '}
              {refText(props.finding.object)}, and nothing recreates it.
            </Typography>
          ) : (
            <Typography>
              <Mono>{props.node}</Mono> is cordoned and drained anyway, up to the drain timeout:{' '}
              {refText(props.finding.object)} stops the drain as it is, so the drain may wait until
              it times out.
            </Typography>
          )}
          <Typography color="text.secondary">
            The answer is for this node&apos;s drain in this upgrade only.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Cancel</Button>
        <Button color="warning" variant="contained" onClick={props.onAccept}>
          Accept and drain
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SelectControls(props: {
  finding: Finding;
  node: string;
  choice: Choice | undefined;
  onChoice: (choice: Choice) => void;
}) {
  const f = props.finding;
  const choices = findingChoices(f);
  const choice = props.choice ?? { apply: [], accept: false };
  if (choices.fixes.length === 0 && choices.auto.length > 0) {
    return null; // k4all applies it by itself: nothing to answer
  }
  const label = (o: RemediationOption) => (
    <span>
      {remediationTitle(o.remediation)} <RiskChip risk={o.risk} remediation={o.remediation} />
    </span>
  );
  if (f.severity === 'Blocks') {
    const value = choice.accept ? 'accept' : choice.apply[0] ?? 'self';
    return (
      <RadioGroup
        value={value}
        aria-label={`Answer for ${refText(f.object)} on ${props.node}`}
        onChange={(_, v) =>
          props.onChoice(
            v === 'accept'
              ? { apply: [], accept: true }
              : v === 'self'
              ? { apply: [], accept: false }
              : { apply: [v], accept: false }
          )
        }
      >
        {choices.fixes.map(o => (
          <FormControlLabel
            key={o.remediation}
            value={o.remediation}
            control={<Radio size="small" />}
            label={label(o)}
          />
        ))}
        <FormControlLabel value="self" control={<Radio size="small" />} label="Fix it myself" />
        {choices.accept && (
          <FormControlLabel
            value="accept"
            control={<Radio size="small" />}
            label={
              f.kind === 'BarePod'
                ? 'Go on: the drain deletes it'
                : 'Go on: drain anyway, up to the drain timeout'
            }
          />
        )}
      </RadioGroup>
    );
  }
  return (
    <Stack>
      {choices.fixes.map(o => (
        <FormControlLabel
          key={o.remediation}
          control={
            <Checkbox
              size="small"
              checked={choice.apply.includes(o.remediation)}
              onChange={e =>
                props.onChoice({
                  apply: e.target.checked
                    ? [...choice.apply, o.remediation]
                    : choice.apply.filter(id => id !== o.remediation),
                  accept: false,
                })
              }
            />
          }
          label={label(o)}
        />
      ))}
      {choices.accept && (
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={choice.accept}
              onChange={e => props.onChoice({ apply: [], accept: e.target.checked })}
            />
          }
          label="Accept: the disruption happens as reported"
        />
      )}
    </Stack>
  );
}

/** One finding: its kind, object, message, what to do, and its fixes. */
export function FindingView(props: FindingViewProps) {
  const { finding: f, node, controls } = props;
  const advice = findingAdvice(f, node || undefined);
  const choices = findingChoices(f);
  const answers =
    props.binding && node ? findingAnswers(props.approvals, f, props.binding, node) : null;
  const [confirm, setConfirm] = React.useState(false);
  const accept = node ? acceptAnswer(f, node) : null;
  const options = (f.remediations ?? []).filter(o => o.remediation !== ACKNOWLEDGE);

  const actButton = (o: RemediationOption) => {
    if (controls.kind !== 'act') {
      return undefined;
    }
    if (answers?.applied.includes(o.remediation)) {
      return <AnswerChip label="approved" />;
    }
    if (o.mode === 'auto' || o.mode === 'off' || answers?.accepted) {
      return undefined;
    }
    return (
      <Button
        size="small"
        variant="outlined"
        disabled={controls.busy}
        onClick={() => controls.onAnswer(applyAnswer(o))}
        aria-label={`Apply fix ${o.remediation} for ${refText(o.target)}`}
      >
        Apply fix
      </Button>
    );
  };
  const viewChip = (o: RemediationOption) =>
    controls.kind === 'view' && answers?.applied.includes(o.remediation) ? (
      <AnswerChip label="approved" />
    ) : undefined;

  return (
    <Box
      sx={{
        borderLeft: 3,
        borderColor: `${SEVERITY_TONE[f.severity] ?? 'info'}.main`,
        pl: 1.5,
        py: 0.5,
      }}
      role="group"
      aria-label={`${f.kind} ${refText(f.object)}`}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <SeverityChip severity={f.severity} />
        <Typography sx={{ fontWeight: 600 }}>{advice.label}</Typography>
        {!advice.unknown && <Mono>{f.kind}</Mono>}
        <Typography variant="body2" color="text.secondary">
          {refText(f.object)}
          {(f.count ?? 0) > 1 ? ` and ${(f.count ?? 0) - 1} more` : ''}
        </Typography>
        {answers?.accepted && <AnswerChip label="accepted" />}
      </Stack>
      {f.message && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {f.message}
        </Typography>
      )}
      {advice.advice && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {advice.advice}
        </Typography>
      )}
      {advice.unknown && (
        <Typography variant="caption" color="text.secondary">
          A finding kind this addon does not know: its message says what it is.
        </Typography>
      )}

      {controls.kind === 'select' && answerable(f) ? (
        <Box sx={{ mt: 0.75 }}>
          {[...choices.auto, ...choices.off].map(o => (
            <OptionLine key={o.remediation} option={o} showTarget={!sameRef(o.target, f.object)} />
          ))}
          <SelectControls
            finding={f}
            node={node}
            choice={controls.choice}
            onChoice={controls.onChoice}
          />
        </Box>
      ) : (
        options.length > 0 && (
          <Box sx={{ mt: 0.75 }}>
            {options.map(o => (
              <OptionLine
                key={o.remediation}
                option={o}
                showTarget={!sameRef(o.target, f.object)}
                control={controls.kind === 'act' ? actButton(o) : viewChip(o)}
              />
            ))}
          </Box>
        )
      )}

      {controls.kind === 'act' && accept && !answers?.accepted && !answers?.applied.length && (
        <Box sx={{ mt: 0.5 }}>
          <Button
            size="small"
            color="warning"
            disabled={controls.busy}
            startIcon={<Icon icon="mdi:arrow-right-bold-outline" />}
            onClick={() => (f.severity === 'Blocks' ? setConfirm(true) : controls.onAnswer(accept))}
            aria-label={`Accept ${refText(f.object)} on ${node}`}
          >
            Accept
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            {f.severity === 'Blocks'
              ? f.kind === 'BarePod'
                ? 'go on: the drain deletes it'
                : 'go on without a fix: the node is drained anyway'
              : 'go on: the disruption happens as reported'}
          </Typography>
        </Box>
      )}

      {advice.commands.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          {advice.commands.map(c => (
            <CommandLine key={c.command} {...c} />
          ))}
        </Stack>
      )}
      {advice.links.length > 0 && (
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
          {advice.links.map(l => (
            <Typography key={l.href} variant="caption" component="span">
              <a href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            </Typography>
          ))}
        </Stack>
      )}
      {controls.kind === 'act' && accept && (
        <AcceptConfirm
          open={confirm}
          finding={f}
          node={node}
          onClose={() => setConfirm(false)}
          onAccept={() => {
            setConfirm(false);
            controls.onAnswer(accept);
          }}
        />
      )}
    </Box>
  );
}

/** Info findings, folded. */
function InfoFold(props: { findings: Finding[]; node: string }) {
  if (props.findings.length === 0) {
    return null;
  }
  return (
    <Accordion disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<Icon icon="mdi:chevron-down" />}>
        <Typography variant="body2">
          {props.findings.length} thing{props.findings.length === 1 ? '' : 's'} to know
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1}>
          {props.findings.map((f, i) => (
            <FindingView
              key={`${f.kind}-${i}`}
              finding={f}
              node={props.node}
              controls={{ kind: 'view' }}
            />
          ))}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

/** The findings of one node (or the cluster): Blocks and Disrupts with their fixes, Info folded. */
export function FindingList(props: {
  findings: Finding[];
  node: string;
  controls: (f: Finding) => FindingControls;
  approvals?: AnyApproval[];
  binding?: Binding;
}) {
  const main = props.findings.filter(f => f.severity !== 'Info');
  const info = props.findings.filter(f => f.severity === 'Info');
  return (
    <Stack spacing={1.25}>
      {main.map((f, i) => (
        <FindingView
          key={`${f.kind}-${f.object.namespace}-${f.object.name}-${i}`}
          finding={f}
          node={props.node}
          controls={props.controls(f)}
          approvals={props.approvals}
          binding={props.binding}
        />
      ))}
      <InfoFold findings={info} node={props.node} />
    </Stack>
  );
}

// ---------------------------------------------------------------- Node card

function SummaryChips(props: { summary?: NodeCard['summary'] }) {
  const s = props.summary ?? {};
  const chips: { label: string; color: 'error' | 'warning' | 'default' }[] = [];
  if (s.blocks) {
    chips.push({ label: `${s.blocks} block${s.blocks === 1 ? 's' : ''}`, color: 'error' });
  }
  if (s.disrupts) {
    chips.push({ label: `${s.disrupts} disrupt${s.disrupts === 1 ? 's' : ''}`, color: 'warning' });
  }
  if (s.vmShutdowns) {
    chips.push({
      label: `${s.vmShutdowns} VM${s.vmShutdowns === 1 ? '' : 's'} shut down${
        s.vmsDownUntilNodeBack ? `, ${s.vmsDownUntilNodeBack} until the node is back` : ''
      }`,
      color: 'warning',
    });
  }
  if (s.info) {
    chips.push({ label: `${s.info} to know`, color: 'default' });
  }
  if (chips.length === 0) {
    return <TonePill tone="success" label="nothing in the way" />;
  }
  return (
    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
      {chips.map(c => (
        <Chip key={c.label} size="small" variant="outlined" color={c.color} label={c.label} />
      ))}
    </Stack>
  );
}

/** This page goes away while the node drains: Headlamp runs one replica. */
export function HeadlampMovesNote(props: { how: 'moves' | 'pinned'; node: string }) {
  return (
    <Alert severity="info" icon={<Icon icon="mdi:monitor-dashboard" />}>
      <AlertTitle>This page runs on {props.node}</AlertTitle>
      {props.how === 'pinned'
        ? 'Headlamp is pinned to this node: the page is gone for the whole hop of this node, until it is back.'
        : 'Headlamp runs one replica: the page is gone for a minute while its pod moves off this node.'}{' '}
      Answers for this node are best given before it starts. Meanwhile follow the upgrade from
      kubectl:
      <Stack spacing={0.5} sx={{ mt: 1 }}>
        {FOLLOW_COMMANDS.map(c => (
          <CommandLine key={c.command} {...c} />
        ))}
      </Stack>
    </Alert>
  );
}

export function NodeReadinessCard(props: {
  card: NodeCard;
  index: number;
  controls: (f: Finding) => FindingControls;
  approvals?: AnyApproval[];
  binding?: Binding;
}) {
  const { card } = props;
  return (
    <Box
      sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.75 }}
      role="region"
      aria-label={`Readiness of ${card.name}`}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        justifyContent="space-between"
        alignItems={{ sm: 'center' }}
        sx={{ mb: 1 }}
      >
        <Typography sx={{ fontWeight: 600 }}>
          {props.index + 1}. <Mono>{card.name}</Mono>
        </Typography>
        <SummaryChips summary={card.summary} />
      </Stack>
      <Stack spacing={1.25}>
        {card.headlamp && <HeadlampMovesNote how={card.headlamp} node={card.name} />}
        {card.findings.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Its drain and reboot move everything with at most a restart.
          </Typography>
        ) : (
          <FindingList
            findings={card.findings}
            node={card.name}
            controls={props.controls}
            approvals={props.approvals}
            binding={props.binding}
          />
        )}
        {!!card.truncated && (
          <Typography variant="caption" color="text.secondary">
            {card.truncated} more finding{card.truncated === 1 ? '' : 's'} left out of the report
            (the operator keeps 50 per node, those that only inform first).
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

// ------------------------------------------------------------- The report

/** The headline, the check time, Check again. */
export function ReadinessHeader(props: {
  view: ReadinessView;
  now: number;
  /** Check again, for a user who may patch the ClusterUpgrade. */
  onCheck?: () => void;
  checking: boolean;
  busy?: boolean;
}) {
  const { view } = props;
  const blocks = view.report.summary?.blocks ?? 0;
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1.5}
      justifyContent="space-between"
      alignItems={{ md: 'center' }}
    >
      <Box>
        <Typography sx={{ fontWeight: 600 }} color={blocks ? 'error' : 'text.primary'}>
          {view.headline}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          For {view.release ?? 'the next release'}
          {view.perHop
            ? ` in ${view.hops} hops: every hop drains and reboots every node, so it happens ${view.hops} times`
            : ''}
          {' · '}
          <Ago at={view.checkedAt} now={props.now} prefix="checked" />
          {' · '}
          {view.dryRun ? 'with dry-run evictions' : 'without dry-run evictions (a static check)'}
        </Typography>
      </Box>
      {props.onCheck && (
        <Button
          size="small"
          variant="outlined"
          onClick={props.onCheck}
          disabled={props.checking || props.busy}
          startIcon={
            props.checking ? (
              <CircularProgress size={14} />
            ) : (
              <Icon icon="mdi:clipboard-check-outline" />
            )
          }
          sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          {props.checking ? 'Checking…' : 'Check again'}
        </Button>
      )}
    </Stack>
  );
}

/**
 * The report: a note for another release, the Headlamp note, the cluster's
 * findings, then a card per node in upgrade order.
 */
export function ReadinessBody(props: {
  view: ReadinessView;
  controls: (node: string) => (f: Finding) => FindingControls;
  approvals?: AnyApproval[];
  binding?: Binding;
  /** The user may not list Headlamp's pods: say so once. */
  headlampUnknown?: boolean;
  /** The release asked about, for the note when the report is for another. */
  release?: string;
  onCheck?: () => void;
}) {
  const { view } = props;
  return (
    <Stack spacing={1.5}>
      {view.otherRelease && (
        <Alert severity="info">
          This report is for {view.otherRelease}, not {props.release}: k4all-operator checks the
          target release, or the newest one while no upgrade runs. What each drain does is the same;
          the number of hops can differ.{props.onCheck ? ' Check again for a fresh one.' : ''}
        </Alert>
      )}
      {props.headlampUnknown && (
        <Typography variant="body2" color="text.secondary">
          Where this page runs is unknown (your user may not list pods in the <Mono>headlamp</Mono>{' '}
          namespace): it is gone for a while when that node drains. Follow the upgrade then with{' '}
          <Mono>kubectl get clusterupgrade k4all -w</Mono>.
        </Typography>
      )}
      {view.cluster.length > 0 && (
        <Box>
          <Typography variant="overline" color="text.secondary">
            The whole cluster
          </Typography>
          <FindingList findings={view.cluster} node="" controls={() => ({ kind: 'view' })} />
        </Box>
      )}
      {view.nodes.map((card, i) => (
        <NodeReadinessCard
          key={card.name}
          card={card}
          index={i}
          controls={props.controls(card.name)}
          approvals={props.approvals}
          binding={props.binding}
        />
      ))}
      {view.nodes.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          The report lists no node.
        </Typography>
      )}
    </Stack>
  );
}

/** "Before you upgrade" on the page, above the release list. */
export function ReadinessPanel(props: {
  view: ReadinessView | null;
  now: number;
  onCheck?: () => void;
  checking: boolean;
  busy?: boolean;
  /** Fix controls for a node's findings; view only when absent. */
  controls?: (node: string) => (f: Finding) => FindingControls;
  approvals?: AnyApproval[];
  binding?: Binding;
  headlampUnknown?: boolean;
  /** What the panel says about choosing fixes (no upgrade runs: in the start review). */
  hint?: string;
}) {
  const { view } = props;
  return (
    <Panel title="Before you upgrade" icon="mdi:clipboard-list-outline" id="before-you-upgrade">
      {view ? (
        <Stack spacing={2}>
          <ReadinessHeader
            view={view}
            now={props.now}
            onCheck={props.onCheck}
            checking={props.checking}
            busy={props.busy}
          />
          {props.hint && (
            <Typography variant="body2" color="text.secondary">
              {props.hint}
            </Typography>
          )}
          <ReadinessBody
            view={view}
            controls={props.controls ?? (() => () => ({ kind: 'view' }))}
            approvals={props.approvals}
            binding={props.binding}
            headlampUnknown={props.headlampUnknown}
            onCheck={props.onCheck}
          />
        </Stack>
      ) : (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ sm: 'center' }}
        >
          <Typography variant="body2" color="text.secondary">
            k4all-operator has not reported a readiness check yet. It checks every 30 minutes while
            a release is available or an upgrade runs, and before each node's drain.
          </Typography>
          {props.onCheck && (
            <Button
              size="small"
              variant="outlined"
              onClick={props.onCheck}
              disabled={props.checking || props.busy}
              startIcon={props.checking ? <CircularProgress size={14} /> : undefined}
            >
              {props.checking ? 'Checking…' : 'Check now'}
            </Button>
          )}
        </Stack>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------ Live blockers

/** What holds a node now, with the fixes; read-only without onAnswer. */
export function NodeBlockers(props: {
  node: string;
  blockers: Finding[];
  approvals?: AnyApproval[];
  binding?: Binding;
  onAnswer?: (answer: Answer) => void;
  busy?: boolean;
}) {
  const onAnswer = props.onAnswer;
  return (
    <Box
      sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.5 }}
      role="region"
      aria-label={`What holds ${props.node}`}
    >
      <Typography variant="overline" color="text.secondary">
        What holds <Mono>{props.node}</Mono> now
      </Typography>
      <FindingList
        findings={props.blockers}
        node={props.node}
        approvals={props.approvals}
        binding={props.binding}
        controls={() => (onAnswer ? { kind: 'act', onAnswer, busy: props.busy } : { kind: 'view' })}
      />
    </Box>
  );
}

/** The selection controls of the start review, per node. */
export function selectControls(
  selection: Selection,
  setChoice: (key: string, choice: Choice) => void
): (node: string) => (f: Finding) => FindingControls {
  return node => f =>
    answerable(f)
      ? {
          kind: 'select',
          choice: selection[findingKey(node, f)],
          onChoice: choice => setChoice(findingKey(node, f), choice),
        }
      : { kind: 'view' };
}

// --------------------------------------------------------- What k4all changed

/** status.remediations: what k4all changed for a drain and puts back; Put back now per record. */
export function RemediationsTable(props: {
  records: RemediationRecordStatus[];
  now: number;
  /** Put back now, for a user who may patch the ClusterUpgrade; absent: no button. */
  onRestore?: (record: RemediationRecordStatus) => void;
  busy?: boolean;
}) {
  const [confirm, setConfirm] = React.useState<RemediationRecordStatus | null>(null);
  const entry = confirm ? catalogEntry(confirm.remediation) : undefined;
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="What k4all changed">
        <TableHead>
          <TableRow>
            <TableCell>Object</TableCell>
            <TableCell>Fix</TableCell>
            <TableCell>Node</TableCell>
            <TableCell>Hop</TableCell>
            <TableCell>By</TableCell>
            <TableCell sx={{ minWidth: 220 }}>What was set</TableCell>
            <TableCell>When</TableCell>
            <TableCell>Phase</TableCell>
            {props.onRestore && <TableCell />}
          </TableRow>
        </TableHead>
        <TableBody>
          {props.records.map(r => {
            const phase = RECORD_PHASE[r.phase] ?? { label: r.phase, tone: 'neutral' as const };
            return (
              <TableRow key={r.id}>
                <TableCell>
                  <Mono>{refText(r.target)}</Mono>
                </TableCell>
                <TableCell>
                  <Tooltip title={r.id}>
                    <span>{remediationTitle(r.remediation)}</span>
                  </Tooltip>
                </TableCell>
                <TableCell>{r.node}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>{r.hop}</TableCell>
                <TableCell>{r.by === 'auto' ? 'auto' : 'approval'}</TableCell>
                <TableCell>
                  <Typography
                    variant="body2"
                    color={r.phase === 'Failed' ? 'error' : 'text.secondary'}
                  >
                    {r.message ?? ''}
                  </Typography>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Ago at={r.appliedAt} now={props.now} />
                </TableCell>
                <TableCell>
                  <TonePill tone={phase.tone} busy={phase.busy} label={phase.label} />
                </TableCell>
                {props.onRestore && (
                  <TableCell>
                    {canRestore(r.phase) && (
                      <Button
                        size="small"
                        disabled={props.busy}
                        onClick={() => setConfirm(r)}
                        aria-label={`Put back ${r.id} now`}
                      >
                        Put back now
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Put back now?</DialogTitle>
        <DialogContent dividers>
          {confirm && (
            <Stack spacing={1.5}>
              <Typography>
                k4all-operator restores what it changed on <Mono>{refText(confirm.target)}</Mono>{' '}
                for the drain of <Mono>{confirm.node}</Mono> now, without waiting for that node to
                be back: use it for a node that is not coming back.
              </Typography>
              {entry && (
                <Typography color="text.secondary">
                  {remediationTitle(confirm.remediation)}: {entry.does}
                </Typography>
              )}
              <Typography color="text.secondary">
                A field someone changed since k4all set it is left alone (the record ends
                &quot;Changed by someone else&quot;). A stopped VM starts where it can.
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              const r = confirm;
              setConfirm(null);
              if (r && props.onRestore) {
                props.onRestore(r);
              }
            }}
          >
            Put back now
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/** "What k4all changed", as a panel. */
export function RemediationsPanel(props: {
  records: RemediationRecordStatus[];
  now: number;
  onRestore?: (record: RemediationRecordStatus) => void;
  busy?: boolean;
  /** What the records are for: "this upgrade", "the node-settings rollout". */
  what: string;
}) {
  return (
    <Panel title="What k4all changed" icon="mdi:backup-restore">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Fixes k4all applied for the drains of {props.what}, on objects it does not own, and puts
        back once each node is done. The durable copy is on each object (annotation{' '}
        <Mono>k4all.magesgate.com/remediations</Mono>).
      </Typography>
      <RemediationsTable
        records={props.records}
        now={props.now}
        onRestore={props.onRestore}
        busy={props.busy}
      />
    </Panel>
  );
}
