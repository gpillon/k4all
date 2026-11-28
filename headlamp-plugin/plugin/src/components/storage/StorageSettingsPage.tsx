/*
 * /k4all/settings/storage (k4all v2.7.0): the Rook switch (kept while a
 * CephCluster exists: the reason and the steps), the creation inputs
 * (deviceFilter, smallCluster) until the cluster exists, then "created,
 * manage it in Cairn", the RookReady condition, and the teardown note (D24:
 * k4all never wipes disks). From k4all v2.7.2 (operator v0.7.0): named OSD
 * devices, the Ceph CSI image (#csi-image), the crash collector of the
 * CephCluster itself (#crash-collector), monitoring (#monitoring) and
 * CephFS (#cephfs). Cairn links here for what k4all owns.
 */

import { Box, Grid, Typography } from '@mui/material';
import React from 'react';
import { useAgentInventories, useCephClusters, useStorageClasses } from '../../api/clusterObjects';
import { K4allData, useK4allData } from '../../api/hooks';
import {
  setCrashCollector,
  useCanPatchCephClusters,
  usePrometheusOperatorApis,
} from '../../api/rookObjects';
import { findCondition } from '../../model/health';
import { csiIssues, monitoringIssues } from '../../model/rookSettings';
import { rookIssues, rookView, schedulableNodes } from '../../model/storage';
import { CephClusterLike, CONDITION_ROOK_READY } from '../../model/types';
import { hasErrors, Issue, validateSettings } from '../../model/validation';
import { useHashScroll } from '../common/nav';
import { K4allGate, ReadOnlyNotice } from '../common/states';
import { Mono, PageHeader } from '../common/ui';
import { ReviewDialog } from '../review/ReviewDialog';
import { StaleDraftNotice, UnsavedBar, useSettingsEditor } from '../settings/editorShell';
import { FeatureCard, ROOK_FEATURE } from '../settings/FeaturesSection';
import { CapabilityNotice } from '../settings/settingsLinks';
import {
  CephFsPanel,
  CrashCollectorPanel,
  CsiImagePanel,
  MonitoringPanel,
  RookReadyAlert,
} from './rookSections';
import { CephSection, TeardownPanel } from './storageSections';

const keyOf = (c: CephClusterLike) => `${c.metadata.namespace}/${c.metadata.name}`;

/**
 * The CephClusters as polled, with the object a crash collector patch
 * returned shown until the next poll brings a newer one.
 */
function useCephClustersWithWrites() {
  const ceph = useCephClusters();
  const [written, setWritten] = React.useState<
    Record<string, { readRV?: string; obj: CephClusterLike }>
  >({});
  const polled = ceph.value ?? [];
  const clusters = polled.map(c => {
    const w = written[keyOf(c)];
    return w && w.readRV === c.metadata.resourceVersion ? w.obj : c;
  });
  const set = async (c: CephClusterLike, on: boolean) => {
    const readRV = polled.find(p => keyOf(p) === keyOf(c))?.metadata.resourceVersion;
    const obj = await setCrashCollector(c, on);
    setWritten(prev => ({ ...prev, [keyOf(c)]: { readRV, obj } }));
  };
  return { ceph, clusters, set };
}

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
  const { ceph, clusters, set: setCrash } = useCephClustersWithWrites();
  const created = clusters.length > 0;
  const inventories = useAgentInventories(
    !!editor.state.base && editor.caps.rookStorage && !created && ceph.value !== null
  );
  const rookOn = editor.draft.features?.rook?.enabled === true;
  const showMore = !!editor.state.base && (rookOn || created);
  const apis = usePrometheusOperatorApis(showMore && editor.caps.rookOptions);
  const storageClasses = useStorageClasses();
  const canPatch = useCanPatchCephClusters(clusters);
  useHashScroll(!!editor.state.base);
  if (!editor.state.base) {
    return null;
  }
  const { caps, draft, base } = editor;
  const nodes = schedulableNodes(data.nodes);
  const issues: Issue[] = [
    ...validateSettings(draft),
    ...rookIssues(draft, { nodes: data.nodes, created }),
    ...csiIssues(draft, data.nodes),
    ...monitoringIssues(draft, apis.value),
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
      {caps.rookStorage && (
        <CapabilityNotice
          caps={caps}
          id="rookOptions"
          what="Named devices, the Ceph CSI image, monitoring and CephFS"
        />
      )}
      <RookReadyAlert condition={ready} />
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
            nodeNames={data.nodes.map(n => n.metadata.name).sort()}
          />
        </Grid>
        {showMore ? (
          <>
            <Grid item xs={12} md={6}>
              <CsiImagePanel {...sectionProps} nodes={data.nodes} />
            </Grid>
            <Grid item xs={12} md={6}>
              <CrashCollectorPanel clusters={clusters} canPatch={canPatch} onSet={setCrash} />
            </Grid>
            <Grid item xs={12} md={6}>
              <MonitoringPanel
                {...sectionProps}
                apis={apis.value}
                apisError={apis.error?.message ?? null}
              />
            </Grid>
            <Grid item xs={12} md={6}>
              <CephFsPanel {...sectionProps} storageClasses={storageClasses.value} />
            </Grid>
          </>
        ) : (
          <Grid item xs={12}>
            <Typography variant="body2" color="text.secondary">
              With Rook on, this page also sets the Ceph CSI image, monitoring and CephFS, and shows
              the crash collector.
            </Typography>
          </Grid>
        )}
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
