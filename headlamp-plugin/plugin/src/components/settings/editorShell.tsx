/*
 * What every settings page shares: the ClusterConfig edit session (editor
 * reducer + save flow: JSON Patch, server dry run, review with the diff,
 * conflict rebase), the "someone saved meanwhile" notice and the unsaved
 * changes bar. /k4all/settings and the v2.7.0 pages (virtualization, nodes,
 * storage) each run their own session on the same ClusterConfig.
 */

import { Icon } from '@iconify/react';
import { Alert, Box, Button, Paper, Slide, Stack, Typography } from '@mui/material';
import React from 'react';
import { K4allData, Permissions, usePermissions } from '../../api/hooks';
import { Capabilities, capabilities } from '../../model/capabilities';
import { ChangeContext, ChangeItem, describeChanges } from '../../model/changes';
import {
  EditorAction,
  editorReducer,
  EditorState,
  initialEditorState,
  isBaseStale,
  isDirty,
} from '../../model/editor';
import { Draft } from '../../model/settings';
import { ClusterConfigStatus, ComponentSpec } from '../../model/types';
import { SaveFlow, useSaveFlow } from '../review/useSaveFlow';

export interface SettingsEditor {
  state: EditorState;
  dispatch: React.Dispatch<EditorAction>;
  flow: SaveFlow;
  perms: Permissions;
  /** The user may not patch the ClusterConfig. */
  readOnly: boolean;
  /** Controls are disabled: read-only, or still asking. */
  disabled: boolean;
  caps: Capabilities;
  components: Record<string, ComponentSpec>;
  /** The spec the draft started from ({} before the first load). */
  base: Draft;
  draft: Draft;
  update: (fn: (d: Draft) => Draft) => void;
  dirty: boolean;
  /** The change list of the draft (empty while clean). */
  items: ChangeItem[];
  /** The latest status seen. */
  status?: ClusterConfigStatus;
}

/** One edit session on the ClusterConfig of data, following the watch while clean. */
export function useSettingsEditor(data: K4allData, changeCtx?: ChangeContext): SettingsEditor {
  const perms = usePermissions();
  const [state, dispatch] = React.useReducer(editorReducer, initialEditorState);
  const cc = data.cc;
  React.useEffect(() => {
    dispatch({ type: 'server', object: cc });
    // resourceVersion identifies a new server object; the object itself may be re-created on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cc?.metadata.resourceVersion]);
  const components = data.rm?.spec?.components ?? {};
  const caps = capabilities(data.rm);
  const flow = useSaveFlow(state, dispatch, components, caps, changeCtx);
  const base = state.base?.spec ?? {};
  const dirty = isDirty(state);
  const readOnly = !perms.checking && !perms.patchClusterConfig;
  const update = React.useCallback(
    (fn: (d: Draft) => Draft) => dispatch({ type: 'edit', update: fn }),
    []
  );
  return {
    state,
    dispatch,
    flow,
    perms,
    readOnly,
    disabled: readOnly || perms.checking,
    caps,
    components,
    base,
    draft: state.draft,
    update,
    dirty,
    items: dirty ? describeChanges(base, state.draft, components, caps, changeCtx) : [],
    status: state.latest?.status ?? state.base?.status,
  };
}

export function StaleDraftNotice({ editor }: { editor: SettingsEditor }) {
  if (!editor.dirty || !isBaseStale(editor.state)) {
    return null;
  }
  return (
    <Alert
      severity="info"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={() => editor.dispatch({ type: 'reset' })}>
          Discard mine
        </Button>
      }
    >
      Someone saved newer settings (generation {editor.state.latest?.metadata.generation}) while you
      were editing. Your changes will be replayed on top of them when you review.
    </Alert>
  );
}

/** The bar that slides up while the draft has changes: count, names, Discard, Review changes. */
export function UnsavedBar(props: { editor: SettingsEditor; blocking: boolean }) {
  const { editor, blocking } = props;
  const items = editor.items;
  return (
    <Slide direction="up" in={editor.dirty} mountOnEnter unmountOnExit>
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
            <Button onClick={() => editor.dispatch({ type: 'reset' })}>Discard</Button>
            <Button
              variant="contained"
              disabled={blocking || editor.readOnly}
              onClick={() => editor.flow.review()}
            >
              Review changes
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Slide>
  );
}
