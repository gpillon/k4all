/*
 * /k4all/settings/virtualization (k4all v2.7.0): the virt switch with the
 * uninstall guard, emulation, the KubeVirt gates (#feature-gates), the VM
 * state StorageClass (#vm-state), Hangar's node agent and the metadata
 * service (#metadata). Hangar links here for the settings k4all owns.
 */

import { Box, Chip, Grid, Stack } from '@mui/material';
import { useSnackbar } from 'notistack';
import React from 'react';
import { useKubeVirt, useStorageClasses, useStorageProfiles } from '../../api/clusterObjects';
import { K4allData, useK4allData } from '../../api/hooks';
import { gateIssues, kubevirtVersion } from '../../model/gates';
import { findCondition } from '../../model/health';
import { CONDITION_KUBEVIRT_SETTINGS, CONDITION_METADATA_SERVICE } from '../../model/types';
import { hasErrors, Issue, validateSettings } from '../../model/validation';
import { metadataIssues, vmStateIssues } from '../../model/virtSettings';
import { useHashScroll } from '../common/nav';
import { K4allGate, ReadOnlyNotice } from '../common/states';
import { Mono, PageHeader } from '../common/ui';
import { ReviewDialog } from '../review/ReviewDialog';
import { StaleDraftNotice, UnsavedBar, useSettingsEditor } from '../settings/editorShell';
import { FeatureCard, FEATURES } from '../settings/FeaturesSection';
import { CapabilityNotice } from '../settings/settingsLinks';
import {
  ConditionAlert,
  GatesSection,
  HangarSection,
  MetadataSection,
  VmStateSection,
} from './sections';

export function VirtualizationPage() {
  const data = useK4allData();
  return (
    <Box sx={{ p: { xs: 1, md: 3 }, pb: 12 }}>
      <K4allGate data={data}>{data.cc && <VirtualizationEditor data={data} />}</K4allGate>
    </Box>
  );
}

function VirtualizationEditor({ data }: { data: K4allData }) {
  const editor = useSettingsEditor(data);
  const { enqueueSnackbar } = useSnackbar();
  const kv = useKubeVirt();
  const storageClasses = useStorageClasses();
  const profiles = useStorageProfiles();
  useHashScroll(!!editor.state.base);
  if (!editor.state.base) {
    return null;
  }
  const { caps, draft, base } = editor;
  const cr = kv.cr;
  const releaseVersion = data.rm?.spec?.components?.kubevirt?.version;
  const objects = {
    kv: cr,
    storageClasses: storageClasses.value ?? [],
    profiles: profiles.value ?? [],
  };
  const issues: Issue[] = [
    ...validateSettings(draft),
    ...gateIssues(draft, { kv: cr, version: releaseVersion }),
    ...vmStateIssues(draft, objects),
    ...metadataIssues(draft),
  ];
  const blocking = hasErrors(issues);
  const sectionProps = {
    draft,
    base,
    update: editor.update,
    disabled: editor.disabled,
    issues,
    status: editor.status,
    caps,
  };
  // The v2.7.0 fields exist from operator v0.6.0: read-only before.
  const newProps = { ...sectionProps, disabled: editor.disabled || !caps.virtSettings };
  const conditions = editor.status?.conditions;
  const running = kubevirtVersion(cr);

  return (
    <>
      <PageHeader
        icon="mdi:monitor-multiple"
        title="Virtualization"
        subtitle={
          <>
            KubeVirt, CDI and the Hangar console · ClusterConfig{' '}
            <Mono>{editor.state.base.metadata.name}</Mono>
          </>
        }
        actions={
          <Chip
            size="small"
            variant="outlined"
            label={running ? `KubeVirt ${running}` : 'KubeVirt not running'}
          />
        }
      />
      <ReadOnlyNotice show={editor.readOnly} what="the cluster settings" />
      <StaleDraftNotice editor={editor} />
      <CapabilityNotice
        caps={caps}
        id="virtSettings"
        what="KubeVirt gates, VM state, the Hangar node agent and the metadata service"
      />
      <ConditionAlert
        condition={findCondition(conditions, CONDITION_KUBEVIRT_SETTINGS)}
        title="KubeVirt settings"
      />
      <Stack spacing={2}>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <FeatureCard
              {...sectionProps}
              def={FEATURES[0]}
              components={editor.components}
              statuses={data.rm?.status?.components}
            />
          </Grid>
          <Grid item xs={12} md={6}>
            <HangarSection
              {...newProps}
              components={editor.components}
              statuses={data.rm?.status?.components}
            />
          </Grid>
        </Grid>
        <GatesSection
          {...newProps}
          kv={cr}
          releaseVersion={releaseVersion}
          onAlso={gates =>
            enqueueSnackbar(
              `Also turned ${gates.join(', ')} off: KubeVirt cannot run both hot-plug gates.`,
              {
                variant: 'info',
              }
            )
          }
        />
        <VmStateSection
          {...newProps}
          kv={cr}
          storageClasses={objects.storageClasses}
          profiles={objects.profiles}
        />
        <ConditionAlert
          condition={findCondition(conditions, CONDITION_METADATA_SERVICE)}
          title="Metadata service"
        />
        <MetadataSection {...newProps} />
      </Stack>
      <UnsavedBar editor={editor} blocking={blocking} />
      <ReviewDialog
        flow={editor.flow}
        title={`Apply changes to ${editor.state.base.metadata.name}`}
        warnings={issues.filter(i => i.severity === 'warning')}
      />
    </>
  );
}
