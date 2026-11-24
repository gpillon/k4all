/*
 * /k4all/settings/nodes (k4all v2.7.0): kubelet settings, hugepages and
 * IOMMU for every node; before saving, the plan (which nodes drain and
 * restart or reboot, in which order); then the rollout from status.nodes,
 * with Pause / Resume (spec.nodes.rollout.paused, applied at once).
 */

import { Box, Grid, Stack } from '@mui/material';
import { useSnackbar } from 'notistack';
import React from 'react';
import { useOperatorNode } from '../../api/clusterObjects';
import { K4allData, useK4allData } from '../../api/hooks';
import { setNodeRolloutPaused } from '../../api/k4allApi';
import { classifyError } from '../../model/errors';
import { nodeSettingsIssues, rolloutPlan, rolloutView } from '../../model/nodeSettings';
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
  const editor = useSettingsEditor(data);
  const operatorNode = useOperatorNode();
  const { enqueueSnackbar } = useSnackbar();
  const [pausing, setPausing] = React.useState(false);
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
          />
        )}
        {editor.dirty && <PlanView plan={plan} />}
        <Grid container spacing={2}>
          <Grid item xs={12} lg={6}>
            <KubeletSection {...sectionProps} />
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
