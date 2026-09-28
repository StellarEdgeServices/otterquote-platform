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
 * KNOWN GAP (Q on #2060): the RECOMMENDED DEFAULT (ignore a blob whose email
 * does not match the signed-in user) is encoded below with `it.fails` -- it
 * passes while the gap exists and turns red when the fix lands (flip to `it`).
 * Not implemented here because a contractor who signs up with one email and
 * authenticates with a different Google account would lose their signup data
 * -- a product call, not a test-coverage call.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { seedStaleStorage } from '@/test/storage-fixtures';
import { buildInitialContractorInsert, parseSignup } from '../utils';

const STRANGER_BLOB = JSON.stringify({
  email: 'stranger@example.com',
  company_name: 'Stranger Roofing LLC',
  contact_name: 'Sam Stranger',
  phone: '555-0100',
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

  it.fails('KNOWN GAP: a blob left by ANOTHER person (different email) is not used to build this user\'s row', () => {
    seedStaleStorage({ localStorage: { cs_contractor_signup: STRANGER_BLOB } });
    const signup = parseSignup(localStorage.getItem('cs_contractor_signup'));
    const row = buildInitialContractorInsert('u-new', 'homeowner-turned-contractor@example.com', signup);
    expect(row.company_name).toBe('');
    expect(row.contact_name).toBe('');
  });
});
