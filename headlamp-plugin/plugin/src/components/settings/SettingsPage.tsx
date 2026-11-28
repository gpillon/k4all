import { Icon } from '@iconify/react';
import { Badge, Box, Chip, Stack, Tab, Tabs } from '@mui/material';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { K4allData, useK4allData } from '../../api/hooks';
import { ChangeItem } from '../../model/changes';
import { activeIngress } from '../../model/settings';
import { hasErrors, Issue, validateSettings } from '../../model/validation';
import { K4allGate, ReadOnlyNotice } from '../common/states';
import { Mono, PageHeader } from '../common/ui';
import { ReviewDialog } from '../review/ReviewDialog';
import { StaleDraftNotice, UnsavedBar, useSettingsEditor } from './editorShell';
import { FeaturesSection } from './FeaturesSection';
import { IngressSection } from './IngressSection';
import { InstallTimeSection } from './InstallTimeSection';
import { NetworkingSection } from './NetworkingSection';
import { NginxIngressesPanel } from './NginxIngresses';
import { PodNetworkOverlapBanner, SettingsPagesLinks } from './settingsLinks';
import { UpgradesSection } from './UpgradesSection';

const TABS = [
  { id: 'features', label: 'Features', icon: 'mdi:puzzle-outline', prefixes: ['features.'] },
  { id: 'ingress', label: 'Ingress', icon: 'mdi:routes', prefixes: ['ingress.'] },
  { id: 'networking', label: 'Networking', icon: 'mdi:lan-connect', prefixes: ['networking.'] },
  { id: 'upgrades', label: 'Upgrades', icon: 'mdi:update', prefixes: ['upgrades.'] },
  { id: 'install', label: 'Install-time', icon: 'mdi:lock-outline', prefixes: [] as string[] },
] as const;

type TabId = (typeof TABS)[number]['id'];

function countFor(tab: (typeof TABS)[number], items: ChangeItem[]): number {
  return items.filter(i => tab.prefixes.some(p => i.key.startsWith(p))).length;
}

export function SettingsPage() {
  const data = useK4allData();
  return (
    <Box sx={{ p: { xs: 1, md: 3 }, pb: 12 }}>
      <K4allGate data={data}>{data.cc && <SettingsEditor data={data} />}</K4allGate>
    </Box>
  );
}

function SettingsEditor({ data }: { data: K4allData }) {
  const history = useHistory();
  const location = useLocation();
  const editor = useSettingsEditor(data);
  const { state, flow, caps, components, readOnly } = editor;

  const params = new URLSearchParams(location.search);
  const tab = (TABS.find(t => t.id === params.get('tab'))?.id ?? 'features') as TabId;
  const setTab = (id: TabId) => {
    const next = new URLSearchParams(location.search);
    next.set('tab', id);
    history.replace({ search: next.toString() });
  };

  if (!state.base) {
    return null;
  }

  const base = editor.base;
  const draft = editor.draft;
  const nodeIPs = data.nodes
    .map(n => n.status?.addresses?.find(a => a.type === 'InternalIP')?.address)
    .filter((ip): ip is string => !!ip);
  const ingress = activeIngress(data.rm?.spec?.components, base);
  const issues: Issue[] = validateSettings(draft, { nodeIPs, ingress });
  const blocking = hasErrors(issues);
  const items = editor.items;
  const sectionProps = {
    draft,
    base,
    update: editor.update,
    disabled: editor.disabled,
    issues,
    status: editor.status,
    caps,
  };

  return (
    <>
      <PageHeader
        icon="mdi:tune-variant"
        title="Cluster settings"
        subtitle={
          <>
            ClusterConfig <Mono>{state.base.metadata.name}</Mono>
            {state.base.metadata.generation !== undefined && (
              <> · generation {state.base.metadata.generation}</>
            )}
          </>
        }
        actions={
          <Chip
            size="small"
            variant="outlined"
            icon={<Icon icon="mdi:lightning-bolt" />}
            label="Changes are applied by k4all-operator"
          />
        }
      />
      <ReadOnlyNotice show={readOnly} what="the cluster settings" />
      <PodNetworkOverlapBanner status={editor.status} />
      <StaleDraftNotice editor={editor} />
      <SettingsPagesLinks caps={caps} />

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          allowScrollButtonsMobile
          aria-label="Settings sections"
        >
          {TABS.map(t => {
            const n = countFor(t, items);
            return (
              <Tab
                key={t.id}
                value={t.id}
                iconPosition="start"
                icon={<Icon icon={t.icon} width={18} height={18} />}
                label={
                  <Badge
                    color="primary"
                    badgeContent={n}
                    invisible={n === 0}
                    sx={{ '& .MuiBadge-badge': { right: -12 } }}
                  >
                    {t.label}
                  </Badge>
                }
                sx={{ minHeight: 48, pr: 3 }}
              />
            );
          })}
        </Tabs>
      </Box>

      {tab === 'features' && (
        <FeaturesSection
          {...sectionProps}
          components={components}
          statuses={data.rm?.status?.components}
        />
      )}
      {tab === 'ingress' && (
        <Stack spacing={2}>
          <IngressSection {...sectionProps} controller={ingress} />
          {ingress === 'traefik' && <NginxIngressesPanel />}
        </Stack>
      )}
      {tab === 'networking' && (
        <NetworkingSection {...sectionProps} nodeConfigs={data.nodeConfigs} />
      )}
      {tab === 'upgrades' && <UpgradesSection {...sectionProps} />}
      {tab === 'install' && <InstallTimeSection spec={base} caps={caps} />}

      <UnsavedBar editor={editor} blocking={blocking} />

      <ReviewDialog
        flow={flow}
        title={`Apply changes to ${state.base.metadata.name}`}
        warnings={issues.filter(i => i.severity === 'warning')}
      />
    </>
  );
}
