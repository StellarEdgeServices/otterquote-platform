/**
 * gh-3334 (D-407 follow-up): a measurement-only ACV homeowner can submit for bids from the dashboard
 * checklist. RCV still requires the insurance estimate (negative control). No new homeowner text.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../actions', () => ({
  submitForBids: vi.fn(),
  uploadClaimDocument: vi.fn(),
}));

import { Checklist } from '../components/Checklist';
import { isChecklistComplete } from '../utils';
import type { HomeownerClaim } from '../types';

const claim = (o: Partial<HomeownerClaim>): HomeownerClaim => ({
  id: 'c1',
  user_id: 'u1',
  status: 'draft',
  is_test: true,
  ready_for_bids: false,
  has_material_selection: true,
  funding_type: 'insurance',
  ...o,
});
const submitBtn = () => screen.queryByRole('button', { name: 'Submit for Bids' });
const view = (c: HomeownerClaim) => render(<Checklist claim={c} userId="u1" onChange={() => {}} />);

describe('gh-3334 dashboard Submit-for-Bids gate', () => {
  it('ACV with only a purchased measurement can submit', () => {
    view(claim({ policy_type: 'acv', has_estimate: false, has_measurements: true }));
    expect(submitBtn()).not.toBeNull();
  });
  it('ACV with only an estimate can submit', () => {
    view(claim({ policy_type: 'acv', has_estimate: true, has_measurements: false }));
    expect(submitBtn()).not.toBeNull();
  });
  it('ACV with neither cannot submit', () => {
    view(claim({ policy_type: 'acv', has_estimate: false, has_measurements: false }));
    expect(submitBtn()).toBeNull();
  });
  it('NEGATIVE CONTROL: RCV with only measurements still cannot submit', () => {
    view(claim({ policy_type: 'rcv', has_estimate: false, has_measurements: true }));
    expect(submitBtn()).toBeNull();
  });
  it('RCV with the estimate can submit', () => {
    view(claim({ policy_type: 'rcv', has_estimate: true }));
    expect(submitBtn()).not.toBeNull();
  });
  it('cash still gates on measurements only', () => {
    expect(isChecklistComplete(claim({ funding_type: 'cash', has_measurements: true }))).toBe(true);
    expect(isChecklistComplete(claim({ funding_type: 'cash', has_estimate: true, has_measurements: false }))).toBe(false);
  });
  it('material selection is always required', () => {
    expect(isChecklistComplete(claim({ policy_type: 'acv', has_measurements: true, has_material_selection: false }))).toBe(false);
  });
});
