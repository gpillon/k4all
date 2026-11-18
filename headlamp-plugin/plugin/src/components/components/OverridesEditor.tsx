import { Alert, Box, Button, Grid, Stack, TextField, Typography } from '@mui/material';
import React from 'react';
import { EditorAction, EditorState } from '../../model/editor';
import {
  followStored,
  formFromOverride,
  overrideChanged,
  OverrideForm,
  parseOverrideForm,
} from '../../model/overrides';
import { getOverride, setOverride } from '../../model/settings';
import { ApplyBadge, Mono, Panel } from '../common/ui';
import { SaveFlow } from '../review/useSaveFlow';

export interface OverridesEditorProps {
  component: string;
  componentType: string;
  state: EditorState;
  dispatch: React.Dispatch<EditorAction>;
  flow: SaveFlow;
  disabled: boolean;
}

/**
 * Edits ClusterConfig.spec.componentOverrides[component]. Overrides survive
 * k4all release syncs, unlike edits to the ReleaseManifest values.
 */
export function OverridesEditor(props: OverridesEditorProps) {
  const { component, componentType, state, flow, disabled } = props;
  const stored = state.base ? getOverride(state.base.spec ?? {}, component) : undefined;
  const [form, setForm] = React.useState<OverrideForm>(() => formFromOverride(stored));
  const parsed = parseOverrideForm(component, componentType, form);
  const changed = parsed.override ? overrideChanged(stored, parsed.override) : true;

  // Follow the server while the form holds nothing new (also right after a save).
  const storedKey = JSON.stringify(stored ?? null);
  const previous = React.useRef(stored);
  React.useEffect(() => {
    const prev = previous.current;
    previous.current = stored;
    setForm(current => followStored(current, prev, stored, component, componentType));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const errors = parsed.issues.filter(i => i.severity === 'error');
  const warnings = parsed.issues.filter(i => i.severity !== 'error');
  const valuesError = errors.find(i => i.field.endsWith(':values'))?.message;
  const argsErrors = errors.filter(i => i.field.endsWith(':args')).map(i => i.message);

  const review = () => {
    if (!state.base || !parsed.override) {
      return;
    }
    const draft = setOverride(state.base.spec ?? {}, component, parsed.override);
    flow.review(draft);
  };

  return (
    <Panel title="Your overrides" icon="mdi:tune-vertical" action={<ApplyBadge mode="live" />}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Stored in the ClusterConfig at <Mono>spec.componentOverrides.{component}</Mono> and
        deep-merged over the release values, so they survive k4all upgrades. Maps are merged; lists
        replace the release list.
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <TextField
            label="Helm values (YAML)"
            multiline
            minRows={8}
            maxRows={24}
            fullWidth
            value={form.valuesText}
            disabled={disabled}
            onChange={e => setForm({ ...form, valuesText: e.target.value })}
            error={!!valuesError}
            helperText={
              valuesError ?? 'Empty means no value overrides. null removes a chart default.'
            }
            placeholder={'resources:\n  requests:\n    memory: 256Mi'}
            inputProps={{
              spellCheck: false,
              style: { fontFamily: 'monospace', fontSize: '0.85rem' },
            }}
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <TextField
            label="Helm --set arguments"
            multiline
            minRows={8}
            maxRows={24}
            fullWidth
            value={form.argsText}
            disabled={disabled}
            onChange={e => setForm({ ...form, argsText: e.target.value })}
            error={argsErrors.length > 0}
            helperText={
              argsErrors.length ? argsErrors.join(' ') : 'One per line, applied after the values.'
            }
            placeholder="--set service.annotations.foo=bar"
            inputProps={{
              spellCheck: false,
              style: { fontFamily: 'monospace', fontSize: '0.85rem' },
            }}
          />
        </Grid>
      </Grid>
      {warnings.length > 0 && (
        <Stack spacing={1} sx={{ mt: 2 }}>
          {warnings.map(w => (
            <Alert key={w.message} severity="warning">
              {w.message}
            </Alert>
          ))}
        </Stack>
      )}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
        <Button disabled={!changed || disabled} onClick={() => setForm(formFromOverride(stored))}>
          Discard
        </Button>
        <Button
          variant="contained"
          disabled={!changed || errors.length > 0 || disabled}
          onClick={review}
        >
          Review changes
        </Button>
      </Box>
    </Panel>
  );
}
