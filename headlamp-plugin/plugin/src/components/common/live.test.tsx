import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { agoText, LiveStatusView } from './live';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../api/live', () => ({ useLiveStatus: vi.fn() }));

const status = (extra = {}) => ({
  updatedAt: 1_000_000,
  down: false,
  downSince: null,
  intervalMs: 10_000,
  refresh: vi.fn(),
  ...extra,
});

describe('LiveStatusView', () => {
  it('says how fresh the page is and refreshes on demand', () => {
    const s = status();
    render(<LiveStatusView status={s} now={1_012_000} />);
    expect(screen.getByText('Updated 12 s ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(s.refresh).toHaveBeenCalled();
    expect(screen.queryByText(/not answering/)).toBeNull();
  });

  it('shows a discreet notice while the cluster does not answer', () => {
    render(<LiveStatusView status={status({ down: true, downSince: 970_000 })} now={1_012_000} />);
    expect(screen.getByText('The cluster is not answering')).toBeTruthy();
    expect(screen.getByText(/for 42 s/)).toBeTruthy();
    expect(screen.getByText(/Retrying every 10 s/)).toBeTruthy();
  });

  it('words the age', () => {
    expect(agoText(null, 5)).toBe('not yet');
    expect(agoText(1000, 2000)).toBe('just now');
    expect(agoText(0, 180_000)).toBe('3 min ago');
  });
});
