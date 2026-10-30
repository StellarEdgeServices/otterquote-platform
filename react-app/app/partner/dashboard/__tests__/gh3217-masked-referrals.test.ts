/**
 * gh-3217 (privacy.html 4.7): partners and customer referrers see a referred homeowner by first name and
 * last initial only. The lists come from the get_my_referrals() RPC; direct reads of the homeowner contact
 * columns on `referrals` are revoked in the database (draft migration gh3217_mask_referral_homeowner).
 *
 * FAIL-FIRST: against origin/main the pages run `.from('referrals').select('*')` and render
 * homeowner_name || homeowner_email, so the static assertions below fail and ownReferralsFromRpc does not exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ownReferralsFromRpc, referralClientName, type PartnerReferral } from '../utils';
import { referralFriendName } from '../../../refer/utils';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

describe('ownReferralsFromRpc', () => {
  const rows: PartnerReferral[] = [
    { id: 'a', referral_agent_id: 'agent-1', created_at: '2026-10-01T00:00:00Z', display_name: 'Jane Q.' },
    { id: 'b', referral_agent_id: 'agent-2', created_at: '2026-10-02T00:00:00Z', display_name: 'Bob B.' },
    { id: 'c', referral_agent_id: 'agent-1', created_at: '2026-10-03T00:00:00Z', display_name: null },
  ];
  it('keeps only the given agent, newest first', () => {
    expect(ownReferralsFromRpc(rows, 'agent-1').map((r) => r.id)).toEqual(['c', 'a']);
  });
  it('returns [] for null, undefined or an unknown agent', () => {
    expect(ownReferralsFromRpc(null, 'agent-1')).toEqual([]);
    expect(ownReferralsFromRpc(undefined, 'agent-1')).toEqual([]);
    expect(ownReferralsFromRpc(rows, 'nobody')).toEqual([]);
  });
});

describe('name cells never fall back to an email or the raw name', () => {
  it('partner dashboard', () => {
    expect(referralClientName({ display_name: 'Jane Q.' })).toBe('Jane Q.');
    expect(referralClientName({ display_name: undefined })).toBe('Visitor');
  });
  it('refer-a-friend', () => {
    expect(referralFriendName({ display_name: 'Jane Q.' }, 0)).toBe('Jane Q.');
    expect(referralFriendName({}, 1)).toBe('Referral #2');
  });
});

describe('client sources read referrals through get_my_referrals() only', () => {
  const sources = [
    'react-app/app/partner/dashboard/page.tsx',
    'react-app/app/refer/page.tsx',
    'partner-dashboard.html',
    'refer-a-friend.html',
  ];
  for (const f of sources) {
    it(`${f}: calls the RPC, no select('*') on referrals, no homeowner contact columns`, () => {
      const src = read(f);
      expect(src).toContain("rpc('get_my_referrals')");
      expect(src).not.toMatch(/from\('referrals'\)\s*\.select\('\*'\)/);
      expect(src).not.toMatch(/homeowner_(email|phone|name)/);
    });
  }
});
