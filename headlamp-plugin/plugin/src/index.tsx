/*
 * k4all Headlamp plugin: manage a k4all cluster (ClusterConfig, ReleaseManifest,
 * ClusterUpgrade) from the Headlamp UI.
 */

import {
  DetailsViewSectionProps,
  registerDetailsViewSection,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { K4allLive } from './api/live';
import { ComponentDetailPage } from './components/components/ComponentDetailPage';
import { ComponentsPage } from './components/components/ComponentsPage';
import { NodeSection } from './components/nodes/NodeSection';
import { NodeSettingsPage } from './components/nodes/NodeSettingsPage';
import { OverviewPage } from './components/overview/OverviewPage';
import { SettingsPage } from './components/settings/SettingsPage';
import { StorageSettingsPage } from './components/storage/StorageSettingsPage';
import { UpgradesPage } from './components/upgrades/UpgradesPage';
import { VirtualizationPage } from './components/virtualization/VirtualizationPage';
import { registerIcons } from './icons';
import { NodeLike } from './model/types';

registerIcons();

registerSidebarEntry({
  parent: null,
  name: 'k4all',
  label: 'k4all',
  url: '/k4all',
  icon: 'mdi:hexagon-multiple-outline',
});

registerSidebarEntry({ parent: 'k4all', name: 'k4all-overview', label: 'Overview', url: '/k4all' });
registerSidebarEntry({
  parent: 'k4all',
  name: 'k4all-upgrades',
  label: 'Upgrades',
  url: '/k4all/upgrades',
});
registerSidebarEntry({
  parent: 'k4all',
  name: 'k4all-settings',
  label: 'Settings',
  url: '/k4all/settings',
});
// The k4all v2.7.0 settings pages; Hangar and Cairn link to these paths.
registerSidebarEntry({
  parent: 'k4all',
  name: 'k4all-settings-virtualization',
  label: 'Virtualization',
  url: '/k4all/settings/virtualization',
});
registerSidebarEntry({
  parent: 'k4all',
  name: 'k4all-settings-nodes',
  label: 'Node settings',
  url: '/k4all/settings/nodes',
});
registerSidebarEntry({
  parent: 'k4all',
  name: 'k4all-settings-storage',
  label: 'Storage',
  url: '/k4all/settings/storage',
});
registerSidebarEntry({
  parent: 'k4all',
  name: 'k4all-components',
  label: 'Components',
  url: '/k4all/components',
});

registerRoute({
  path: '/k4all',
  exact: true,
  name: 'k4all-overview',
  sidebar: 'k4all-overview',
  component: () => (
    <K4allLive>
      <OverviewPage />
    </K4allLive>
  ),
});

registerRoute({
  path: '/k4all/upgrades',
  exact: true,
  name: 'k4all-upgrades',
  sidebar: 'k4all-upgrades',
  component: () => (
    <K4allLive>
      <UpgradesPage />
    </K4allLive>
  ),
});

registerRoute({
  path: '/k4all/settings',
  exact: true,
  name: 'k4all-settings',
  sidebar: 'k4all-settings',
  component: () => (
    <K4allLive>
      <SettingsPage />
    </K4allLive>
  ),
});

registerRoute({
  path: '/k4all/settings/virtualization',
  exact: true,
  name: 'k4all-settings-virtualization',
  sidebar: 'k4all-settings-virtualization',
  component: () => (
    <K4allLive>
      <VirtualizationPage />
    </K4allLive>
  ),
});

registerRoute({
  path: '/k4all/settings/nodes',
  exact: true,
  name: 'k4all-settings-nodes',
  sidebar: 'k4all-settings-nodes',
  component: () => (
    <K4allLive>
      <NodeSettingsPage />
    </K4allLive>
  ),
});

registerRoute({
  path: '/k4all/settings/storage',
  exact: true,
  name: 'k4all-settings-storage',
  sidebar: 'k4all-settings-storage',
  component: () => (
    <K4allLive>
      <StorageSettingsPage />
    </K4allLive>
  ),
});

registerRoute({
  path: '/k4all/components',
  exact: true,
  name: 'k4all-components',
  sidebar: 'k4all-components',
  component: () => (
    <K4allLive>
      <ComponentsPage />
    </K4allLive>
  ),
});

registerRoute({
  path: '/k4all/components/:name',
  exact: true,
  name: 'k4all-component',
  sidebar: 'k4all-components',
  component: () => (
    <K4allLive>
      <ComponentDetailPage />
    </K4allLive>
  ),
});

registerDetailsViewSection(({ resource }: DetailsViewSectionProps) => {
  if (resource?.kind !== 'Node') {
    return null;
  }
  return <NodeSection node={resource.jsonData as NodeLike} />;
});
