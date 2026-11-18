/**
 * gh-3783 (D-375) — a contractor never sees windows on a claim (opportunity card + bid-form claim row).
 */
import { describe, it, expect } from 'vitest';
import { mapClaimToOpportunity, tradeReleaseBadges, tradeDisplay } from '../utils';
import { stripWindowsTrades } from '../../bid/[claimId]/utils';

describe('gh-3783 windows hidden from contractors', () => {
  const claim = {
    id: 'c1', trades: ['roofing', 'windows'], job_type: 'insurance_rcv',
    roofing_bid_released_at: '2026-11-01T00:00:00Z', windows_bid_released_at: null,
  } as never;

  it('opportunity card for a roofing + windows claim lists no windows and no status line for it', () => {
    const opp = mapClaimToOpportunity(claim, null, null);
    expect(opp.trades).toEqual(['roofing']);
    const badges = tradeReleaseBadges(opp);
    expect(JSON.stringify(badges)).not.toMatch(/windows/i);
    expect(tradeDisplay(opp.trades)).not.toMatch(/windows/i);
  });

  it('bid-form claim row loses windows from trades and selected_trades (so no pre-ticked checkbox or price field)', () => {
    const row = stripWindowsTrades({ id: 'c1', trades: ['roofing', 'Windows'], selected_trades: ['windows', 'roofing'] });
    expect(row.trades).toEqual(['roofing']);
    expect(row.selected_trades).toEqual(['roofing']);
  });
});
