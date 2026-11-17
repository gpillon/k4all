import { Icon } from '@iconify/react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import React from 'react';
import { setManagement } from '../../api/k4allApi';
import { ComponentRow, removalBlockers } from '../../model/components';
import { classifyError } from '../../model/errors';
import { ClusterConfigSpec, ComponentManagement, ReleaseManifestObject } from '../../model/types';

const OPTIONS: { value: ComponentManagement; icon: string; title: string; text: string }[] = [
  {
    value: 'Managed',
    icon: 'mdi:robot-outline',
    title: 'Managed',
    text: 'k4all-operator installs and upgrades it to the release version. The default.',
  },
  {
    value: 'Unmanaged',
    icon: 'mdi:hand-back-left-outline',
    title: 'Unmanaged',
    text:
      'The operator leaves it as it is: no upgrades, no re-applies, nothing removed. k4all upgrades keep this ' +
      'choice. Use it to tune a component by hand.',
  },
  {
    value: 'Removed',
    icon: 'mdi:delete-outline',
    title: 'Removed',
    text:
      'The operator uninstalls it. A later k4all release can set it back to Managed, since the release sync only ' +
      'keeps Unmanaged choices.',
  },
];

export function ManagementDialog(props: {
  open: boolean;
  onClose: () => void;
  rm: ReleaseManifestObject;
  row: ComponentRow;
  config: ClusterConfigSpec;
}) {
  const theme = useTheme();
  const { row } = props;
  const [choice, setChoice] = React.useState<ComponentManagement>(row.management);
  const [confirmName, setConfirmName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { enqueueSnackbar } = useSnackbar();
  const blockers = removalBlockers(row, props.config);

  React.useEffect(() => {
    if (props.open) {
      setChoice(row.management);
      setConfirmName('');
      setError(null);
    }
  }, [props.open, row.management]);

  const removing = choice === 'Removed' && row.management !== 'Removed';
  const canSave =
    choice !== row.management &&
    !busy &&
    (!removing || (blockers.length === 0 && confirmName === row.name));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setManagement(props.rm, row.name, choice);
      enqueueSnackbar(`${row.name} is now ${choice}.`, { variant: 'success' });
      props.onClose();
    } catch (err) {
      const e = classifyError(err);
      setError(
        e.kind === 'conflict'
          ? 'The ReleaseManifest changed meanwhile (a release sync?). Reload and try again.'
          : `${e.hint} ${e.message}`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onClose={busy ? undefined : props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Management of {row.name}</DialogTitle>
      <DialogContent dividers>
        <RadioGroup
          value={choice}
          onChange={e => setChoice(e.target.value as ComponentManagement)}
          aria-label="Management policy"
          sx={{ gap: 1.25 }}
        >
          {OPTIONS.map(opt => {
            const selected = choice === opt.value;
            const disabled =
              opt.value === 'Removed' && blockers.length > 0 && row.management !== 'Removed';
            return (
              <FormControlLabel
                key={opt.value}
                value={opt.value}
                disabled={disabled}
                control={<Radio sx={{ mt: -0.25 }} />}
                sx={{
                  m: 0,
                  p: 1.5,
                  alignItems: 'flex-start',
                  borderRadius: 1.5,
                  border: `1px solid ${
                    selected ? theme.palette.primary.main : theme.palette.divider
                  }`,
                }}
                label={
                  <Box sx={{ pt: 0.75 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Icon icon={opt.icon} width={18} height={18} />
                      <Typography sx={{ fontWeight: 600 }}>{opt.title}</Typography>
                      {opt.value === row.management && (
                        <Typography variant="caption" color="text.secondary">
                          current
                        </Typography>
                      )}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {opt.text}
                    </Typography>
                    {disabled && (
                      <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
                        Not possible: {blockers.join(' ')}
                      </Typography>
                    )}
                  </Box>
                }
              />
            );
          })}
        </RadioGroup>
        {removing && blockers.length === 0 && (
          <Box sx={{ mt: 2 }}>
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {row.name} and the resources it created are deleted from the cluster.
            </Alert>
            <TextField
              size="small"
              fullWidth
              label={`Type ${row.name} to confirm`}
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              inputProps={{ spellCheck: false }}
            />
          </Box>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={removing ? 'error' : 'primary'}
          disabled={!canSave}
          onClick={save}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {removing ? `Remove ${row.name}` : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
