import { describe, it, expect } from 'vitest';
import { deriveBidAction } from '../utils';
import type { BidRow, BidsClaim } from '../types';

// gh-3863: on a contract_signed claim only the selected contractor's quote shows "Contract Signed".
const bid = (over: Partial<BidRow> = {}): BidRow =>
  ({ id: 'q1', claim_id: 'c1', contractor_id: 'K1', total_price: 10000, bid_status: 'active', ...over }) as BidRow;
const claim = (status: string): BidsClaim =>
  ({ id: 'c1', status, selected_contractor_id: 'K2' }) as unknown as BidsClaim;

describe('gh-3863: Contract Signed only on the selected contractor card', () => {
  const signed = claim('contract_signed');

  it('selected contractor quote shows Contract Signed', () => {
    const a = deriveBidAction(signed, bid({ id: 'q2', contractor_id: 'K2' }));
    expect(a.kind).toBe('contract_signed');
    expect(a.label).toBe('✓ Contract Signed');
  });

  it('a not-selected quote shows Not Selected, not Contract Signed', () => {
    const a = deriveBidAction(signed, bid({ contractor_id: 'K1' }));
    expect(a).toEqual({ kind: 'not_selected', label: 'Not Selected', disabled: true });
  });

  it("a withdrawn ('cancelled') quote shows Not Selected, not Contract Signed", () => {
    const a = deriveBidAction(signed, bid({ contractor_id: 'K1', bid_status: 'cancelled' }));
    expect(a).toEqual({ kind: 'not_selected', label: 'Not Selected', disabled: true });
  });

  it('awarded claim is unchanged', () => {
    expect(deriveBidAction(claim('awarded'), bid({ id: 'q2', contractor_id: 'K2' })).label).toBe('View Contract Status →');
    expect(deriveBidAction(claim('awarded'), bid({ contractor_id: 'K1' })).label).toBe('Not Selected');
  });

  it('open claim is unchanged', () => {
    const open = claim('open');
    expect(deriveBidAction(open, bid({ contractor_id: 'K1' })).label).toBe('Select This Contractor');
    expect(deriveBidAction(open, bid({ contractor_id: 'K1', bid_status: 'cancelled' })).label).toBe('Bid Withdrawn');
    expect(deriveBidAction(open, bid({ contractor_id: 'K1', bid_status: 'expired' })).label).toBe('Request Updated Bid');
  });
});
