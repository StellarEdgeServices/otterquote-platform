/**
 * gh-3757 / D-375 — the Windows card on the trade selector is marked with the
 * generic "Coming Soon" badge (same text/class as contractor-auto-bids.html)
 * and cannot be selected, by click or by the get-started project_type preselect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
// gh-2004: this suite is about project_type pre-select, not the address
// fallback, so the mocked profile always has a complete address — keeps
// `needsAddressStep` false and every existing assertion (which expects to
// land straight on 'funding'/'trades') unchanged.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: {
                  address_street: '1 Test Ln',
                  address_city: 'Testville',
                  address_state: 'IN',
                  address_zip: '46000',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        }),
      };
    }),
  },
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

const mockAuth = (v: unknown) => (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue(v);

async function openTrades() {
  render(<TradeSelectorPage />);
  await waitFor(() => expect(screen.getByText('How is this being paid for?')).toBeInTheDocument());
  fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
  await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
}

describe('TradeSelectorPage — gh-3757 Windows card is Coming Soon and not selectable', () => {
  let originalLocation: Location;
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: '', search: '' } });
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('shows the generic Coming Soon badge on Windows only', async () => {
    await openTrades();
    const badges = screen.getAllByText('Coming Soon');
    expect(badges).toHaveLength(1);
    expect(badges[0].className).toContain('badge');
    expect(badges[0].className).toContain('coming-soon');
    const card = screen.getByText('Windows').closest('[aria-disabled]');
    expect(card).not.toBeNull();
    expect(card).toContainElement(badges[0]);
    expect(card?.getAttribute('aria-disabled')).toBe('true');
  });

  it('clicking Windows selects nothing; Continue stays disabled', async () => {
    await openTrades();
    fireEvent.click(screen.getByText('Windows'));
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('keyboard activation does nothing on the Windows card (not focusable, Enter/Space ignored)', async () => {
    await openTrades();
    const card = screen.getByText('Windows').closest('[aria-disabled]') as HTMLElement;
    expect(card.hasAttribute('tabindex')).toBe(false);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('project_type "windows" from get-started does not preselect Windows', async () => {
    localStorage.setItem('cs_signup', JSON.stringify({ project_type: 'windows' }));
    localStorage.setItem('cs_signup_at', String(Date.now()));
    await openTrades();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('control: a real trade (Gutters) is still selectable', async () => {
    await openTrades();
    fireEvent.click(screen.getByText('Gutters'));
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
  });
});
