/**
 * gh-2060 -- `oq_hp_dismissed_<claimId>` (localStorage) on the homeowner
 * dashboard's D-231 home-profile prompt.
 *
 * Dismissal is meant to persist PER CLAIM. The stale-state questions on a
 * shared browser are: does one claim's dismissal hide the prompt on ANOTHER
 * claim (a different homeowner's, or this one's next job), and does a
 * dismissal for this claim still hold across a remount (the design).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { seedStaleStorage } from '@/test/storage-fixtures';

vi.mock('../actions', () => ({ saveHomeProfile: vi.fn() }));

import { HomeProfilePrompt } from '../components/HomeProfilePrompt';
import { homeProfileDismissKey } from '../utils';
import type { HomeownerClaim, HomeownerProfile } from '../types';

const claim = (id: string) =>
  ({
    id,
    user_id: 'u1',
    status: 'contract_signed',
    completion_date: '2026-09-01',
  }) as unknown as HomeownerClaim;
const profile = { id: 'u1' } as unknown as HomeownerProfile;
const PROMPT = 'Keep your home profile for next time';

describe('oq_hp_dismissed_<claimId> -- stale dismissal flag', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(cleanup);

  it("another claim's dismissal (left on this browser) does not hide the prompt on THIS claim", () => {
    seedStaleStorage({ localStorage: { [homeProfileDismissKey('claim_other')]: String(Date.now()) } });
    render(<HomeProfilePrompt claim={claim('claim_mine')} profile={profile} hasHomeProfile={false} />);
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });

  it("this claim's own earlier dismissal still holds on a fresh mount (persist-per-claim design -- pinned)", () => {
    seedStaleStorage({ localStorage: { [homeProfileDismissKey('claim_mine')]: String(Date.now()) } });
    render(<HomeProfilePrompt claim={claim('claim_mine')} profile={profile} hasHomeProfile={false} />);
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it('POSITIVE CONTROL: with clean storage the prompt shows', () => {
    render(<HomeProfilePrompt claim={claim('claim_mine')} profile={profile} hasHomeProfile={false} />);
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });
});
