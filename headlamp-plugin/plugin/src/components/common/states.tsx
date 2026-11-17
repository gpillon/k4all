import { Icon } from '@iconify/react';
import { Alert, AlertTitle, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import React from 'react';
import { K4allData } from '../../api/hooks';
import { Mono } from './ui';

function Centered(props: { icon: string; title: string; children?: React.ReactNode }) {
  return (
    <Stack alignItems="center" spacing={1.5} sx={{ py: 8, textAlign: 'center' }}>
      <Box sx={{ color: 'text.secondary' }}>
        <Icon icon={props.icon} width={56} height={56} />
      </Box>
      <Typography variant="h2" sx={{ fontSize: '1.25rem', fontWeight: 600 }}>
        {props.title}
      </Typography>
      <Box sx={{ maxWidth: 560, color: 'text.secondary' }}>{props.children}</Box>
    </Stack>
  );
}

/**
 * Renders the loading and failure states shared by every page; children are
 * rendered only when the k4all resources are there.
 */
export function K4allGate(props: {
  data: K4allData;
  children: React.ReactNode;
  needReleaseManifest?: boolean;
}) {
  const { data } = props;
  if (data.loading) {
    return (
      <Stack alignItems="center" sx={{ py: 10 }}>
        <CircularProgress />
      </Stack>
    );
  }
  if (data.crdsMissing) {
    return (
      <Centered icon="mdi:package-variant-closed-remove" title="k4all-operator is not installed">
        The API group <Mono>k4all.magesgate.com</Mono> does not exist on this cluster. This plugin
        manages k4all clusters; on other clusters it has nothing to show.
      </Centered>
    );
  }
  if (data.error?.status === 403) {
    return (
      <Centered icon="mdi:shield-lock-outline" title="No access to the k4all resources">
        Your user cannot list <Mono>clusterconfigs</Mono> and <Mono>releasemanifests</Mono> in{' '}
        <Mono>k4all.magesgate.com</Mono>. Ask an administrator for the <Mono>k4all-viewer</Mono>{' '}
        role.
      </Centered>
    );
  }
  if (data.error) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      >
        <AlertTitle>Could not load the k4all resources</AlertTitle>
        {data.error.message}
      </Alert>
    );
  }
  if (!data.cc || (props.needReleaseManifest && !data.rm)) {
    return (
      <Centered
        icon="mdi:file-question-outline"
        title={!data.cc ? 'No ClusterConfig' : 'No ReleaseManifest'}
      >
        k4all creates them during installation (deploy-operator.sh). Without them k4all-operator has
        nothing to reconcile.
      </Centered>
    );
  }
  return (
    <>
      {data.extraClusterConfigs.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          There are {data.extraClusterConfigs.length + 1} ClusterConfigs. k4all-operator only uses
          the first by name, <Mono>{data.cc.metadata.name}</Mono>; delete the others (
          {data.extraClusterConfigs.join(', ')}).
        </Alert>
      )}
      {props.children}
    </>
  );
}

export function ReadOnlyNotice(props: { show: boolean; what: string }) {
  if (!props.show) {
    return null;
  }
  return (
    <Alert severity="info" icon={<Icon icon="mdi:eye-outline" />} sx={{ mb: 2 }}>
      You can view but not change {props.what}: your user lacks <Mono>patch</Mono> permission on it.
    </Alert>
  );
}
