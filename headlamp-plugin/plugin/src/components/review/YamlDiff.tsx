import { alpha, Box, Typography, useTheme } from '@mui/material';
import React from 'react';
import { diffLines, diffStats, foldUnchanged, toYaml } from '../../model/textDiff';

/** Unified diff of two values rendered as YAML, with folded context. */
export function YamlDiff(props: { before: unknown; after: unknown; context?: number }) {
  const theme = useTheme();
  const lines = React.useMemo(
    () => diffLines(toYaml(props.before), toYaml(props.after)),
    [props.before, props.after]
  );
  const hunks = foldUnchanged(lines, props.context ?? 3);
  const stats = diffStats(lines);
  const bg = {
    add: alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.18 : 0.12),
    del: alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.18 : 0.1),
    same: 'transparent',
  };
  if (stats.added === 0 && stats.removed === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No difference.
      </Typography>
    );
  }
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        <Box component="span" sx={{ color: 'success.main', fontWeight: 600 }}>
          +{stats.added}
        </Box>{' '}
        <Box component="span" sx={{ color: 'error.main', fontWeight: 600 }}>
          −{stats.removed}
        </Box>{' '}
        lines in spec
      </Typography>
      <Box
        sx={{
          mt: 1,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
          overflow: 'auto',
          maxHeight: 380,
          fontFamily: 'monospace',
          fontSize: '0.8rem',
          lineHeight: 1.6,
        }}
      >
        {hunks.map((hunk, h) =>
          hunk.kind === 'gap' ? (
            <Box
              key={`gap-${h}`}
              sx={{
                px: 1,
                color: 'text.secondary',
                backgroundColor: theme.palette.action.hover,
                fontStyle: 'italic',
              }}
            >
              ⋯ {hunk.hidden} unchanged line{hunk.hidden > 1 ? 's' : ''}
            </Box>
          ) : (
            hunk.lines.map((line, i) => (
              <Box
                key={`${h}-${i}`}
                sx={{ display: 'flex', backgroundColor: bg[line.kind], whiteSpace: 'pre' }}
                aria-label={
                  line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : undefined
                }
              >
                <Box
                  component="span"
                  sx={{
                    width: 36,
                    flexShrink: 0,
                    textAlign: 'right',
                    pr: 1,
                    color: 'text.disabled',
                    userSelect: 'none',
                  }}
                >
                  {line.oldNo ?? ''}
                </Box>
                <Box
                  component="span"
                  sx={{
                    width: 36,
                    flexShrink: 0,
                    textAlign: 'right',
                    pr: 1,
                    color: 'text.disabled',
                    userSelect: 'none',
                  }}
                >
                  {line.newNo ?? ''}
                </Box>
                <Box
                  component="span"
                  sx={{ width: 16, flexShrink: 0, userSelect: 'none', color: 'text.secondary' }}
                >
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                </Box>
                <Box component="span" sx={{ pr: 2 }}>
                  {line.text}
                </Box>
              </Box>
            ))
          )
        )}
      </Box>
    </Box>
  );
}
