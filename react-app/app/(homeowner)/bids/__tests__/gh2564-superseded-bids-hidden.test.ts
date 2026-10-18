import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activeBids,
  deriveBidAction,
  isLowestPrice,
  isSupersededBid,
  showCompareToggle,
  visibleBids,
} from '../utils';
import type { BidRow } from '../types';

const bid = (over: Partial<BidRow> = {}): BidRow =>
  ({ id: 'b1', claim_id: 'c1', contractor_id: 'k1', total_price: 10000, bid_status: 'active', ...over }) as BidRow;

const live = bid({ id: 'live', contractor_id: 'k1', total_price: 9000 });
const retired = bid({ id: 'retired', contractor_id: 'k2', total_price: 100, status: 'declined', bid_status: 'superseded' } as Partial<BidRow>);
const live2 = bid({ id: 'live2', contractor_id: 'k3', total_price: 9500 });

describe('gh-2564: a superseded bid is retired and hidden from the award list', () => {
  it('visibleBids drops the superseded bid and keeps every other bid', () => {
    expect(visibleBids([live, retired, live2]).map((b) => b.id)).toEqual(['live', 'live2']);
    // NEGATIVE CONTROL: an expired and a withdrawn bid are NOT dropped here (they keep their own existing handling)
    const exp = bid({ id: 'exp', bid_status: 'expired' });
    const wd = bid({ id: 'wd', bid_status: 'cancelled' });
    expect(visibleBids([live, exp, wd]).map((b) => b.id)).toEqual(['live', 'exp', 'wd']);
    expect(isSupersededBid(live)).toBe(false);
    expect(isSupersededBid(retired)).toBe(true);
  });

  it('a superseded bid does not compete: not in activeBids, not Best Price, not counted for compare', () => {
    expect(activeBids([live, retired, live2]).map((b) => b.id)).toEqual(['live', 'live2']);
    expect(isLowestPrice(retired, [live, retired, live2])).toBe(false);
    expect(isLowestPrice(live, [live, retired, live2])).toBe(true);
    expect(showCompareToggle([live, retired])).toBe(false);
    // NEGATIVE CONTROL: the same bid with a live status DOES compete and takes Best Price
    const revived = { ...retired, bid_status: 'active' } as BidRow;
    expect(activeBids([live, revived]).map((b) => b.id)).toEqual(['live', 'retired']);
    expect(isLowestPrice(revived, [live, revived, live2])).toBe(true);
    expect(showCompareToggle([live, revived])).toBe(true);
  });

  it('a superseded bid is never offered the select button (existing "Not Selected" label, no new wording)', () => {
    const claim = { id: 'c1', user_id: 'u1', status: 'active' };
    const a = deriveBidAction(claim, retired);
    expect(a.kind).toBe('not_selected');
    expect(a.label).toBe('Not Selected');
    expect(a.disabled).toBe(true);
    // NEGATIVE CONTROL: a live bid on the same claim still gets Select
    expect(deriveBidAction(claim, live).kind).toBe('select');
  });
});

describe('gh-2564: the homeowner bids page wires the filter', () => {
  const page = readFileSync(resolve(__dirname, '../page.tsx'), 'utf8');
  it('page.tsx derives its bid list through visibleBids and guards onSelect', () => {
    expect(page).toMatch(/visibleBids\(rawBids as unknown as BidRow\[\]\)/);
    expect(page).toMatch(/!isSupersededBid\(bid\)\) setPending\(bid\)/);
  });
});
