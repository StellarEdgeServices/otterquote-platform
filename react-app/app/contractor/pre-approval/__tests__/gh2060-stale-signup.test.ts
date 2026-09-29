/**
 * gh-2060 -- `cs_contractor_signup` (localStorage) on the React pre-approval
 * page (SIGNUP_LS_KEY in ../page.tsx).
 *
 * The signup blob written by contractor-join.html carries the signer's
 * `email`, but nothing on the React side compares it to the signed-in user
 * before using it to build the new contractors row. An abandoned signup left
 * on a shared browser by ANOTHER person therefore seeds a stranger's company
 * name / contact / phone into the next brand-new contractor's row.
 *
 * CLOSED by gh-2340 / PR #2343: the page now reads the blob through
 * readOwnedContractorSignup(), which ignores (and clears) a blob whose email
 * does not match the signed-in user or whose `_at` stamp is missing/stale. The
 * former `it.fails` known-gap test is now a normal `it` asserting that.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { seedStaleStorage } from '@/test/storage-fixtures';
import { readOwnedContractorSignup } from '@/lib/contractor-signup-owner';
import { buildInitialContractorInsert, parseSignup } from '../utils';

const STRANGER_BLOB = JSON.stringify({
  email: 'stranger@example.com',
  company_name: 'Stranger Roofing LLC',
  contact_name: 'Sam Stranger',
  phone: '555-0100',
  _at: Date.now(),
});

describe('cs_contractor_signup -- stale blob on a shared browser (pre-approval)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('a corrupt stale blob parses to {} (no throw) and yields an empty-but-valid initial row', () => {
    seedStaleStorage({ localStorage: { cs_contractor_signup: '{"company_name": "half-writt' } });
    const signup = parseSignup(localStorage.getItem('cs_contractor_signup'));
    expect(signup).toEqual({});
    expect(buildInitialContractorInsert('u1', 'me@example.com', signup)).toMatchObject({
      user_id: 'u1',
      company_name: '',
      status: 'pending_approval',
    });
  });

  it('POSITIVE CONTROL: the user\'s own signup blob (same email) fills the initial row', () => {
    seedStaleStorage({
      localStorage: {
        cs_contractor_signup: JSON.stringify({ email: 'me@example.com', company_name: 'My Roofing', contact_name: 'Me Myself' }),
      },
    });
    const signup = parseSignup(localStorage.getItem('cs_contractor_signup'));
    expect(buildInitialContractorInsert('u1', 'me@example.com', signup)).toMatchObject({ company_name: 'My Roofing' });
  });

  it('a blob left by ANOTHER person (different email) is not used to build this user\'s row', () => {
    seedStaleStorage({ localStorage: { cs_contractor_signup: STRANGER_BLOB } });
    const owned = readOwnedContractorSignup('homeowner-turned-contractor@example.com');
    expect(owned).toBeNull();
    expect(localStorage.getItem('cs_contractor_signup')).toBeNull();
    const signup = parseSignup(owned ? JSON.stringify(owned) : null);
    const row = buildInitialContractorInsert('u-new', 'homeowner-turned-contractor@example.com', signup);
    expect(row.company_name).toBe('');
    expect(row.contact_name).toBe('');
  });
});
