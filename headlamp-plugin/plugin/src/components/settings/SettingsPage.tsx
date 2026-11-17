import { Icon } from '@iconify/react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Chip,
  Paper,
  Slide,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { K4allData, useK4allData, usePermissions } from '../../api/hooks';
import { capabilities } from '../../model/capabilities';
import { ChangeItem, describeChanges } from '../../model/changes';
import { editorReducer, initialEditorState, isBaseStale, isDirty } from '../../model/editor';
import { activeIngress } from '../../model/settings';
import { hasErrors, Issue, validateSettings } from '../../model/validation';
import { K4allGate, ReadOnlyNotice } from '../common/states';
import { Mono, PageHeader } from '../common/ui';
import { ReviewDialog } from '../review/ReviewDialog';
import { useSaveFlow } from '../review/useSaveFlow';
import { FeaturesSection } from './FeaturesSection';
import { IngressSection } from './IngressSection';
import { InstallTimeSection } from './InstallTimeSection';
import { NetworkingSection } from './NetworkingSection';

const TABS = [
  { id: 'features', label: 'Features', icon: 'mdi:puzzle-outline', prefixes: ['features.'] },
  { id: 'ingress', label: 'Ingress', icon: 'mdi:routes', prefixes: ['ingress.'] },
  { id: 'networking', label: 'Networking', icon: 'mdi:lan-connect', prefixes: ['networking.'] },
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
  const perms = usePermissions();
  const history = useHistory();
  const location = useLocation();
  const [state, dispatch] = React.useReducer(editorReducer, initialEditorState);

  const cc = data.cc;
  React.useEffect(() => {
    dispatch({ type: 'server', object: cc });
    // resourceVersion identifies a new server object; the object itself may be re-created on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cc?.metadata.resourceVersion]);

  const components = data.rm?.spec?.components ?? {};
  const flow = useSaveFlow(state, dispatch, components);

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

  const base = state.base.spec ?? {};
  const draft = state.draft;
  const nodeIPs = data.nodes
    .map(n => n.status?.addresses?.find(a => a.type === 'InternalIP')?.address)
    .filter((ip): ip is string => !!ip);
  const caps = capabilities(data.rm);
  const ingress = activeIngress(data.rm?.spec?.components, base);
  const issues: Issue[] = validateSettings(draft, { nodeIPs, ingress });
  const blocking = hasErrors(issues);
  const dirty = isDirty(state);
  const items = dirty ? describeChanges(base, draft, components) : [];
  const readOnly = !perms.checking && !perms.patchClusterConfig;
  const sectionProps = {
    draft,
    base,
    update: (fn: (d: typeof draft) => typeof draft) => dispatch({ type: 'edit', update: fn }),
    disabled: readOnly || perms.checking,
    issues,
    status: state.latest?.status ?? state.base.status,
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
      {dirty && isBaseStale(state) && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => dispatch({ type: 'reset' })}>
              Discard mine
            </Button>
          }
        >
          Someone saved newer settings (generation {state.latest?.metadata.generation}) while you
          were editing. Your changes will be replayed on top of them when you review.
        </Alert>
      )}

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

      {tab === 'features' && <FeaturesSection {...sectionProps} components={components} />}
      {tab === 'ingress' && <IngressSection {...sectionProps} controller={ingress} />}
      {tab === 'networking' && (
        <NetworkingSection {...sectionProps} nodeConfigs={data.nodeConfigs} />
      )}
      {tab === 'install' && <InstallTimeSection spec={base} caps={caps} />}

      <Slide direction="up" in={dirty} mountOnEnter unmountOnExit>
        <Paper
          elevation={8}
          sx={{
            position: 'fixed',
            bottom: 16,
            left: { xs: 16, md: 'calc(50% - 360px)' },
            right: { xs: 16, md: 'auto' },
            width: { md: 720 },
            zIndex: theme => theme.zIndex.appBar,
            px: 2.5,
            py: 1.5,
            borderRadius: 3,
          }}
          role="region"
          aria-label="Unsaved changes"
        >
          <Stack direction="row" alignItems="center" spacing={2} justifyContent="space-between">
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
              <Icon
                icon={blocking ? 'mdi:alert-circle-outline' : 'mdi:pencil-outline'}
                width={22}
                height={22}
              />
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }}>
                  {items.length} unsaved change{items.length === 1 ? '' : 's'}
                </Typography>
                <Typography
                  variant="caption"
                  color={blocking ? 'error' : 'text.secondary'}
                  noWrap
                  component="div"
                >
                  {blocking ? 'Fix the errors before saving.' : items.map(i => i.label).join(' · ')}
                </Typography>
              </Box>
            </Stack>
            <Stack direction="row" spacing={1} flexShrink={0}>
              <Button onClick={() => dispatch({ type: 'reset' })}>Discard</Button>
              <Button
                variant="contained"
                disabled={blocking || readOnly}
                onClick={() => flow.review()}
              >
                Review changes
              </Button>
            </Stack>
          </Stack>
        </Paper>
      </Slide>

      <ReviewDialog
        flow={flow}
        title={`Apply changes to ${state.base.metadata.name}`}
        warnings={issues.filter(i => i.severity === 'warning')}
      />
    </>
  );
}
