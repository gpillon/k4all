/*
 * /k4all/settings/storage (k4all v2.7.0): the Rook switch (kept while a
 * CephCluster exists: the reason and the steps), the creation inputs
 * (deviceFilter, smallCluster) until the cluster exists, then "created,
 * manage it in Cairn", the RookReady condition, and the teardown note (D24:
 * k4all never wipes disks). Cairn links here for what k4all owns.
 */

import { Alert, AlertTitle, Box, Grid } from '@mui/material';
import React from 'react';
import { useAgentInventories, useCephClusters } from '../../api/clusterObjects';
import { K4allData, useK4allData } from '../../api/hooks';
import { findCondition } from '../../model/health';
import { rookIssues, rookView, schedulableNodes } from '../../model/storage';
import { CONDITION_ROOK_READY } from '../../model/types';
import { hasErrors, Issue, validateSettings } from '../../model/validation';
import { K4allGate, ReadOnlyNotice } from '../common/states';
import { Mono, PageHeader } from '../common/ui';
import { ReviewDialog } from '../review/ReviewDialog';
import { StaleDraftNotice, UnsavedBar, useSettingsEditor } from '../settings/editorShell';
import { FeatureCard, ROOK_FEATURE } from '../settings/FeaturesSection';
import { CapabilityNotice } from '../settings/settingsLinks';
import { CephSection, TeardownPanel } from './storageSections';

export function StorageSettingsPage() {
  const data = useK4allData();
  return (
    <Box sx={{ p: { xs: 1, md: 3 }, pb: 12 }}>
      <K4allGate data={data}>{data.cc && <StorageEditor data={data} />}</K4allGate>
    </Box>
  );
}

function StorageEditor({ data }: { data: K4allData }) {
  const editor = useSettingsEditor(data);
  const ceph = useCephClusters();
  const clusters = ceph.value ?? [];
  const created = clusters.length > 0;
  const inventories = useAgentInventories(
    !!editor.state.base && editor.caps.rookStorage && !created && ceph.value !== null
  );
  if (!editor.state.base) {
    return null;
  }
  const { caps, draft, base } = editor;
  const nodes = schedulableNodes(data.nodes);
  const issues: Issue[] = [
    ...validateSettings(draft),
    ...rookIssues(draft, { nodes: data.nodes, created }),
  ];
  const blocking = hasErrors(issues);
  const sectionProps = {
    draft,
    base,
    update: editor.update,
    disabled: editor.disabled || !caps.rookStorage,
    issues,
    status: editor.status,
    caps,
  };
  const view = rookView({ spec: draft, cephClusters: clusters, rm: data.rm, nodes: data.nodes });
  const ready = findCondition(editor.status?.conditions, CONDITION_ROOK_READY);

  return (
    <>
      <PageHeader
        icon="mdi:database-outline"
        title="Storage"
        subtitle={
          <>
            Rook/Ceph with the Cairn console · ClusterConfig{' '}
            <Mono>{editor.state.base.metadata.name}</Mono>
          </>
        }
      />
      <ReadOnlyNotice show={editor.readOnly} what="the cluster settings" />
      <StaleDraftNotice editor={editor} />
      <CapabilityNotice caps={caps} id="rookStorage" what="Rook/Ceph storage" />
      {ready && ready.message && (
        <Alert
          severity={
            ready.status === 'True' ? 'success' : ready.status === 'False' ? 'warning' : 'info'
          }
          sx={{ mb: 2 }}
        >
          <AlertTitle>RookReady{ready.reason ? `: ${ready.reason}` : ''}</AlertTitle>
          <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
            {ready.message}
          </Box>
        </Alert>
      )}
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <FeatureCard
            {...sectionProps}
            def={ROOK_FEATURE}
            components={editor.components}
            statuses={data.rm?.status?.components}
            ready={ready?.status === 'True'}
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TeardownPanel view={view} />
        </Grid>
        <Grid item xs={12}>
          <CephSection
            {...sectionProps}
            view={view}
            clusters={clusters}
            nodes={nodes}
            inventories={inventories.value}
          />
        </Grid>
      </Grid>
      <UnsavedBar editor={editor} blocking={blocking} />
      <ReviewDialog
        flow={editor.flow}
        title={`Apply storage settings to ${editor.state.base.metadata.name}`}
        warnings={issues.filter(i => i.severity === 'warning')}
      />
    </>
  );
}
