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

const { claimsInsertMock, rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn((..._a: unknown[]): unknown => Promise.resolve({ data: null, error: null })),
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
      rpc: (...a: unknown[]) => rpcMock(...a),
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
    rpcMock.mockReset().mockImplementation(() => Promise.resolve({ data: null, error: null }));
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
    localStorage.setItem('cs_signup_at', String(Date.now()));
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

  it('gh-2060 item 2: a cs_signup older than 24h (a stranger\'s abandoned signup) is not used to prefill this visitor, and is cleared', async () => {
    seedStaleStorage({
      localStorage: {
        cs_signup: JSON.stringify(CS_SIGNUP),
        cs_signup_at: String(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    render(<TradeSelectorPage />);
    await waitFor(() => expect(localStorage.getItem('cs_signup')).toBeNull());
    expect(localStorage.getItem('cs_signup_at')).toBeNull();
    // no stranger data reaches the page or a claim write
    expect(claimsInsertMock).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('910 Congress Street');
  });

  // gh-2060 item 3 (CEO ruling, #2060 comment 5911272482): oq_referral_source /
  // oq_partner_id are CONSUMED (cookie + localStorage + sessionStorage copies)
  // once the claim write succeeded and they are stamped on the claim -- the
  // same rule gh-2062 applies to the oq-ref cookie. Never cleared on an error
  // or no-op pass. (Flipped from the earlier `it.fails` known-gap.)
  it('oq_partner_id / oq_referral_source left by an earlier visit are consumed (cleared, all copies) once a claim write succeeds', async () => {
    // Partner lookup RESOLVES: referral_agent_id is stamped, so oq_partner_id is consumed too.
    rpcMock.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: { id: 'agent-uuid-1' }, error: null });
      return chain;
    });
    seedStaleStorage({
      sessionStorage: { oq_partner_id: 'PARTNER-FROM-EARLIER-VISIT', oq_referral_source: 'realtor' },
      localStorage: { oq_partner_id: 'PARTNER-FROM-EARLIER-VISIT', oq_referral_source: 'realtor' },
      cookies: { oq_partner_id: 'PARTNER-FROM-EARLIER-VISIT', oq_referral_source: 'realtor' },
    });
    await walkCash(false);
    await waitFor(() => expect(sessionStorage.getItem('oq_funding_type')).toBe('cash')); // flow finished
    // The claim write carried the source it consumed.
    const payload = claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.referral_source).toBe('realtor');
    expect(payload.referral_agent_id).toBe('agent-uuid-1'); // the partner id was actually stamped
    expect(sessionStorage.getItem('oq_partner_id')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_source')).toBeNull();
    expect(localStorage.getItem('oq_partner_id')).toBeNull();
    expect(localStorage.getItem('oq_referral_source')).toBeNull();
    expect(document.cookie).not.toContain('oq_partner_id');
    expect(document.cookie).not.toContain('oq_referral_source');
  });

  it('a claim write that returns an ERROR does NOT consume oq_partner_id / oq_referral_source', async () => {
    claimsInsertMock.mockReset().mockImplementation(() => ({
      select: () => ({
        single: () =>
          Promise.resolve({
            data: null,
            error: { message: 'new row violates row-level security policy', code: '42501' },
          }),
      }),
    }));
    seedStaleStorage({
      sessionStorage: { oq_partner_id: 'PARTNER-LIVE', oq_referral_source: 'realtor' },
      localStorage: { oq_partner_id: 'PARTNER-LIVE', oq_referral_source: 'realtor' },
    });
    await walkCash(false);
    await waitFor(() => expect(sessionStorage.getItem('oq_funding_type')).toBe('cash')); // flow finished
    expect(sessionStorage.getItem('oq_partner_id')).toBe('PARTNER-LIVE');
    expect(sessionStorage.getItem('oq_referral_source')).toBe('realtor');
    expect(localStorage.getItem('oq_partner_id')).toBe('PARTNER-LIVE');
    expect(localStorage.getItem('oq_referral_source')).toBe('realtor');
  });

  // Round 2 (LEGAL-READ + REVIEW FAIL on #2404): oq_partner_id is consumed only when
  // it was actually stamped as referral_agent_id. A failed lookup stamps nothing.
  it('partner lookup ERRORS + claim write succeeds: oq_partner_id is KEPT (nothing stamped), oq_referral_source is still consumed', async () => {
    rpcMock.mockImplementation(() => Promise.reject(new Error('network down')));
    seedStaleStorage({
      sessionStorage: { oq_partner_id: 'PARTNER-LIVE', oq_referral_source: 'realtor' },
      localStorage: { oq_partner_id: 'PARTNER-LIVE', oq_referral_source: 'realtor' },
    });
    await walkCash(false);
    await waitFor(() => expect(sessionStorage.getItem('oq_funding_type')).toBe('cash')); // flow finished
    const payload = claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.referral_source).toBe('realtor');
    expect(payload.referral_agent_id).toBeUndefined();
    expect(sessionStorage.getItem('oq_partner_id')).toBe('PARTNER-LIVE');
    expect(localStorage.getItem('oq_partner_id')).toBe('PARTNER-LIVE');
    expect(sessionStorage.getItem('oq_referral_source')).toBeNull();
    expect(localStorage.getItem('oq_referral_source')).toBeNull();
  });

  it('partner lookup returns an error object (not a throw) + claim write succeeds: oq_partner_id is KEPT', async () => {
    rpcMock.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: { message: 'timeout' } });
      return chain;
    });
    seedStaleStorage({ sessionStorage: { oq_partner_id: 'PARTNER-LIVE' } });
    await walkCash(false);
    await waitFor(() => expect(sessionStorage.getItem('oq_funding_type')).toBe('cash'));
    const payload = claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.referral_agent_id).toBeUndefined();
    expect(sessionStorage.getItem('oq_partner_id')).toBe('PARTNER-LIVE');
  });
});
