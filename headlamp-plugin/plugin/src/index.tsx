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
import { ComponentDetailPage } from './components/components/ComponentDetailPage';
import { ComponentsPage } from './components/components/ComponentsPage';
import { NodeSection } from './components/nodes/NodeSection';
import { OverviewPage } from './components/overview/OverviewPage';
import { SettingsPage } from './components/settings/SettingsPage';
import { UpgradesPage } from './components/upgrades/UpgradesPage';
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
  component: () => <OverviewPage />,
});

registerRoute({
  path: '/k4all/upgrades',
  exact: true,
  name: 'k4all-upgrades',
  sidebar: 'k4all-upgrades',
  component: () => <UpgradesPage />,
});

registerRoute({
  path: '/k4all/settings',
  exact: true,
  name: 'k4all-settings',
  sidebar: 'k4all-settings',
  component: () => <SettingsPage />,
});

registerRoute({
  path: '/k4all/components',
  exact: true,
  name: 'k4all-components',
  sidebar: 'k4all-components',
  component: () => <ComponentsPage />,
});

registerRoute({
  path: '/k4all/components/:name',
  exact: true,
  name: 'k4all-component',
  sidebar: 'k4all-components',
  component: () => <ComponentDetailPage />,
});

registerDetailsViewSection(({ resource }: DetailsViewSectionProps) => {
  if (resource?.kind !== 'Node') {
    return null;
  }
  return <NodeSection node={resource.jsonData as NodeLike} />;
});
