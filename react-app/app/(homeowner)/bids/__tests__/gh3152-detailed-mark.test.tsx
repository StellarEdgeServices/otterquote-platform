import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import { BidCard } from '../components/BidCard';
import type { BidRow, BidsClaim, ContractorProfile } from '../types';

/**
 * gh-3152 / D-317 cl. 5 -- homeowner bid card carries "Bid on detailed
 * measurements" on Shape B ('full') claims only. NEGATIVE CONTROL: Shape A
 * (basic / NULL / absent column) shows nothing.
 */
const bid = { id: 'b1', claim_id: 'c1', contractor_id: 'k1', bid_status: 'submitted' } as BidRow;
const contractor = { id: 'k1', company_name: 'Acme Roofing' } as ContractorProfile;
const mk = (extra: Record<string, unknown>) => ({ id: 'c1', user_id: 'u1', status: 'bidding', ...extra }) as BidsClaim;
const draw = (claim: BidsClaim | null) =>
  render(<BidCard bid={bid} bids={[bid]} claim={claim} contractor={contractor} onSelect={vi.fn()} onRenew={vi.fn()} />);

describe('BidCard detailed-measurements mark (gh-3152)', () => {
  it('Shape B (full) shows the verbatim D-317 cl. 5 wording', () => {
    const { container } = draw(mk({ measurement_shape: 'full' }));
    expect(screen.getByText('Bid on detailed measurements')).toBeTruthy();
    expect(container.querySelectorAll('[data-gh3152-detailed-mark]').length).toBe(1);
  });

  it('NEGATIVE CONTROL: Shape A (basic, NULL, absent, unexpected, no claim) shows no mark', () => {
    for (const c of [
      mk({ measurement_shape: 'basic' }),
      mk({ measurement_shape: null }),
      mk({}),
      mk({ measurement_shape: 'FULL' }),
      null,
    ]) {
      const { container, unmount } = draw(c);
      expect(screen.queryByText('Bid on detailed measurements')).toBeNull();
      expect(container.querySelector('[data-gh3152-detailed-mark]')).toBeNull();
      unmount();
    }
  });
});
