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
});
