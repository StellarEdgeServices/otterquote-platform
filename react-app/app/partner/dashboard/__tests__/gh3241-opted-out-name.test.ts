/**
 * gh-3241 (privacy.html 4.7): get_my_referrals() returns display_name = NULL for a referral whose homeowner opted out
 * of updates to their referrer (claims.referrer_updates_opt_out). No new wording: each page renders exactly what it
 * already renders for a missing name. Whether that existing text is right for an opted-out row is Tier C copy for Dustin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { referralClientName, ownReferralsFromRpc, type PartnerReferral } from '../utils';
import { referralFriendName } from '../../../refer/utils';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

describe('an opted-out row (display_name null) keeps its row and uses the existing missing-name text', () => {
  it('React partner dashboard: Visitor', () => {
    expect(referralClientName({ display_name: null })).toBe('Visitor');
  });
  it('React refer page: Referral #N', () => {
    expect(referralFriendName({ display_name: null }, 2)).toBe('Referral #3');
  });
  it('the row is not filtered out client-side', () => {
    const rows: PartnerReferral[] = [
      { id: 'opted-out', referral_agent_id: 'agent-1', created_at: '2026-10-01T00:00:00Z', status: 'claim_submitted', display_name: null },
    ];
    expect(ownReferralsFromRpc(rows, 'agent-1').map((r) => [r.id, r.status])).toEqual([['opted-out', 'claim_submitted']]);
  });
  it('static pages keep their existing fallbacks (no new string)', () => {
    expect(read('partner-dashboard.html')).toContain("escapeHtml(ref.display_name || 'Visitor')");
    expect(read('refer-a-friend.html')).toContain("r.display_name || ('Referral #' + (i + 1))");
  });
});
