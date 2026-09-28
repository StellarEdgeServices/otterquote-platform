/**
 * gh-2060 — stale sessionStorage handoff keys written/read by the React
 * trade-selector wizard: `oq_funding_type`, `oq_trade_selections`,
 * `oq_claim_id`, `oq_pending_loss_sheet_v1` (own tests, gh2070), and the
 * referral trio `oq_referral_source` / `oq_partner_id` /
 * `oq_referral_id_for_claim` (own tests, gh2062; see the ledger).
 *
 * The cross-page handoff to /repair-intake and the static project-info pages
 * is carried by sessionStorage, which a reused tab does NOT clear. The
 * stale-state question for each key the wizard WRITES is: when this run
 * completes, does the value the next page reads describe THIS run, or an
 * earlier one? Each test seeds the earlier run's leftovers with
 * `seedStaleStorage()` (after this file's own clean beforeEach) and walks the
 * real wizard to completion.
 *
 * Harness copied from gh2062-referral-cookie-clear.test.tsx (real page, mocked
 * supabase + auth hook only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { seedStaleStorage } from '@/test/storage-fixtures';

const { claimsInsertMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({
      single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
    }),
  })),
}));

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const claimsSelectChain = {
    select: () => claimsSelectChain,
    eq: () => claimsSelectChain,
    order: () => claimsSelectChain,
    limit: () => claimsSelectChain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'profiles') return { upsert: vi.fn(() => Promise.resolve({ error: null })) };
        if (table === 'claims') {
          return {
            select: () => claimsSelectChain,
            insert: claimsInsertMock,
            update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'x' }], error: null }) }) }),
          };
        }
        return { select: () => claimsSelectChain };
      },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

const mockAuth = (v: unknown) => (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue(v);

const CS_SIGNUP = {
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '3175551234',
  address: '910 Congress Street, Noblesville, IN 46060',
  address_street: '910 Congress Street',
  address_city: 'Noblesville',
  address_state: 'IN',
  address_zip: '46060',
};

function clearAllCookies() {
  document.cookie.split('; ').forEach((c) => {
    const key = c.split('=')[0];
    if (key) document.cookie = `${key}=; Path=/; Max-Age=0`;
  });
}

describe('trade-selector — stale handoff keys from an earlier wizard run (gh-2060)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsInsertMock.mockReset().mockImplementation(() => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
      }),
    }));
    localStorage.clear();
    sessionStorage.clear();
    clearAllCookies();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '', search: '', hostname: 'localhost', protocol: 'http:' },
    });
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function walkCash(repair: boolean) {
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    render(<TradeSelectorPage />);
    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());
    if (repair) fireEvent.click(screen.getByText('Repair'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(claimsInsertMock).toHaveBeenCalledTimes(1));
  }

  it('oq_funding_type from an earlier (insurance) run is replaced by THIS run\'s funding type', async () => {
    seedStaleStorage({ sessionStorage: { oq_funding_type: 'insurance' } });
    await walkCash(false);
    await waitFor(() => expect(sessionStorage.getItem('oq_funding_type')).toBe('cash'));
  });

  it('oq_trade_selections from an earlier run is REPLACED (not merged) by this run\'s repair selection', async () => {
    seedStaleStorage({ sessionStorage: { oq_trade_selections: JSON.stringify({ siding: true, gutters: true }) } });
    await walkCash(true);
    await waitFor(() => expect(sessionStorage.getItem('oq_trade_selections')).not.toBeNull());
    expect(JSON.parse(sessionStorage.getItem('oq_trade_selections') as string)).toEqual({ roofing: true });
  });

  it('a stale oq_claim_id from an earlier claim does not turn this run\'s new-claim insert into an update of that claim', async () => {
    seedStaleStorage({ sessionStorage: { oq_claim_id: 'c-STALE-PREVIOUS' } });
    await walkCash(false);
    // The wizard inserts a NEW claim (no existing claim for this user) and never
    // targets the stale id from sessionStorage.
    expect(claimsInsertMock).toHaveBeenCalledTimes(1);
    const payload = claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('c-STALE-PREVIOUS');
  });

  // KNOWN GAP (Q on #2060): encodes the RECOMMENDED DEFAULT (consume-on-success,
  // the same rule gh-2062 already applies to the referral id/cookie) for the
  // sessionStorage attribution keys. Today neither key is ever cleared, so a
  // ?partner_id= / ?ref= from an earlier visit in a reused tab attributes THIS
  // claim to that partner (commission attribution). `it.fails` passes while the
  // gap exists and turns RED when the fix lands -- flip it to `it` then.
  it.fails('KNOWN GAP: oq_partner_id / oq_referral_source left by an earlier visit are consumed (cleared) once a claim write succeeds', async () => {
    seedStaleStorage({
      sessionStorage: { oq_partner_id: 'PARTNER-FROM-EARLIER-VISIT', oq_referral_source: 'realtor' },
    });
    await walkCash(false);
    await waitFor(() => expect(sessionStorage.getItem('oq_funding_type')).toBe('cash')); // flow finished
    expect(sessionStorage.getItem('oq_partner_id')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_source')).toBeNull();
  });
});
