import { Icon } from '@iconify/react';
import { Chip } from '@mui/material';
import React from 'react';
import { ComponentRow } from '../../model/components';

const STYLE: Record<
  ComponentRow['management'],
  { icon: string; color: 'default' | 'warning' | 'error' }
> = {
  Managed: { icon: 'mdi:robot-outline', color: 'default' },
  Unmanaged: { icon: 'mdi:hand-back-left-outline', color: 'warning' },
  Removed: { icon: 'mdi:delete-outline', color: 'error' },
};

export function ManagementChip(props: { management: ComponentRow['management'] }) {
  const style = STYLE[props.management];
  return (
    <Chip
      size="small"
      variant="outlined"
      color={style.color}
      icon={<Icon icon={style.icon} width={14} height={14} />}
      label={props.management}
      sx={{ '& .MuiChip-icon': { ml: 0.75 } }}
    />
  );
}
