/*
 * /k4all/settings/nodes (k4all v2.7.0): kubelet settings, hugepages and
 * IOMMU for every node; before saving, the plan (which nodes drain and
 * restart or reboot, in which order); then the rollout from status.nodes,
 * with Pause / Resume (spec.nodes.rollout.paused, applied at once). With
 * Virtualization on it reads the KubeVirt CR, as the Virtualization page
 * does, to say when the static CPU manager lacks KubeVirt's CPUManager gate
 * (0.2.1, k4all#111). With k4all-operator v0.7.0 (0.3.0) the rollout lists
 * what holds each node's drain with its fixes (Apply fix and Accept write
 * spec.nodes.rollout.approvals at once, for status.nodes.settingsHash),
 * and what it changed.
 */

import { Box, Grid, Stack } from '@mui/material';
import { useSnackbar } from 'notistack';
import React from 'react';
import { useKubeletPrior, useKubeVirt, useOperatorNode } from '../../api/clusterObjects';
import { K4allData, useK4allData, useNow } from '../../api/hooks';
import { addNodeRolloutApproval, setNodeRolloutPaused } from '../../api/k4allApi';
import { classifyError } from '../../model/errors';
import { cpuManagerGateMissing } from '../../model/gates';
import { nodeSettingsIssues, rolloutPlan, rolloutView } from '../../model/nodeSettings';
import { Answer, refText, remediationTitle, toApproval } from '../../model/readiness';
import { NodeRolloutApproval } from '../../model/types';
import { hasErrors, Issue, validateSettings } from '../../model/validation';
import { K4allGate, ReadOnlyNotice } from '../common/states';
import { Mono, PageHeader } from '../common/ui';
import { ReviewDialog } from '../review/ReviewDialog';
import { StaleDraftNotice, UnsavedBar, useSettingsEditor } from '../settings/editorShell';
import { CapabilityNotice } from '../settings/settingsLinks';
import { KubeletSection, MemorySection, PlanView, RolloutPanel } from './nodeSettingsSections';

export function NodeSettingsPage() {
  const data = useK4allData();
  return (
    <Box sx={{ p: { xs: 1, md: 3 }, pb: 12 }}>
      <K4allGate data={data}>{data.cc && <NodeSettingsEditor data={data} />}</K4allGate>
    </Box>
  );
}

function NodeSettingsEditor({ data }: { data: K4allData }) {
  const kubeletPrior = useKubeletPrior();
  const editor = useSettingsEditor(data, { kubeletPrior });
  const operatorNode = useOperatorNode();
  // Only with Virtualization on: no KubeVirt CR to read otherwise.
  const kv = useKubeVirt(data.cc?.spec?.features?.virt?.enabled === true);
  const { enqueueSnackbar } = useSnackbar();
  const [pausing, setPausing] = React.useState(false);
  const now = useNow(30000);
  if (!editor.state.base) {
    return null;
  }
  const { caps, draft, base } = editor;
  const issues: Issue[] = [
    ...validateSettings(draft),
    ...nodeSettingsIssues(draft, { nodes: data.nodes }),
  ];
  const blocking = hasErrors(issues);
  const sectionProps = {
    draft,
    base,
    update: editor.update,
    disabled: editor.disabled || !caps.nodeSettings,
    issues,
    status: editor.status,
    caps,
    nodes: data.nodes,
  };
  const planFor = (b: typeof base, d: typeof draft) =>
    rolloutPlan({
      base: b,
      draft: d,
      nodes: data.nodes,
      nodeConfigs: data.nodeConfigs,
      operatorNode,
    });
  const plan = planFor(base, draft);
  const latest = editor.state.latest ?? editor.state.base;
  const view = rolloutView(latest);
  const hasRollout = !!latest.status?.nodes || !!latest.spec?.nodes;

  const pause = async (paused: boolean) => {
    setPausing(true);
    try {
      await setNodeRolloutPaused(latest.metadata.name, paused);
      enqueueSnackbar(
        paused
          ? 'Rollout paused: the node in progress finishes, then it stops.'
          : 'Rollout resumed.',
        { variant: 'success' }
      );
    } catch (err) {
      const e = classifyError(err);
      enqueueSnackbar(`${e.hint} ${e.message}`, { variant: 'error' });
    } finally {
      setPausing(false);
    }
  };

  const answer = async (a: Answer) => {
    const hash = view.settingsHash;
    if (!hash) {
      return;
    }
    setPausing(true);
    try {
      const approval = toApproval(a, { settingsHash: hash }) as NodeRolloutApproval;
      await addNodeRolloutApproval(latest.metadata.name, approval);
      const what = `${remediationTitle(a.remediation)} for ${refText(a.target)}`;
      enqueueSnackbar(
        a.decision === 'Accept'
          ? `Accepted: the drain of ${a.node ?? 'the node'} goes on without a fix (${what}).`
          : `Approved: ${what}. k4all-operator applies it before the drain.`,
        { variant: 'success' }
      );
    } catch (err) {
      const e = classifyError(err);
      enqueueSnackbar(`${e.hint} ${e.message}`, { variant: 'error' });
    } finally {
      setPausing(false);
    }
  };
  const canAnswer = !editor.disabled && caps.upgradeReadiness;

  return (
    <>
      <PageHeader
        icon="mdi:server-outline"
        title="Node settings"
        subtitle={
          <>
            The same on every node, rolled out one node at a time · ClusterConfig{' '}
            <Mono>{editor.state.base.metadata.name}</Mono>
          </>
        }
      />
      <ReadOnlyNotice show={editor.readOnly} what="the cluster settings" />
      <StaleDraftNotice editor={editor} />
      <CapabilityNotice caps={caps} id="nodeSettings" what="Node settings" />
      <Stack spacing={2}>
        {hasRollout && (
          <RolloutPanel
            view={view}
            canPause={!editor.disabled && caps.nodeSettings}
            busy={pausing}
            onPause={pause}
            readiness={caps.upgradeReadiness}
            approvals={latest.spec?.nodes?.rollout?.approvals}
            onAnswer={canAnswer ? answer : undefined}
            now={now}
          />
        )}
        {editor.dirty && <PlanView plan={plan} />}
        <Grid container spacing={2}>
          <Grid item xs={12} lg={6}>
            <KubeletSection
              {...sectionProps}
              kubeletPrior={kubeletPrior}
              cpuManagerGateMissing={cpuManagerGateMissing(draft, {
                kv: kv.cr,
                version: data.rm?.spec?.components?.kubevirt?.version,
              })}
            />
          </Grid>
          <Grid item xs={12} lg={6}>
            <MemorySection {...sectionProps} />
          </Grid>
        </Grid>
      </Stack>
      <UnsavedBar editor={editor} blocking={blocking} />
      <ReviewDialog
        flow={editor.flow}
        title={`Apply node settings to ${editor.state.base.metadata.name}`}
        warnings={issues.filter(i => i.severity === 'warning')}
        extra={review => (
          <PlanView plan={planFor(review.base.spec ?? {}, review.draft)} title="After saving" />
        )}
      />
    </>
  );
}
