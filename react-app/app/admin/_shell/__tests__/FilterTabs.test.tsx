/**
 * Unit tests for the shared <FilterTabs> component (D-211 Phase 9).
 *
 * Verifies:
 *   • The active tab receives the `.active` class (and only the active tab).
 *   • Clicking any tab calls onChange with that tab's key.
 *
 * jsdom is the configured default (vitest.config.ts) — no directive needed.
 * Mirrors ContractorCard.test.tsx import style.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterTabs } from '../FilterTabs';

const TABS = [
  { key: 'needs_review', label: 'Needs Review' },
  { key: 'pending', label: 'Pending Upload' },
  { key: 'all', label: 'All' },
];

describe('FilterTabs — active class', () => {
  it('the active tab has the .active class', () => {
    const { container } = render(
      <FilterTabs tabs={TABS} active="pending" onChange={vi.fn()} />,
    );
    const buttons = container.querySelectorAll('.filter-tab');
    expect(buttons).toHaveLength(3);

    // pending is at index 1
    expect(buttons[1].classList.contains('active')).toBe(true);
  });

  it('non-active tabs do NOT have the .active class', () => {
    const { container } = render(
      <FilterTabs tabs={TABS} active="pending" onChange={vi.fn()} />,
    );
    const buttons = container.querySelectorAll('.filter-tab');
    expect(buttons[0].classList.contains('active')).toBe(false); // needs_review
    expect(buttons[2].classList.contains('active')).toBe(false); // all
  });

  it('when active changes, the correct tab becomes active', () => {
    const { container, rerender } = render(
      <FilterTabs tabs={TABS} active="needs_review" onChange={vi.fn()} />,
    );
    let buttons = container.querySelectorAll('.filter-tab');
    expect(buttons[0].classList.contains('active')).toBe(true);
    expect(buttons[1].classList.contains('active')).toBe(false);

    rerender(<FilterTabs tabs={TABS} active="all" onChange={vi.fn()} />);
    buttons = container.querySelectorAll('.filter-tab');
    expect(buttons[0].classList.contains('active')).toBe(false);
    expect(buttons[2].classList.contains('active')).toBe(true);
  });
});

describe('FilterTabs — onChange callback', () => {
  it('clicking a tab calls onChange with that tab key', () => {
    const onChange = vi.fn();
    render(<FilterTabs tabs={TABS} active="needs_review" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pending Upload' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('pending');
  });

  it('clicking the currently-active tab still calls onChange', () => {
    const onChange = vi.fn();
    render(<FilterTabs tabs={TABS} active="needs_review" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Needs Review' }));
    expect(onChange).toHaveBeenCalledWith('needs_review');
  });

  it('clicking each tab passes the correct key', () => {
    const onChange = vi.fn();
    render(<FilterTabs tabs={TABS} active="needs_review" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenCalledWith('all');
  });
});

describe('FilterTabs — renders tab labels as text', () => {
  it('renders all tab labels', () => {
    render(<FilterTabs tabs={TABS} active="needs_review" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Needs Review' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pending Upload' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'All' })).toBeDefined();
  });

  it('wraps all tabs in a .filter-tabs container', () => {
    const { container } = render(
      <FilterTabs tabs={TABS} active="needs_review" onChange={vi.fn()} />,
    );
    expect(container.querySelector('.filter-tabs')).not.toBeNull();
  });
});
