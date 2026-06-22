import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── Mock the auth + notification hooks the shell depends on (before import). ──
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { HomeownerShell } from '../../_shell/HomeownerShell';
import { BidCard } from '../components/BidCard';
import { BidsCompareGrid } from '../components/BidsCompareGrid';
import { EmptyState, ErrorState, AllExpiredBanner, BidUpdatedBanner } from '../components/Banners';
import {
  deriveBidExpiry,
  deriveBidAction,
  isAllExpired,
  isLowestPrice,
  showCompareToggle,
  buildCompareModel,
  EXPIRY_TOOLTIP,
  EMPTY_STATE,
} from '../utils';
import type { BidRow, ContractorProfile } from '../types';

const NOW = new Date('2026-06-22T12:00:00Z');

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);
const authed = (over: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'jane@example.com' },
  role: 'homeowner',
  isAdmin: false,
  loading: false,
  settled: true,
  signOut: vi.fn(),
  ...over,
});

const bid = (over: Partial<BidRow> = {}): BidRow =>
  ({ id: 'b1', claim_id: 'c1', contractor_id: 'k1', total_price: 10000, bid_status: 'submitted', ...over }) as BidRow;

// ─────────────────────────────────────────────────────────────────────────────
// (a) Homeowner gate — the shell enforces it; /bids wraps in <HomeownerShell active="bids">.
//     Audit fold-in #4: unauth → get-started.html, NEVER the /sign-in.html dead-end.
// ─────────────────────────────────────────────────────────────────────────────
describe('(a) HomeownerShell gate on /bids', () => {
  let originalLocation: Location;
  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: '' } });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('renders the bids body for an authenticated homeowner', () => {
    mockAuth(authed());
    render(<HomeownerShell active="bids"><div>BIDS_BODY</div></HomeownerShell>);
    expect(screen.getByText('BIDS_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('renders for a null/unresolved role (permissive, like requireAuth)', () => {
    mockAuth(authed({ role: null }));
    render(<HomeownerShell active="bids"><div>BIDS_BODY</div></HomeownerShell>);
    expect(screen.getByText('BIDS_BODY')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to get-started.html (NOT sign-in.html)', async () => {
    mockAuth(authed({ user: null, role: null }));
    render(<HomeownerShell active="bids"><div>BIDS_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/get-started.html');
    expect(window.location.href).not.toContain('sign-in.html');
    expect(screen.queryByText('BIDS_BODY')).not.toBeInTheDocument();
  });

  it('redirects a contractor to the contractor dashboard', () => {
    mockAuth(authed({ role: 'contractor' }));
    render(<HomeownerShell active="bids"><div>BIDS_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html');
    expect(screen.queryByText('BIDS_BODY')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) D-150 bid expiration — active / expiring / expired.
// ─────────────────────────────────────────────────────────────────────────────
describe('(b) D-150 bid expiry states', () => {
  it('active bid well before expiry shows no warning', () => {
    const e = deriveBidExpiry(bid({ expires_at: '2026-07-30' }), NOW);
    expect(e.state).toBe('active');
    expect(e.warning).toBe('');
  });

  it('expiring within 3 days warns with a pluralised day count', () => {
    const e = deriveBidExpiry(bid({ expires_at: '2026-06-24' }), NOW);
    expect(e.state).toBe('expiring');
    expect(e.daysUntilExpiry).toBe(2);
    expect(e.warning).toBe(
      '⚠️ This bid expires in 2 days. Select this contractor now to lock in this price.',
    );
  });

  it('uses the singular "1 day" form', () => {
    const e = deriveBidExpiry(bid({ expires_at: '2026-06-23' }), NOW);
    expect(e.daysUntilExpiry).toBe(1);
    expect(e.warning).toContain('expires in 1 day.');
  });

  it('expired bid (bid_status) reports the expired-on date and no warning', () => {
    const e = deriveBidExpiry(bid({ bid_status: 'expired', expires_at: '2026-06-01' }), NOW);
    expect(e.state).toBe('expired');
    expect(e.warning).toBe('');
    expect(e.expiredOn).toMatch(/2026/);
  });

  it('expired bid without a date falls back to "an earlier date"', () => {
    const e = deriveBidExpiry(bid({ bid_status: 'expired', expires_at: null }), NOW);
    expect(e.expiredOn).toBe('an earlier date');
  });

  it('renders the expired notice with the verbatim "why bids expire" tooltip on demand', () => {
    const onSelect = vi.fn();
    const onRenew = vi.fn();
    render(
      <BidCard
        bid={bid({ bid_status: 'expired', expires_at: '2026-06-01' })}
        bids={[bid({ bid_status: 'expired' })]}
        claim={{ id: 'c1', user_id: 'u1', status: 'active', job_type: 'retail' }}
        contractor={{ id: 'k1', company_name: 'Acme Roofing' }}
        onSelect={onSelect}
        onRenew={onRenew}
        now={NOW}
      />,
    );
    // Tooltip hidden until the (?) is clicked.
    expect(screen.queryByText(EXPIRY_TOOLTIP)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Why do bids expire?'));
    expect(screen.getByText(EXPIRY_TOOLTIP)).toBeInTheDocument();
    // Expired bid offers renewal, not selection.
    expect(screen.getByText('Request Updated Bid')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//     Action-button state machine (select / renew / contract / not-selected).
// ─────────────────────────────────────────────────────────────────────────────
describe('action button state machine', () => {
  it('offers selection on an open active bid', () => {
    const a = deriveBidAction({ id: 'c1', user_id: 'u1', status: 'active' }, bid());
    expect(a.kind).toBe('select');
    expect(a.label).toBe('Select This Contractor');
  });
  it('offers renewal on an expired bid', () => {
    const a = deriveBidAction({ id: 'c1', user_id: 'u1', status: 'active' }, bid({ bid_status: 'expired' }));
    expect(a.kind).toBe('renew');
  });
  it('links the winner to the contract-signing handoff once awarded', () => {
    const a = deriveBidAction(
      { id: 'c1', user_id: 'u1', status: 'awarded', selected_contractor_id: 'k1' },
      bid(),
    );
    expect(a.kind).toBe('awarded_selected');
    expect(a.href).toContain('contract-signing.html');
    expect(a.href).toContain('quote_id=b1');
  });
  it('disables the losing bids once awarded', () => {
    const a = deriveBidAction(
      { id: 'c1', user_id: 'u1', status: 'awarded', selected_contractor_id: 'other' },
      bid(),
    );
    expect(a.kind).toBe('not_selected');
    expect(a.disabled).toBe(true);
  });
  it('shows contract-signed state', () => {
    const a = deriveBidAction({ id: 'c1', user_id: 'u1', status: 'contract_signed' }, bid());
    expect(a.kind).toBe('contract_signed');
    expect(a.label).toBe('✓ Contract Signed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Cards ↔ Compare toggle + comparison-grid cell-state mapping.
// ─────────────────────────────────────────────────────────────────────────────
describe('(c) compare toggle + grid cell states', () => {
  const va = (extra: Record<string, unknown>) => ({ value_adds: extra });
  const contractors: Record<string, ContractorProfile> = {
    k1: { id: 'k1', company_name: 'Acme' },
    k2: { id: 'k2', company_name: 'Best' },
  };

  it('shows the toggle only with 2+ active bids', () => {
    expect(showCompareToggle([bid()])).toBe(false);
    expect(showCompareToggle([bid(), bid({ id: 'b2', contractor_id: 'k2' })])).toBe(true);
    // a second bid that is expired does not count
    expect(showCompareToggle([bid(), bid({ id: 'b2', contractor_id: 'k2', bid_status: 'expired' })])).toBe(false);
  });

  it('the grid renders the "needs 2 active bids" message below the threshold', () => {
    render(<BidsCompareGrid bids={[bid()]} contractors={contractors} />);
    expect(screen.getByText(/Comparison requires at least 2 active bids/)).toBeInTheDocument();
  });

  it('maps ✓ included / "$X OOP" / ✗ excluded / — n/a cell states and dims identical rows', () => {
    const b1 = bid({
      id: 'b1',
      contractor_id: 'k1',
      total_price: 10000,
      workmanship_warranty_years: 10,
      ...va({
        ice_water_shield: { coverage: 'standard' }, // included
        drip_edge: { option: 'oop', oop_price: 200 }, // OOP
        gutters: { option: 'none' }, // excluded
        // chimney absent → n/a
      }),
    });
    const b2 = bid({
      id: 'b2',
      contractor_id: 'k2',
      total_price: 12000,
      workmanship_warranty_years: 10, // identical row vs b1
      ...va({
        ice_water_shield: { coverage: 'enhanced' },
        drip_edge: { option: 'included_black' },
        gutters: { option: '5inch_included' },
      }),
    });

    const model = buildCompareModel([b1, b2], contractors);

    // Two headers; best price flag on the lower total (b1 @ $10,000).
    expect(model.headers).toHaveLength(2);
    expect(model.headers[0].isLowest).toBe(true);
    expect(model.headers[1].isLowest).toBe(false);

    const allRows = model.sections.flatMap((s) => s.rows);
    const cellFor = (label: string, i: number) => allRows.find((r) => r.label === label)!.cells[i];

    // ✓ included
    expect(cellFor('Ice & water shield', 0).cls).toBe('cell-included');
    expect(cellFor('Ice & water shield', 0).display).toBe('Standard (eaves & valleys)');
    // "$X OOP"
    expect(cellFor('Drip edge', 0).cls).toBe('cell-oop');
    expect(cellFor('Drip edge', 0).display).toBe('+$200 OOP');
    // ✗ excluded
    expect(cellFor('Gutters', 0).cls).toBe('cell-excluded');
    expect(cellFor('Gutters', 0).display).toBe('✗ Not offered');
    // — n/a
    expect(cellFor('Chimney work', 0).cls).toBe('cell-na');
    expect(cellFor('Chimney work', 0).display).toBe('— No chimney');

    // identical-row dimming: workmanship matches on both bids; total differs.
    expect(allRows.find((r) => r.label === 'Workmanship warranty')!.identical).toBe(true);
    expect(allRows.find((r) => r.label === 'Total price')!.identical).toBe(false);
  });

  it('renders the grid with both contractor headers above the threshold', () => {
    const b2 = bid({ id: 'b2', contractor_id: 'k2', total_price: 12000 });
    render(<BidsCompareGrid bids={[bid(), b2]} contractors={contractors} />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Best')).toBeInTheDocument();
    expect(screen.getByText('Total price')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//     Best-price / all-expired selectors.
// ─────────────────────────────────────────────────────────────────────────────
describe('best-price + all-expired selectors', () => {
  it('flags only the lowest active bid when 2+ compete', () => {
    const lo = bid({ id: 'b1', total_price: 9000 });
    const hi = bid({ id: 'b2', contractor_id: 'k2', total_price: 11000 });
    expect(isLowestPrice(lo, [lo, hi])).toBe(true);
    expect(isLowestPrice(hi, [lo, hi])).toBe(false);
  });
  it('does not flag a lone bid', () => {
    const only = bid();
    expect(isLowestPrice(only, [only])).toBe(false);
  });
  it('detects all-expired', () => {
    expect(isAllExpired([bid({ bid_status: 'expired' }), bid({ id: 'b2', bid_status: 'expired' })])).toBe(true);
    expect(isAllExpired([bid({ bid_status: 'expired' }), bid({ id: 'b2' })])).toBe(false);
    expect(isAllExpired([])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) Empty + error states render.
// ─────────────────────────────────────────────────────────────────────────────
describe('(e) empty + error states', () => {
  it('renders the no-bids-yet empty state with the waiting indicator', () => {
    render(<EmptyState />);
    expect(screen.getByText(EMPTY_STATE.title)).toBeInTheDocument();
    expect(screen.getByText(EMPTY_STATE.body)).toBeInTheDocument();
    expect(screen.getByText(/Contractors are reviewing your project details/)).toBeInTheDocument();
  });

  it('renders the error state', () => {
    render(<ErrorState />);
    expect(screen.getByText(/couldn.t load your bids/i)).toBeInTheDocument();
  });

  it('renders the all-expired banner', () => {
    render(<AllExpiredBanner />);
    expect(screen.getByText(/All bids on this project have expired/)).toBeInTheDocument();
  });

  it('shows the bid-updated banner only when there are unread updates', () => {
    const { rerender } = render(<BidUpdatedBanner count={0} onDismiss={() => {}} />);
    expect(screen.queryByText(/updated their bid/)).not.toBeInTheDocument();
    rerender(<BidUpdatedBanner count={2} onDismiss={() => {}} />);
    expect(screen.getByText(/2 contractors updated their bids/)).toBeInTheDocument();
  });
});
