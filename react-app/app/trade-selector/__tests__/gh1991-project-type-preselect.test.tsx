/**
 * gh-1991 (CEO RUN 48) — get-started Step 1's "what do you need help with?"
 * chip (cs_signup.project_type) pre-selects the matching trade on this page,
 * so a homeowner who picked "Gutters" does not have to pick it again.
 *
 * closes-on requires "one is_test walk selecting Gutters that lands on
 * trade-selector with gutters pre-selected" — this is that walk, at the
 * unit level: cs_signup is seeded exactly as get-started/page.tsx writes it
 * (project_type: 'gutters'), the funding step is completed (cash path
 * lands directly on Trades, no Policy step), and the Trades step is
 * asserted to show Gutters already selected — negative control below shows
 * the SAME render with no cs_signup present, where nothing is pre-selected.
 *
 * Style mirrors trade-selector-cold-start.test.tsx: mock @/hooks/use-auth-ready
 * directly and the minimal supabase surface the returning-user guard needs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    })),
  },
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

describe('TradeSelectorPage — gh-1991 project_type pre-select', () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '', search: '' },
    });
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('pre-selects Gutters when cs_signup.project_type is "gutters" (positive)', async () => {
    localStorage.setItem('cs_signup', JSON.stringify({
      first_name: 'Jane',
      last_name: 'Doe',
      address: '123 Main St, Anytown, IN 46201',
      project_type: 'gutters',
    }));

    render(<TradeSelectorPage />);

    // Cash path: Funding -> Trades directly (no Policy step).
    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));

    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

    // Gutters card shows its selected checkmark; Continue is enabled because
    // wizardState.trades is no longer empty — both would be false without
    // the pre-select effect (see the negative control below).
    const guttersCard = screen.getByText('Gutters').closest('div[class],div:not([class])') ?? screen.getByText('Gutters');
    expect(guttersCard?.parentElement?.textContent).toContain('✓');
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
  });

  it('negative control: pre-selects nothing when cs_signup is absent', async () => {
    // No localStorage.setItem('cs_signup', ...) — the exact same render path,
    // deliberately without the signal that drives the pre-select above.
    render(<TradeSelectorPage />);

    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));

    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('negative control: an unmapped project_type ("other") pre-selects nothing', async () => {
    localStorage.setItem('cs_signup', JSON.stringify({ project_type: 'other' }));

    render(<TradeSelectorPage />);

    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));

    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});
