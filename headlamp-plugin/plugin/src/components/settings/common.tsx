import { Alert, Stack } from '@mui/material';
import React from 'react';
import { Capabilities } from '../../model/capabilities';
import { getIn, jsonEqual, Path } from '../../model/objects';
import { Draft } from '../../model/settings';
import { ClusterConfigStatus } from '../../model/types';
import { Issue } from '../../model/validation';

export interface SectionProps {
  draft: Draft;
  base: Draft;
  update: (fn: (draft: Draft) => Draft) => void;
  disabled: boolean;
  issues: Issue[];
  status?: ClusterConfigStatus;
  /** What the installed k4all-operator supports. */
  caps: Capabilities;
}

export function isChanged(props: Pick<SectionProps, 'draft' | 'base'>, path: Path): boolean {
  return !jsonEqual(getIn(props.base, path), getIn(props.draft, path));
}

/** Validation messages of one field, as compact alerts. */
export function FieldMessages(props: { issues: Issue[]; field: string }) {
  const own = props.issues.filter(i => i.field === props.field);
  if (own.length === 0) {
    return null;
  }
  return (
    <Stack spacing={0.75}>
      {own.map(i => (
        <Alert key={i.message} severity={i.severity} sx={{ py: 0 }}>
          {i.message}
        </Alert>
      ))}
    </Stack>
  );
}

export function firstError(issues: Issue[], field: string): string | undefined {
  return issues.find(i => i.field === field && i.severity === 'error')?.message;
}
