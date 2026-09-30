/**
 * gh-2344 follow-up: the breadcrumb owner is a one-way tag, never the signer's address.
 * NEGATIVE CONTROL is inline: the assertions that no `@` reaches localStorage would fail against the pre-change helper
 * (which stored the trimmed, lowercased address).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerTag, roleOwnerMatches, stampRoleOwner, ROLE_EMAIL_KEY } from '../role-breadcrumb-owner';

const PINNED: Record<string, string> = {
  'jane@example.com': 'o1:neluii2dtz',
  'pro@roofco.com': 'o1:76wg51j7m3',
  'a@b.co': 'o1:15jc75fqa7',
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('ownerTag', () => {
  it('is normalised, shaped o1:<base36>, never contains the address, and is empty for empty input', () => {
    expect(ownerTag('  Jane@Example.COM ')).toBe(ownerTag('jane@example.com'));
    expect(ownerTag('jane@example.com')).toMatch(/^o1:[0-9a-z]+$/);
    expect(ownerTag('jane@example.com')).not.toContain('@');
    expect(ownerTag('jane@example.com')).not.toBe(ownerTag('john@example.com'));
    expect(ownerTag('')).toBe('');
    expect(ownerTag(undefined)).toBe('');
  });

  it('matches known cyrb53 values (pins the byte-identical js/auth.js and index.html copies)', () => {
    // Values computed from the real Auth.ownerTag in js/auth.js; tests/gh2344-owner-tag-parity.mjs pins the three copies.
    expect(ownerTag('jane@example.com')).toBe(PINNED['jane@example.com']);
    expect(ownerTag('pro@roofco.com')).toBe(PINNED['pro@roofco.com']);
    expect(ownerTag('a@b.co')).toBe(PINNED['a@b.co']);
  });
});

describe('stampRoleOwner / roleOwnerMatches', () => {
  it('stores the tag, not the address, and no localStorage value contains an @', () => {
    stampRoleOwner('Jane@Example.com');
    expect(localStorage.getItem(ROLE_EMAIL_KEY)).toBe(ownerTag('jane@example.com'));
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.getItem(localStorage.key(i) as string)).not.toContain('@');
    }
  });

  it('matches the same signer (case/space-insensitive) and rejects a different signer, an empty email, and a raw-address (legacy) value', () => {
    stampRoleOwner('jane@example.com');
    expect(roleOwnerMatches(' JANE@example.com ')).toBe(true);
    expect(roleOwnerMatches('stranger@example.com')).toBe(false);
    expect(roleOwnerMatches('')).toBe(false);
    localStorage.setItem(ROLE_EMAIL_KEY, 'jane@example.com');
    expect(roleOwnerMatches('jane@example.com')).toBe(false);
  });

  it('oauth-tab: owner form is unchanged (honoured only in the tab that wrote the nonce)', () => {
    stampRoleOwner(null);
    const stored = localStorage.getItem(ROLE_EMAIL_KEY) as string;
    expect(stored).toBe('oauth-tab:' + sessionStorage.getItem('cs_auth_role_tab'));
    expect(roleOwnerMatches(null)).toBe(true);
    sessionStorage.clear();
    expect(roleOwnerMatches(null)).toBe(false);
  });
});

