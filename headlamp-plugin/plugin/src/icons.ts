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
import mdiArrowUpBoldCircleOutline from '@iconify/icons-mdi/arrow-up-bold-circle-outline';
import mdiBridge from '@iconify/icons-mdi/bridge';
import mdiCheck from '@iconify/icons-mdi/check';
import mdiCheckCircleOutline from '@iconify/icons-mdi/check-circle-outline';
import mdiChevronDown from '@iconify/icons-mdi/chevron-down';
import mdiChevronRight from '@iconify/icons-mdi/chevron-right';
import mdiCloudAlertOutline from '@iconify/icons-mdi/cloud-alert-outline';
import mdiCloudDownloadOutline from '@iconify/icons-mdi/cloud-download-outline';
import mdiCogOutline from '@iconify/icons-mdi/cog-outline';
import mdiContentCopy from '@iconify/icons-mdi/content-copy';
import mdiDeleteOutline from '@iconify/icons-mdi/delete-outline';
import mdiEyeOutline from '@iconify/icons-mdi/eye-outline';
import mdiFedora from '@iconify/icons-mdi/fedora';
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
import mdiMapMarkerOutline from '@iconify/icons-mdi/map-marker-outline';
import mdiMapMarkerPath from '@iconify/icons-mdi/map-marker-path';
import mdiMonitorMultiple from '@iconify/icons-mdi/monitor-multiple';
import mdiPackageVariant from '@iconify/icons-mdi/package-variant';
import mdiPackageVariantClosed from '@iconify/icons-mdi/package-variant-closed';
import mdiPackageVariantClosedRemove from '@iconify/icons-mdi/package-variant-closed-remove';
import mdiPause from '@iconify/icons-mdi/pause';
import mdiPencilOutline from '@iconify/icons-mdi/pencil-outline';
import mdiPlay from '@iconify/icons-mdi/play';
import mdiProgressUpload from '@iconify/icons-mdi/progress-upload';
import mdiPuzzleOutline from '@iconify/icons-mdi/puzzle-outline';
import mdiRefresh from '@iconify/icons-mdi/refresh';
import mdiReplay from '@iconify/icons-mdi/replay';
import mdiRestart from '@iconify/icons-mdi/restart';
import mdiRobotOutline from '@iconify/icons-mdi/robot-outline';
import mdiRocketLaunchOutline from '@iconify/icons-mdi/rocket-launch-outline';
import mdiRoutes from '@iconify/icons-mdi/routes';
import mdiServerNetwork from '@iconify/icons-mdi/server-network';
import mdiServerOutline from '@iconify/icons-mdi/server-outline';
import mdiShieldLockOutline from '@iconify/icons-mdi/shield-lock-outline';
import mdiSourceBranchSync from '@iconify/icons-mdi/source-branch-sync';
import mdiSourceRepository from '@iconify/icons-mdi/source-repository';
import mdiStop from '@iconify/icons-mdi/stop';
import mdiSync from '@iconify/icons-mdi/sync';
import mdiTag from '@iconify/icons-mdi/tag';
import mdiTagOutline from '@iconify/icons-mdi/tag-outline';
import mdiTimerOutline from '@iconify/icons-mdi/timer-outline';
import mdiTimerSand from '@iconify/icons-mdi/timer-sand';
import mdiTrafficLightOutline from '@iconify/icons-mdi/traffic-light-outline';
import mdiTrayArrowDown from '@iconify/icons-mdi/tray-arrow-down';
import mdiTuneVariant from '@iconify/icons-mdi/tune-variant';
import mdiTuneVertical from '@iconify/icons-mdi/tune-vertical';
import mdiUpdate from '@iconify/icons-mdi/update';
import { addCollection, IconifyIcon } from '@iconify/react';

export const ICONS: Record<string, IconifyIcon> = {
  'alert-circle-outline': mdiAlertCircleOutline,
  'alert-octagon-outline': mdiAlertOctagonOutline,
  'alert-outline': mdiAlertOutline,
  api: mdiApi,
  'arrow-right': mdiArrowRight,
  'arrow-up-bold-circle-outline': mdiArrowUpBoldCircleOutline,
  bridge: mdiBridge,
  check: mdiCheck,
  'check-circle-outline': mdiCheckCircleOutline,
  'chevron-down': mdiChevronDown,
  'chevron-right': mdiChevronRight,
  'cloud-alert-outline': mdiCloudAlertOutline,
  'cloud-download-outline': mdiCloudDownloadOutline,
  'cog-outline': mdiCogOutline,
  'content-copy': mdiContentCopy,
  'delete-outline': mdiDeleteOutline,
  'eye-outline': mdiEyeOutline,
  fedora: mdiFedora,
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
  'map-marker-outline': mdiMapMarkerOutline,
  'map-marker-path': mdiMapMarkerPath,
  'monitor-multiple': mdiMonitorMultiple,
  'package-variant': mdiPackageVariant,
  'package-variant-closed': mdiPackageVariantClosed,
  'package-variant-closed-remove': mdiPackageVariantClosedRemove,
  pause: mdiPause,
  'pencil-outline': mdiPencilOutline,
  play: mdiPlay,
  'progress-upload': mdiProgressUpload,
  'puzzle-outline': mdiPuzzleOutline,
  refresh: mdiRefresh,
  replay: mdiReplay,
  restart: mdiRestart,
  'robot-outline': mdiRobotOutline,
  'rocket-launch-outline': mdiRocketLaunchOutline,
  routes: mdiRoutes,
  'server-network': mdiServerNetwork,
  'server-outline': mdiServerOutline,
  'shield-lock-outline': mdiShieldLockOutline,
  'source-branch-sync': mdiSourceBranchSync,
  'source-repository': mdiSourceRepository,
  stop: mdiStop,
  sync: mdiSync,
  tag: mdiTag,
  'tag-outline': mdiTagOutline,
  'timer-outline': mdiTimerOutline,
  'timer-sand': mdiTimerSand,
  'traffic-light-outline': mdiTrafficLightOutline,
  'tray-arrow-down': mdiTrayArrowDown,
  'tune-variant': mdiTuneVariant,
  'tune-vertical': mdiTuneVertical,
  update: mdiUpdate,
};

export function registerIcons(): void {
  addCollection({ prefix: 'mdi', icons: ICONS });
}
