import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, waitFor, screen } from '@testing-library/react';

// gh-3042 closing artifact: end-to-end (hook -> modal) render under a simulated
// homeowner RLS regime. The `contractors` base table returns ZERO rows to a
// homeowner (own-record + admin only); the get_contractors_public() RPC returns
// the active contractor. useBidContractors feeds the same map to the bid card and
// the select modal (page.tsx), so the modal's confirmation must show the name.
const ROW = {
  id: '2bc792be-0000-0000-0000-000000000000',
  company_name: 'Video Walk Test Roofing 2 LLC',
  status: 'active',
  license_doc_state: 'uploaded',
};
const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, from } }));
vi.mock('../actions', () => ({
  awardClaimToContractor: vi.fn(),
  checkContractorPaymentMethod: vi.fn(),
  notifyContractorPaymentNeeded: vi.fn(),
  resolveOwnerPhotoUrl: vi.fn(),
}));

import { useBidContractors } from '../use-bids-data';
import { SelectContractorModal } from '../components/SelectContractorModal';
import type { BidRow, BidsClaim } from '../types';

const bid = { id: 'b1', claim_id: 'c1', contractor_id: ROW.id, bid_status: 'submitted' } as BidRow;
const claim = { id: 'c1', user_id: 'u1', status: 'bidding', is_test: true } as unknown as BidsClaim;

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  // RLS: a homeowner SELECT on the base table resolves to zero rows, no error.
  from.mockReturnValue({ select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) });
  // Public RPC: returns the active contractor.
  rpc.mockReturnValue({ select: () => ({ in: () => Promise.resolve({ data: [ROW], error: null }) }) });
});

describe('is_test claim: select-modal confirmation under homeowner RLS', () => {
  it('shows the selected contractor company name sourced from the bid-card contractor map', async () => {
    const { result } = renderHook(() => useBidContractors([bid]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Same lookup page.tsx performs for both the card and the modal.
    const contractor = result.current.contractors[bid.contractor_id] || { id: bid.contractor_id };
    render(<SelectContractorModal bid={bid} claim={claim} contractor={contractor} onClose={() => {}} />);
    expect(screen.getByRole('dialog').textContent).toContain("You're selecting Video Walk Test Roofing 2 LLC.");
    expect(screen.getByText('Video Walk Test Roofing 2 LLC').tagName).toBe('STRONG');
  });
});
