/**
 * gh-2046 — unit tests for the Sentry lead-id scrub, and a regression
 * fixture reproducing the exact leak the refuter found: production's
 * pageload transaction envelope carried a `lead=<uuid>` inside 8
 * browser.* span descriptions (domContentLoadedEvent, loadEvent, connect,
 * TLS/SSL, cache, DNS, request, response), because those spans copy their
 * `description`/`data.url` from the Navigation Timing entry, which is
 * unaffected by the early-strip head script's `history.replaceState`.
 *
 * The regression test below is written against `redactLeadDeep` directly.
 * As a negative control (see report cto38-b2046-20260925.md), it was also
 * run with the call in `buildLeakedTransaction`'s consumer swapped for an
 * identity function (`(e) => e`, i.e. "scrub disabled") and confirmed to
 * FAIL — the assertions below are not vacuously true.
 */

import { describe, it, expect } from 'vitest';
import { redactLeadParam, redactLeadDeep, LEAD_REDACTED_TOKEN } from '../sentry-scrub';

const LEAD_ID = '8f14e45f-ceea-467e-b5a4-2e2c8d1b3f0a';
const PAGE_URL = `https://app.otterquote.com/get-started?lead=${LEAD_ID}&utm_source=facebook`;

describe('redactLeadParam (string-level)', () => {
  it('redacts a lead= value out of a full URL', () => {
    const out = redactLeadParam(PAGE_URL);
    expect(out).not.toContain(LEAD_ID);
    expect(out).toBe(`https://app.otterquote.com/get-started?lead=${LEAD_REDACTED_TOKEN}&utm_source=facebook`);
  });

  it('redacts lead= appearing mid-string, e.g. inside a span description', () => {
    const desc = `GET /get-started?lead=${LEAD_ID}`;
    expect(redactLeadParam(desc)).toBe(`GET /get-started?lead=${LEAD_REDACTED_TOKEN}`);
  });

  it('leaves strings with no lead= param untouched (same reference)', () => {
    const clean = 'https://app.otterquote.com/get-started?utm_source=facebook';
    expect(redactLeadParam(clean)).toBe(clean);
  });

  it('does not touch a key that merely contains "lead", e.g. leadSource=', () => {
    const s = 'https://app.otterquote.com/x?leadSource=facebook';
    expect(redactLeadParam(s)).toBe(s);
  });

  it('redacts every occurrence when lead= appears more than once', () => {
    const s = `a?lead=${LEAD_ID}#lead=${LEAD_ID}`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
    expect(out.split(LEAD_REDACTED_TOKEN).length - 1).toBe(2);
  });
});

describe('redactLeadParam — S3: case-insensitive fast path', () => {
  it('redacts ?Lead= (mixed case)', () => {
    const s = `https://app.otterquote.com/get-started?Lead=${LEAD_ID}&utm_source=facebook`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
    expect(out).toBe(`https://app.otterquote.com/get-started?Lead=${LEAD_REDACTED_TOKEN}&utm_source=facebook`);
  });

  it('redacts ?LEAD= (upper case)', () => {
    const s = `https://app.otterquote.com/get-started?LEAD=${LEAD_ID}`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
    expect(out).toBe(`https://app.otterquote.com/get-started?LEAD=${LEAD_REDACTED_TOKEN}`);
  });

  it('redacts &Lead= mid-string', () => {
    const s = `https://app.otterquote.com/x?utm_source=facebook&Lead=${LEAD_ID}`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
    expect(out).toContain(LEAD_REDACTED_TOKEN);
  });
});

