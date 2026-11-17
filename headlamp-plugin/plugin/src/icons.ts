/*
 * The icons the plugin uses, registered with Headlamp's Iconify instance so
 * they render offline. Headlamp itself bundles only a few mdi icons and
 * fetches the others from api.iconify.design, which air-gapped k4all
 * clusters cannot reach. Keep in sync with the mdi: names used in src/
 * (src/icons.test.ts checks it).
 */

import mdiAlertCircleOutline from '@iconify/icons-mdi/alert-circle-outline';
import mdiAlertOctagonOutline from '@iconify/icons-mdi/alert-octagon-outline';
import mdiAlertOutline from '@iconify/icons-mdi/alert-outline';
import mdiApi from '@iconify/icons-mdi/api';
import mdiArrowRight from '@iconify/icons-mdi/arrow-right';
import mdiBridge from '@iconify/icons-mdi/bridge';
import mdiChevronDown from '@iconify/icons-mdi/chevron-down';
import mdiCogOutline from '@iconify/icons-mdi/cog-outline';
import mdiDeleteOutline from '@iconify/icons-mdi/delete-outline';
import mdiEyeOutline from '@iconify/icons-mdi/eye-outline';
import mdiFileLockOutline from '@iconify/icons-mdi/file-lock-outline';
import mdiFileQuestionOutline from '@iconify/icons-mdi/file-question-outline';
import mdiHandBackLeftOutline from '@iconify/icons-mdi/hand-back-left-outline';
import mdiHelpCircleOutline from '@iconify/icons-mdi/help-circle-outline';
import mdiHexagonMultipleOutline from '@iconify/icons-mdi/hexagon-multiple-outline';
import mdiHexagonOutline from '@iconify/icons-mdi/hexagon-outline';
import mdiInformationOutline from '@iconify/icons-mdi/information-outline';
import mdiIpNetworkOutline from '@iconify/icons-mdi/ip-network-outline';
import mdiKubernetes from '@iconify/icons-mdi/kubernetes';
import mdiLan from '@iconify/icons-mdi/lan';
import mdiLanConnect from '@iconify/icons-mdi/lan-connect';
import mdiLightningBolt from '@iconify/icons-mdi/lightning-bolt';
import mdiLockOutline from '@iconify/icons-mdi/lock-outline';
import mdiMonitorMultiple from '@iconify/icons-mdi/monitor-multiple';
import mdiPackageVariant from '@iconify/icons-mdi/package-variant';
import mdiPackageVariantClosed from '@iconify/icons-mdi/package-variant-closed';
import mdiPackageVariantClosedRemove from '@iconify/icons-mdi/package-variant-closed-remove';
import mdiPencilOutline from '@iconify/icons-mdi/pencil-outline';
import mdiPuzzleOutline from '@iconify/icons-mdi/puzzle-outline';
import mdiRobotOutline from '@iconify/icons-mdi/robot-outline';
import mdiRoutes from '@iconify/icons-mdi/routes';
import mdiServerNetwork from '@iconify/icons-mdi/server-network';
import mdiServerOutline from '@iconify/icons-mdi/server-outline';
import mdiShieldLockOutline from '@iconify/icons-mdi/shield-lock-outline';
import mdiSourceBranchSync from '@iconify/icons-mdi/source-branch-sync';
import mdiSourceRepository from '@iconify/icons-mdi/source-repository';
import mdiSync from '@iconify/icons-mdi/sync';
import mdiTag from '@iconify/icons-mdi/tag';
import mdiTagOutline from '@iconify/icons-mdi/tag-outline';
import mdiTrafficLightOutline from '@iconify/icons-mdi/traffic-light-outline';
import mdiTuneVariant from '@iconify/icons-mdi/tune-variant';
import mdiTuneVertical from '@iconify/icons-mdi/tune-vertical';
import { addCollection, IconifyIcon } from '@iconify/react';

export const ICONS: Record<string, IconifyIcon> = {
  'alert-circle-outline': mdiAlertCircleOutline,
  'alert-octagon-outline': mdiAlertOctagonOutline,
  'alert-outline': mdiAlertOutline,
  api: mdiApi,
  'arrow-right': mdiArrowRight,
  bridge: mdiBridge,
  'chevron-down': mdiChevronDown,
  'cog-outline': mdiCogOutline,
  'delete-outline': mdiDeleteOutline,
  'eye-outline': mdiEyeOutline,
  'file-lock-outline': mdiFileLockOutline,
  'file-question-outline': mdiFileQuestionOutline,
  'hand-back-left-outline': mdiHandBackLeftOutline,
  'help-circle-outline': mdiHelpCircleOutline,
  'hexagon-multiple-outline': mdiHexagonMultipleOutline,
  'hexagon-outline': mdiHexagonOutline,
  'information-outline': mdiInformationOutline,
  'ip-network-outline': mdiIpNetworkOutline,
  kubernetes: mdiKubernetes,
  lan: mdiLan,
  'lan-connect': mdiLanConnect,
  'lightning-bolt': mdiLightningBolt,
  'lock-outline': mdiLockOutline,
  'monitor-multiple': mdiMonitorMultiple,
  'package-variant': mdiPackageVariant,
  'package-variant-closed': mdiPackageVariantClosed,
  'package-variant-closed-remove': mdiPackageVariantClosedRemove,
  'pencil-outline': mdiPencilOutline,
  'puzzle-outline': mdiPuzzleOutline,
  'robot-outline': mdiRobotOutline,
  routes: mdiRoutes,
  'server-network': mdiServerNetwork,
  'server-outline': mdiServerOutline,
  'shield-lock-outline': mdiShieldLockOutline,
  'source-branch-sync': mdiSourceBranchSync,
  'source-repository': mdiSourceRepository,
  sync: mdiSync,
  tag: mdiTag,
  'tag-outline': mdiTagOutline,
  'traffic-light-outline': mdiTrafficLightOutline,
  'tune-variant': mdiTuneVariant,
  'tune-vertical': mdiTuneVertical,
};

export function registerIcons(): void {
  addCollection({ prefix: 'mdi', icons: ICONS });
}
