/*
 * Links to the consoles k4all installs (Hangar, Cairn) and anchors within a
 * page. The consoles document their stable URLs (/c/<cluster>/hangar/...,
 * /c/<cluster>/ceph/...); built by hand, so a link works whether or not that
 * plugin is loaded in this Headlamp.
 */

import { Utils } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { useLocation } from 'react-router-dom';

/** A URL of another plugin's route in the current cluster ("/hangar", "/ceph/osds"). */
export function clusterURL(path: string): string {
  const cluster = Utils.getCluster();
  return cluster ? `/c/${encodeURIComponent(cluster)}${path}` : path;
}

export const HANGAR_URL = '/hangar';
export const HANGAR_SETTINGS_URL = '/hangar/settings';
export const CAIRN_URL = '/ceph';
export const CAIRN_OSDS_URL = '/ceph/osds';
export const CAIRN_POOLS_URL = '/ceph/pools';

/** Scrolls to the element named by the URL hash (#feature-gates) once ready is true. */
export function useHashScroll(ready: boolean) {
  const location = useLocation();
  const done = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = location.hash?.replace(/^#/, '');
    if (!ready || !id || done.current === id) {
      return;
    }
    const el = document.getElementById(id);
    if (el) {
      done.current = id;
      el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }, [ready, location.hash]);
}
