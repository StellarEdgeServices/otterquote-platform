/**
 * Unit tests for the trade-selector signup address parser (gh-1579).
 *
 * George Milberger's real signup address arrived as "9000 Windpointe Pass,
 * Zionsville IN 46077" — 2 comma segments, not the 4 the old
 * `address.split(',')` / index-[1..3] parser assumed — so address_city
 * absorbed "Zionsville IN 46077" whole and address_state / address_zip /
 * claims.property_state were all written NULL. parseAddress() is pure; no
 * DOM, network, or Supabase is touched.
 */

import { describe, it, expect } from 'vitest';
import { parseAddress } from '../utils';

describe('parseAddress (gh-1579)', () => {
  it('parses the real production defect shape: "street, city ST zip" (2 comma segments)', () => {
    // The exact George Milberger address pasted on #1570/#1579.
    expect(parseAddress('9000 Windpointe Pass, Zionsville IN 46077')).toEqual({
      street: '9000 Windpointe Pass',
      city: 'Zionsville',
      state: 'IN',
      zip: '46077',
    });
  });

  it('parses "street, city, ST zip" (3 comma segments — state and zip share the last segment)', () => {
    expect(parseAddress('123 Main St, Springfield, IL 62701')).toEqual({
      street: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
    });
  });

  it('parses "street, city, ST, zip" (the legacy 4-segment happy path) — no regression', () => {
    expect(parseAddress('123 Main St, Springfield, IL, 62701')).toEqual({
      street: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
    });
  });

  it('parses "street city ST zip" with no commas at all', () => {
    expect(parseAddress('123 Main St Springfield IL 62701')).toEqual({
      street: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
    });
  });

  it('parses a Google-Places-formatted address (trailing ", USA" country segment)', () => {
    expect(parseAddress('1600 Amphitheatre Parkway, Mountain View, CA 94043, USA')).toEqual({
      street: '1600 Amphitheatre Parkway',
      city: 'Mountain View',
      state: 'CA',
      zip: '94043',
    });
  });

  it('uppercases a lowercase-typed state token', () => {
    expect(parseAddress('123 Main St, Springfield, il, 62701')).toEqual({
      street: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
    });
  });

  it('supports a ZIP+4 in the trailing state/zip token', () => {
    expect(parseAddress('9000 Windpointe Pass, Zionsville IN 46077-1234')).toEqual({
      street: '9000 Windpointe Pass',
      city: 'Zionsville',
      state: 'IN',
      zip: '46077',
    });
  });

  it('never writes a city string containing the state token', () => {
    const parsed = parseAddress('9000 Windpointe Pass, Zionsville IN 46077');
    expect(parsed.city).not.toContain('IN');
    expect(parsed.city).not.toContain('46077');
  });

  it('returns all-null for an empty or whitespace-only address', () => {
    expect(parseAddress('')).toEqual({ street: null, city: null, state: null, zip: null });
    expect(parseAddress('   ')).toEqual({ street: null, city: null, state: null, zip: null });
    expect(parseAddress(null)).toEqual({ street: null, city: null, state: null, zip: null });
    expect(parseAddress(undefined)).toEqual({ street: null, city: null, state: null, zip: null });
  });

  it('falls back gracefully on a bare street with no city/state/zip', () => {
    expect(parseAddress('9000 Windpointe Pass')).toEqual({
      street: '9000 Windpointe Pass',
      city: null,
      state: null,
      zip: null,
    });
  });

  describe('gh-1579 follow-up: street-suffix abbreviation must not be captured as state', () => {
    // A comma-less address ending in a common USPS street-suffix
    // abbreviation + 5 digits used to satisfy TRAILING_STATE_ZIP_RE and get
    // torn apart, with the suffix mis-captured as "state" (some of these,
    // like "CT", are real state codes — worse than the NULL this PR set
    // out to fix, since a wrong-but-valid state silently passes the
    // downstream D-178 state gate). These must now fall through to the
    // legacy comma-split fallback — same as any other regex miss — which
    // returns the *entire* string as street and leaves city/state/zip
    // null, rather than fabricating a state and truncating the street.
    it.each([
      '123 Oak Ct 12345',
      '45 Elm Rd 60614',
      '9 Bay Ln 30301',
      '12 Sunset Dr 90210',
      '500 Main Pl 10001',
    ])('does not mangle "%s" into a fabricated state', (address) => {
      expect(parseAddress(address)).toEqual({
        street: address,
        city: null,
        state: null,
        zip: null,
      });
    });

    // "Ct" is both the Court street suffix AND a real state code
    // (Connecticut), so it can't be resolved by the whitelist alone. When
    // a comma has already separated a city segment, trust it as the state
    // — this is the common "street, city ST zip" shape the PR targets, and
    // a genuine Hartford, CT address must keep working.
    it('still trusts "CT" as Connecticut when a comma marks a real city segment', () => {
      expect(parseAddress('45 Main St, Hartford CT 06103')).toEqual({
        street: '45 Main St',
        city: 'Hartford',
        state: 'CT',
        zip: '06103',
      });
    });
  });

  describe('gh-1579 round 3: full USPS-suffix/state collision set (CT, KY, MT, PR, WY)', () => {
    // The round-2 fix hand-picked only "CT" and missed "Wy" (Way vs.
    // Wyoming) — the identical defect class one suffix over. The round-3
    // fix derives the full intersection of 2-letter USPS Pub-28 suffix
    // abbreviations against VALID_STATE_CODES instead of hand-picking, so
    // these cases lock in every member of that derived set, not just the
    // one a reviewer happened to notice.

    it.each([
      // Wy = Way, collides with Wyoming. The exact inputs from the FAIL
      // review that caught the round-2 gap.
      ['100 Sunset Wy 90210', 'WY/Way'],
      ['400 Fair Wy 82001', 'WY/Way'],
      // Ky = Key, collides with Kentucky.
      ['12 Compass Ky 40202', 'KY/Key'],
      // Mt = Mount, collides with Montana.
      ['5 Fair Mt 59601', 'MT/Mount'],
      // Pr = Prairie, collides with Puerto Rico.
      ['20 Rolling Pr 78701', 'PR/Prairie'],
    ])('does not mangle comma-less "%s" (%s) into a fabricated state', (address) => {
      expect(parseAddress(address)).toEqual({
        street: address,
        city: null,
        state: null,
        zip: null,
      });
    });

    it.each([
      ['123 Main St, Cheyenne, WY 82001', '123 Main St', 'Cheyenne', 'WY', '82001'],
      ['12 Main St, Lexington KY 40502', '12 Main St', 'Lexington', 'KY', '40502'],
      ['5 Main St, Helena MT 59601', '5 Main St', 'Helena', 'MT', '59601'],
      ['20 Main St, San Juan PR 00901', '20 Main St', 'San Juan', 'PR', '00901'],
    ])('still trusts "%s" as a real state when a comma marks a real city segment', (address, street, city, state, zip) => {
      expect(parseAddress(address)).toEqual({ street, city, state, zip });
    });
  });
});
