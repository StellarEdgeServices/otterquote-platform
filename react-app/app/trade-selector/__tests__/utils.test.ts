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
    // downstream D-178 state gate).
    //
    // RULING (b) update: these no longer fall all the way to "state: null".
    // Each ZIP below is a real, resolvable ZIP, so the ZIP3->state table
    // recovers the correct state instead of fabricating the suffix as one
    // — "removes NULLs rather than adds them" per the ruling. The street
    // keeps the full "head + suffix" text (no guessed city boundary); the
    // point of this test is still that the suffix is never mistaken for
    // the state.
    it.each([
      ['123 Oak Ct 12345', '123 Oak Ct', 'NY'], // 123xx is Schenectady, NY — not CT
      ['45 Elm Rd 60614', '45 Elm Rd', 'IL'], // 606xx is Chicago, IL — not a state at all pre-ZIP
      ['9 Bay Ln 30301', '9 Bay Ln', 'GA'], // 303xx is Atlanta, GA
      ['12 Sunset Dr 90210', '12 Sunset Dr', 'CA'], // 902xx is Beverly Hills, CA
      ['500 Main Pl 10001', '500 Main Pl', 'NY'], // 100xx is Manhattan, NY
    ])('resolves "%s" via ZIP instead of fabricating the suffix as state', (address, street, state) => {
      const zip = address.match(/(\d{5})$/)![1];
      expect(parseAddress(address)).toEqual({ street, city: null, state, zip });
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

    // RULING (b) update: these used to bottom out at "state: null" because
    // the suffix collision made the token untrustworthy on a comma-less
    // address. Each is now resolved via the ZIP3->state table instead —
    // note '20 Rolling Pr 78701' resolves to TX (Austin), NOT Puerto Rico:
    // the ZIP proves the suffix collision was right to distrust the token,
    // without fabricating PR just because "Pr" looked like Prairie.
    it.each([
      // Wy = Way, collides with Wyoming. The exact inputs from the FAIL
      // review that caught the round-2 gap. 90210 is Beverly Hills, CA —
      // proving this really was a street word, not Wyoming.
      ['100 Sunset Wy 90210', 'CA'],
      // 82001 really is Cheyenne, WY — one of the five disclosed-regression
      // addresses named in the CTO's ruling.
      ['400 Fair Wy 82001', 'WY'],
      // Ky = Key, collides with Kentucky. 40202 really is Louisville, KY.
      ['12 Compass Ky 40202', 'KY'],
      // Mt = Mount, collides with Montana. 59601 really is Helena, MT.
      ['5 Fair Mt 59601', 'MT'],
      // Pr = Prairie, collides with Puerto Rico. 78701 is Austin, TX.
      ['20 Rolling Pr 78701', 'TX'],
    ])('resolves comma-less "%s" via ZIP instead of fabricating a state', (address, state) => {
      const [, street, zip] = address.match(/^(.*)\s(\d{5})$/)!;
      expect(parseAddress(address)).toEqual({ street, city: null, state, zip });
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

  describe('gh-1579 RULING (b): validate the parsed state against the ZIP', () => {
    // The word-collision class the whitelist alone can't catch: "In" is a
    // real state code (Indiana) but not a USPS street-suffix abbreviation,
    // so it was already "trustworthy" under the old whitelist logic even
    // on a comma-less address — a fabrication the ruling calls out by name.
    // 46201 really is Indianapolis, IN, so the ZIP confirms it rather than
    // exposing it as wrong; this locks in that the word-collision case is
    // now ZIP-verified, not merely lucky.
    it('confirms the word-collision case via ZIP: "123 Foo In 46201" -> IN', () => {
      expect(parseAddress('123 Foo In 46201')).toEqual({
        street: '123',
        city: 'Foo',
        state: 'IN',
        zip: '46201',
      });
    });

    // Token/ZIP disagreement on an otherwise-trustworthy token (valid,
    // non-ambiguous, comma-separated city) — the ZIP wins outright, not
    // just on the ambiguous-suffix set. 62701 really is Springfield, IL,
    // not TX, so "IL" overrides the typed "TX".
    it('a resolvable disagreement overrides an otherwise-trustworthy token', () => {
      expect(parseAddress('123 Main St, Springfield TX 62701')).toEqual({
        street: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
      });
    });

    // ZIP unresolvable (096xx falls in the Armed-Forces-Europe military
    // block, not a real state) + a trustworthy token -> keep the token,
    // exactly as before ZIP validation existed. Never guess a replacement.
    it('keeps an unambiguous token when the ZIP cannot be resolved', () => {
      expect(parseAddress('5 Main St, Metropolis TX 09612')).toEqual({
        street: '5 Main St',
        city: 'Metropolis',
        state: 'TX',
        zip: '09612',
      });
    });

    // ZIP unresolvable (969xx is shared by Guam and the Northern Mariana
    // Islands — genuinely ambiguous at 3-digit resolution) + an
    // untrustworthy token ("Rd" is not a state code at all) -> NULL, never
    // a guess. Falls all the way back to the legacy comma-split fallback,
    // same shape as any other unresolvable case.
    it('returns null when neither the token nor the ZIP resolves', () => {
      expect(parseAddress('10 Beach Rd 96910')).toEqual({
        street: '10 Beach Rd 96910',
        city: null,
        state: null,
        zip: null,
      });
    });

    // The five real addresses named in the CTO's ruling as the disclosed
    // regression this change repairs: comma-less CT/KY/MT/PR/WY addresses
    // that the round-3 whitelist fix made return "state: null". Each now
    // resolves via its ZIP instead.
    describe('repairs the disclosed comma-less CT/KY/MT/PR/WY regression', () => {
      it.each([
        ['10 Main St Hartford CT 06103', 'Hartford, CT', 'CT'],
        ['88 Key St Louisville KY 40202', 'Louisville, KY', 'KY'],
        ['200 Bridger Dr Bozeman MT 59715', 'Bozeman, MT', 'MT'],
        ['5 Calle Sol San Juan PR 00901', 'San Juan, PR', 'PR'],
        ['300 Capitol Ave Cheyenne WY 82001', 'Cheyenne, WY', 'WY'],
      ])('%s (%s) resolves to %s via ZIP, not null', (address, _label, state) => {
        const [, street, zip] = address.match(/^(.*)\s(\d{5})$/)!;
        expect(parseAddress(address)).toEqual({ street, city: null, state, zip });
      });
    });
  });
});
