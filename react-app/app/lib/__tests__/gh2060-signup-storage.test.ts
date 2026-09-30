/**
 * gh-2060 item 2 -- `cs_signup` (name/phone/address blob written by get-started)
 * must not outlive its flow on a shared browser. 24h TTL keyed on `cs_signup_at`;
 * a missing, future-dated or stale stamp means the blob is ignored AND cleared.
 * Every case seeds the dirty state with seedStaleStorage() (after this file's own
 * clean beforeEach) and runs the REAL readers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedStaleStorage } from '@/test/storage-fixtures';
import { CS_SIGNUP_TTL_MS, readFreshSignupRaw, stampSignup } from '@/lib/signup-storage';
import { readReferralSourceFromCsSignup } from '@/auth-callback/signup-analytics';

const STRANGER = JSON.stringify({ first_name: 'Sam', last_name: 'Stranger', phone: '555-0100', referral_source: 'realtor' });
const DAY = CS_SIGNUP_TTL_MS;

describe('cs_signup -- stale blob left by an abandoned signup', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('a blob older than 24h is ignored and cleared (stamp too)', () => {
    seedStaleStorage({ localStorage: { cs_signup: STRANGER, cs_signup_at: String(Date.now() - DAY - 1000) } });
    expect(readFreshSignupRaw()).toBeNull();
    expect(localStorage.getItem('cs_signup')).toBeNull();
    expect(localStorage.getItem('cs_signup_at')).toBeNull();
  });

  it('a blob with NO stamp (pre-fix write / stranger leftover) is ignored and cleared', () => {
    seedStaleStorage({ localStorage: { cs_signup: STRANGER } });
    expect(readFreshSignupRaw()).toBeNull();
    expect(localStorage.getItem('cs_signup')).toBeNull();
  });

  it('a FUTURE-dated stamp (negative age) is not "fresh"', () => {
    seedStaleStorage({ localStorage: { cs_signup: STRANGER, cs_signup_at: String(Date.now() + DAY) } });
    expect(readFreshSignupRaw()).toBeNull();
  });

  it('a garbage stamp is not "fresh"', () => {
    seedStaleStorage({ localStorage: { cs_signup: STRANGER, cs_signup_at: 'not-a-number' } });
    expect(readFreshSignupRaw()).toBeNull();
  });

  it('POSITIVE CONTROL: a blob stamped a minute ago is returned, and reading does not consume it', () => {
    seedStaleStorage({ localStorage: { cs_signup: STRANGER, cs_signup_at: String(Date.now() - 60_000) } });
    expect(readFreshSignupRaw()).toBe(STRANGER);
    expect(localStorage.getItem('cs_signup')).toBe(STRANGER);
  });

  it('stampSignup() (get-started) makes a just-written blob fresh', () => {
    localStorage.setItem('cs_signup', STRANGER);
    stampSignup();
    expect(readFreshSignupRaw()).toBe(STRANGER);
  });

  it('a downstream reader (readReferralSourceFromCsSignup) sees nothing from a stale blob, and the real value from a fresh one', () => {
    seedStaleStorage({ localStorage: { cs_signup: STRANGER, cs_signup_at: String(Date.now() - DAY - 1000) } });
    expect(readReferralSourceFromCsSignup()).toBe('');
    seedStaleStorage({ localStorage: { cs_signup: STRANGER, cs_signup_at: String(Date.now()) } });
    expect(readReferralSourceFromCsSignup()).toBe('realtor');
  });
});