describe('redactLeadParam — S4: URL-encoded boundary forms', () => {
  it('redacts %3Flead%3D (encoded "?lead=")', () => {
    const s = `https://app.otterquote.com/redirect?target=%2Fget-started%3Flead%3D${LEAD_ID}`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
    expect(out).toBe(`https://app.otterquote.com/redirect?target=%2Fget-started%3Flead%3D${LEAD_REDACTED_TOKEN}`);
  });

  it('redacts %26lead%3D (encoded "&lead=")', () => {
    const s = `https://app.otterquote.com/redirect?target=%2Fget-started%3Futm_source%3Dfb%26lead%3D${LEAD_ID}`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
    expect(out).toContain(LEAD_REDACTED_TOKEN);
  });

  it('redacts the encoded form case-insensitively (%3FLEAD%3D)', () => {
    const s = `x?target=%2Fget-started%3FLEAD%3D${LEAD_ID}`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
  });

  it('stops the encoded value at the next %26 separator, not consuming past it', () => {
    const s = `x?target=%2Fget-started%3Flead%3D${LEAD_ID}%26utm_source%3Dfb`;
    const out = redactLeadParam(s);
    expect(out).not.toContain(LEAD_ID);
    expect(out).toContain('%26utm_source%3Dfb');
  });

  it('leaves a plain string with no encoded lead param untouched (same reference)', () => {
    const clean = 'https://app.otterquote.com/redirect?target=%2Fget-started%3Futm_source%3Dfb';
    expect(redactLeadParam(clean)).toBe(clean);
  });
});

/**
 * Reproduces the shape of the real leaking envelope: a pageload
 * transaction event whose 8 browser.* spans each carry the lead id in
 * `description` and/or `data.url` / `data["http.url"]`, taken verbatim
 * from the Navigation Timing record.
 */
function buildLeakedTransaction() {
  const spanNames = [
    'browser.domContentLoadedEvent',
    'browser.loadEvent',
    'browser.connect',
    'browser.SSL',
    'browser.cache',
    'browser.DNS',
    'browser.request',
    'browser.response',
  ];
  return {
    type: 'transaction',
    transaction: '/get-started',
    request: { url: PAGE_URL },
    tags: { 'lead.origin': `redirect?lead=${LEAD_ID}` },
    spans: spanNames.map((op, i) => ({
      op,
      description: `${op} for ${PAGE_URL}`,
      data: {
        url: PAGE_URL,
        'http.url': PAGE_URL,
        seq: i,
      },
    })),
  };
}

describe('redactLeadDeep (event/transaction-level)', () => {
  it('regression: strips the lead id out of all 8 browser.* spans, request.url, and tags', () => {
    const raw = buildLeakedTransaction();

    // Sanity: the fixture really does leak, matching the refuter's count.
    const rawSerialized = JSON.stringify(raw);
    const rawOccurrences = rawSerialized.split(LEAD_ID).length - 1;
    expect(rawOccurrences).toBeGreaterThanOrEqual(8 + 2); // 8 spans (description+data.url+http.url each) + request.url + tags

    const scrubbed = redactLeadDeep(raw);
    const scrubbedSerialized = JSON.stringify(scrubbed);

    expect(scrubbedSerialized).not.toContain(LEAD_ID);
    expect(scrubbed.spans).toHaveLength(8);
    for (const span of scrubbed.spans) {
      expect(span.description).not.toContain(LEAD_ID);
      expect(span.data.url).not.toContain(LEAD_ID);
      expect(span.data['http.url']).not.toContain(LEAD_ID);
      expect(span.description).toContain(LEAD_REDACTED_TOKEN);
    }
    expect(scrubbed.request.url).not.toContain(LEAD_ID);
    expect(scrubbed.tags['lead.origin']).not.toContain(LEAD_ID);

    // Non-PII fields are untouched.
    expect(scrubbed.transaction).toBe('/get-started');
    expect(scrubbed.spans[3].op).toBe('browser.SSL');
    expect(scrubbed.spans[0].data.seq).toBe(0);
  });

  it('does not mutate the input object', () => {
    const raw = buildLeakedTransaction();
    const before = JSON.stringify(raw);
    redactLeadDeep(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('handles null/undefined/primitive event fields without throwing', () => {
    expect(redactLeadDeep(null)).toBeNull();
    expect(redactLeadDeep(undefined)).toBeUndefined();
    expect(redactLeadDeep(42)).toBe(42);
    expect(redactLeadDeep({ a: null, b: undefined, c: 1, d: true })).toEqual({
      a: null,
      b: undefined,
      c: 1,
      d: true,
    });
  });

  it('returns the same array/object reference when nothing changed (cheap no-op path)', () => {
    const clean = { transaction: '/get-started', spans: [{ op: 'browser.loadEvent', description: 'clean' }] };
    const out = redactLeadDeep(clean);
    expect(out).toBe(clean);
  });
});
