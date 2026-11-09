/**
 * D-407 1/8 (gh-3282) -- the homeowner payment-routing question.
 *
 *   Q1 "How is this being paid for?"  Insurance | Out-of-pocket
 *   Q2 (Insurance only)               RCV | ACV
 *
 * (1) pure routing table (payment-route.ts): four answers -> destinations
 * (2) component walk: each of the four answers lands on the right next page
 * (3) negative control: no answer -> no advance, no redirect
 *
 * Destinations: gh-3283 and gh-3285 switched the rcv and oop rows to the new
 * React routes (/insurance-rcv, /out-of-pocket). The acv row is still the
 * placeholder until gh-3284 (#3334 governs that row). This suite pins all
 * three so a sub-issue that replaces one must change the test deliberately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  PAYMENT_QUESTION,
  PAYMENT_DESTINATIONS,
  needsPolicyQuestion,
  resolvePaymentRoute,
  paymentDestination,
} from '../payment-route';

const { claimsInsertMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({ single: () => Promise.resolve({ data: { id: 'new-claim-id' }, error: null }) }),
  })),
}));

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'profiles') return { upsert: vi.fn(() => Promise.resolve({ error: null })), select: () => chain };
        if (table === 'claims') {
          return { select: () => chain, insert: claimsInsertMock, update: vi.fn() };
        }
        return { select: () => chain };
      },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

const RCV = 'https://app.otterquote.com/insurance-rcv';
const ACV = 'https://otterquote.com/project-info-acv.html';
const OOP = 'https://app.otterquote.com/out-of-pocket';
const CS_SIGNUP = {
  first_name: 'Jane', last_name: 'Doe', phone: '3175551234',
  address: '910 Congress Street, Noblesville, IN 46060',
  address_street: '910 Congress Street', address_city: 'Noblesville', address_state: 'IN', address_zip: '46060',
};

describe('payment-route.ts -- routing table', () => {
  it('Q1 wording is the D-407 text', () => {
    expect(PAYMENT_QUESTION).toBe('How is this being paid for?');
  });
  it('four answers resolve to the right route', () => {
    expect(needsPolicyQuestion('insurance')).toBe(true);
    expect(needsPolicyQuestion('cash')).toBe(false);
    expect(resolvePaymentRoute('insurance', 'rcv')).toBe('rcv');
    expect(resolvePaymentRoute('insurance', 'acv')).toBe('acv');
    expect(resolvePaymentRoute('cash', null)).toBe('oop');
    expect(paymentDestination('insurance', 'rcv')).toBe(RCV);
    expect(paymentDestination('insurance', 'acv')).toBe(ACV);
    expect(paymentDestination('cash', null)).toBe(OOP);
    expect(PAYMENT_DESTINATIONS).toEqual({ rcv: RCV, acv: ACV, oop: OOP });
  });
  it('gh-3283 / gh-3285: rcv and oop no longer point at the static placeholder pages', () => {
    expect(PAYMENT_DESTINATIONS.rcv).toBe('https://app.otterquote.com/insurance-rcv');
    expect(PAYMENT_DESTINATIONS.oop).toBe('https://app.otterquote.com/out-of-pocket');
    expect(PAYMENT_DESTINATIONS.rcv).not.toContain('project-info-rcv.html');
    expect(PAYMENT_DESTINATIONS.oop).not.toContain('project-info-cash.html');
    // The acv row is governed separately (#3334) and is unchanged here.
    expect(PAYMENT_DESTINATIONS.acv).toBe('https://otterquote.com/project-info-acv.html');
  });
  it('"I\'m not sure" routes to the RCV destination but is not an RCV answer', () => {
    expect(resolvePaymentRoute('insurance', 'idk')).toBe('rcv');
    expect(paymentDestination('insurance', 'idk')).toBe(RCV);
  });
  it('negative control: unanswered never resolves', () => {
    expect(resolvePaymentRoute(null, null)).toBeNull();
    expect(resolvePaymentRoute(null, 'rcv')).toBeNull();
    expect(resolvePaymentRoute('insurance', null)).toBeNull();
    expect(paymentDestination(null, null)).toBeNull();
    expect(paymentDestination('insurance', null)).toBeNull();
  });
});

describe('TradeSelectorPage -- D-407 payment routing walk', () => {
  let hrefSets: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    hrefSets = [];
    let href = '';
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: {
        get href() { return href; },
        set href(v: string) { href = v; hrefSets.push(v); },
        search: '', hostname: 'localhost', protocol: 'http:',
      },
    });
    (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true,
    });
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    localStorage.setItem('cs_signup_at', String(Date.now()));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function finishFromTrades() {
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  }

  it('renders the D-407 question with Insurance and Out-of-pocket', async () => {
    render(<TradeSelectorPage />);
    expect(await screen.findByText('How is this being paid for?')).toBeInTheDocument();
    expect(screen.getByText('Insurance Claim')).toBeInTheDocument();
    expect(screen.getByText('Out of Pocket')).toBeInTheDocument();
  });

  it('answer 1: Out-of-pocket skips the RCV/ACV question and lands on the OOP page', async () => {
    render(<TradeSelectorPage />);
    fireEvent.click(await screen.findByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
    expect(screen.queryByText('What type of insurance policy do you have?')).not.toBeInTheDocument();
    await finishFromTrades();
    await waitFor(() => expect(hrefSets.length).toBeGreaterThan(0));
    expect(hrefSets.at(-1)).toBe(`${OOP}?claim_id=new-claim-id`);
    expect((claimsInsertMock.mock.calls[0][0] as Record<string, unknown>).funding_type).toBe('cash');
  });

  it('answer 2: Insurance asks RCV or ACV next', async () => {
    render(<TradeSelectorPage />);
    fireEvent.click(await screen.findByText('Insurance Claim'));
    await waitFor(() => expect(screen.getByText('What type of insurance policy do you have?')).toBeInTheDocument());
    expect(screen.getByText('Replacement Cost Value (RCV)')).toBeInTheDocument();
    expect(screen.getByText('Actual Cash Value (ACV)')).toBeInTheDocument();
    expect(hrefSets).toEqual([]);
  });

  it('answer 3: Insurance then RCV lands on the RCV page', async () => {
    render(<TradeSelectorPage />);
    fireEvent.click(await screen.findByText('Insurance Claim'));
    await waitFor(() => expect(screen.getByText('What type of insurance policy do you have?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Replacement Cost Value (RCV)'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await finishFromTrades();
    await waitFor(() => expect(hrefSets.length).toBeGreaterThan(0));
    expect(hrefSets.at(-1)).toBe(`${RCV}?claim_id=new-claim-id`);
    expect((claimsInsertMock.mock.calls[0][0] as Record<string, unknown>).job_type).toBe('insurance_rcv');
  });

  it('"I\'m not sure": routes to the RCV page, stores policy_type idk, never rcv', async () => {
    render(<TradeSelectorPage />);
    fireEvent.click(await screen.findByText('Insurance Claim'));
    await waitFor(() => expect(screen.getByText('What type of insurance policy do you have?')).toBeInTheDocument());
    fireEvent.click(screen.getByText("I'm Not Sure"));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await finishFromTrades();
    await waitFor(() => expect(hrefSets.length).toBeGreaterThan(0));
    expect(hrefSets.at(-1)).toBe(`${RCV}?claim_id=new-claim-id`);
    const payload = claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.funding_type).toBe('insurance');
    expect(payload.policy_type).toBe('idk');
    expect(payload.policy_type).not.toBe('rcv');
  });

  it('answer 4: Insurance then ACV lands on the ACV page', async () => {
    render(<TradeSelectorPage />);
    fireEvent.click(await screen.findByText('Insurance Claim'));
    await waitFor(() => expect(screen.getByText('What type of insurance policy do you have?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Actual Cash Value (ACV)'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await finishFromTrades();
    await waitFor(() => expect(hrefSets.length).toBeGreaterThan(0));
    expect(hrefSets.at(-1)).toBe(`${ACV}?claim_id=new-claim-id`);
    expect((claimsInsertMock.mock.calls[0][0] as Record<string, unknown>).job_type).toBe('insurance_acv');
  });

  it('negative control: no Q1 answer means no advance and no redirect', async () => {
    render(<TradeSelectorPage />);
    expect(await screen.findByText('How is this being paid for?')).toBeInTheDocument();
    expect(screen.queryByText('What do you need done?')).not.toBeInTheDocument();
    expect(screen.queryByText('What type of insurance policy do you have?')).not.toBeInTheDocument();
    expect(hrefSets).toEqual([]);
    expect(claimsInsertMock).not.toHaveBeenCalled();
  });

  it('negative control: Insurance with no RCV/ACV answer cannot continue', async () => {
    render(<TradeSelectorPage />);
    fireEvent.click(await screen.findByText('Insurance Claim'));
    await waitFor(() => expect(screen.getByText('What type of insurance policy do you have?')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.queryByText('What do you need done?')).not.toBeInTheDocument();
    expect(hrefSets).toEqual([]);
  });
});
