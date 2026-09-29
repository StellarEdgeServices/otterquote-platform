/** gh-2340 -- unit tests for readOwnedContractorSignup (owner + 24h guard). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readOwnedContractorSignup } from '../contractor-signup-owner';

const KEY = 'cs_contractor_signup';
const NOW = 1_800_000_000_000;
const put = (o: Record<string, unknown>) => localStorage.setItem(KEY, JSON.stringify(o));

describe('readOwnedContractorSignup', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns the blob for the same email (case/space-insensitive) with a fresh stamp', () => {
    put({ email: 'Me@Example.com ', company_name: 'Mine', _at: NOW - 1000 });
    expect(readOwnedContractorSignup(' me@example.com', NOW)).toMatchObject({ company_name: 'Mine' });
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it('accepts the stamp from the cs_contractor_signup_at key when the blob has none', () => {
    put({ email: 'me@example.com', company_name: 'Mine' });
    localStorage.setItem(`${KEY}_at`, String(NOW - 1000));
    expect(readOwnedContractorSignup('me@example.com', NOW)).not.toBeNull();
  });

  it.each([
    ['foreign email', { email: 'other@example.com', _at: NOW - 1000 }],
    ['no email in blob', { _at: NOW - 1000 }],
    ['no stamp', { email: 'me@example.com' }],
    ['stale (>=24h)', { email: 'me@example.com', _at: NOW - 24 * 3600 * 1000 }],
    ['future-dated', { email: 'me@example.com', _at: NOW + 1000 }],
  ])('rejects and clears: %s', (_n, blob) => {
    put(blob as Record<string, unknown>);
    expect(readOwnedContractorSignup('me@example.com', NOW)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(`${KEY}_at`)).toBeNull();
  });

  it('rejects when the signed-in user has no email; an unparseable blob is cleared', () => {
    put({ email: 'me@example.com', _at: NOW - 1000 });
    expect(readOwnedContractorSignup(undefined, NOW)).toBeNull();
    localStorage.setItem(KEY, '{"half');
    expect(readOwnedContractorSignup('me@example.com', NOW)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
