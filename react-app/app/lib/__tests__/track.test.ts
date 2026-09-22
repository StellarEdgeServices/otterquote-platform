import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { track, fireSignUpAndWait, fbqTrack } from '../track';

describe('track()', () => {
  let gtagSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gtagSpy = vi.fn();
    (window as unknown as { gtag?: unknown }).gtag = gtagSpy;
  });

  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  it('calls window.gtag with the event name and params', () => {
    track('bid_accepted', {
      bid_id: 'bid-1',
      contractor_id: 'contractor-1',
      bid_amount: 4200,
      source: 'bids_react',
      test_account: false,
    });
    expect(gtagSpy).toHaveBeenCalledTimes(1);
    expect(gtagSpy).toHaveBeenCalledWith('event', 'bid_accepted', {
      bid_id: 'bid-1',
      contractor_id: 'contractor-1',
      bid_amount: 4200,
      source: 'bids_react',
      test_account: false,
    });
  });

  it('never sends transport_type — the D-B1/D-M1 fake fix this PR removes', () => {
    track('contract_signed', {});
    const payload = gtagSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('transport_type');
    expect(Object.keys(payload).sort()).toEqual([]);
  });

  it('fix3 (CEO ruling, PR #1979 comment 5698022815) — bid_accepted and contract_signed never carry claim_id', () => {
    // NEGATIVE CONTROL: this is the exact payload shape fix2 shipped and the
    // LEGAL-READ on this PR (comment 5690670203) flagged — a per-homeowner
    // database identifier reaching a GA4 property linked for remarketing.
    // Casting past the closed TrackEventParams type (the same class of
    // attack the M7/M8 mutants below exercise) proves the whitelist is what
    // rejects it, not merely "the caller stopped passing it".
    track('bid_accepted', {
      bid_id: 'bid-1',
      contractor_id: 'contractor-1',
      bid_amount: 100,
      source: 'bids_react',
      test_account: false,
      claim_id: 'claim-should-never-reach-ga4',
    } as unknown as Parameters<typeof track<'bid_accepted'>>[1]);
    track('contract_signed', { claim_id: 'claim-should-never-reach-ga4' } as unknown as Parameters<
      typeof track<'contract_signed'>
    >[1]);
    const bidAcceptedPayload = gtagSpy.mock.calls[0][2] as Record<string, unknown>;
    const contractSignedPayload = gtagSpy.mock.calls[1][2] as Record<string, unknown>;
    expect(bidAcceptedPayload).not.toHaveProperty('claim_id');
    expect(contractSignedPayload).not.toHaveProperty('claim_id');
    expect(Object.values(bidAcceptedPayload)).not.toContain('claim-should-never-reach-ga4');
    expect(Object.keys(contractSignedPayload)).toEqual([]);
  });

  it('is a no-op (never throws) when window.gtag is absent — GA4Gate not loaded', () => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    expect(() => track('bids_viewed', { bid_count: 3 })).not.toThrow();
  });

  it('never throws even if gtag itself throws', () => {
    (window as unknown as { gtag: unknown }).gtag = () => {
      throw new Error('boom');
    };
    expect(() => track('bids_viewed', { bid_count: 1 })).not.toThrow();
  });
});

/**
 * NEGATIVE CONTROL: the "never sends transport_type" assertion above is not
 * vacuous — re-adding `if (options.beacon) payload.transport_type = 'beacon';`
 * (the PR #1960 shape) and calling track with that option would turn it red.
 * This module's public signature has no `options` parameter at all (the
 * whole point: transport_type was never a real fix — see track.ts's header),
 * so there is nothing to pass to reintroduce it; the type signature itself
 * is the negative control gh-1948's `TrackedField` closed-union comment
 * describes: passing it is not a runtime filter that can silently regress,
 * it is a compile error.
 */

/**
 * gh-1940 fix2 (cto32-review-pr1979-20260915.md, finding B4) — re-run of the
 * review's five planted-PII mutants (M6, M7, M8, M11, M12) against the
 * per-event whitelist + sanitizer rebuild. Every one of these compiled
 * clean and passed the full suite at the reviewed head; all five must be
 * rejected (either dropped from the payload entirely, or replaced with a
 * safe fallback) now. Each test casts past the declared TS type with `as`,
 * exactly the class of attack the review demonstrated (a `const`-hoisted
 * or cast-laundered object bypasses TypeScript's excess-property check) —
 * the whitelist + sanitizer is the runtime choke point that does not
 * depend on how the caller's object was built.
 */
describe('track() — PII rejection (re-run of cto32-review-pr1979 mutants M6/M7/M8/M11/M12)', () => {
  beforeEach(() => {
    (window as unknown as { gtag?: unknown }).gtag = vi.fn();
  });
  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  it('M6 — a file name cast into document_uploaded.tier is rejected, not forwarded', () => {
    track('document_uploaded', { tier: 'invoice_march_2026.pdf' as unknown as 'main' });
    const gtag = window as unknown as { gtag: ReturnType<typeof vi.fn> };
    const payload = gtag.gtag.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.tier).toBe('unknown');
    expect(payload.tier).not.toBe('invoice_march_2026.pdf');
  });

  it('M7 — a street address cast into bid_accepted.bid_id is rejected, not forwarded', () => {
    track('bid_accepted', {
      bid_id: '123 Main St, Springfield, IL 62704',
      contractor_id: 'contractor-1',
      bid_amount: 100,
      source: 'bids_react',
      test_account: false,
    });
    const gtag = window as unknown as { gtag: ReturnType<typeof vi.fn> };
    const payload = gtag.gtag.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.bid_id).toBeNull();
  });

  it('M8 — an extra field-carrying key (claim_id) on bid_accepted is never read, whitelist or not', () => {
    const leaked = {
      bid_id: 'bid-1',
      contractor_id: 'contractor-1',
      bid_amount: 100,
      source: 'bids_react',
      test_account: false,
      claim_id: 'claim-9',
      address: '123 Main St, Springfield',
    } as unknown as { bid_id: string; contractor_id: string; bid_amount: number; source: 'bids_react'; test_account: boolean };
    track('bid_accepted', leaked);
    const gtag = window as unknown as { gtag: ReturnType<typeof vi.fn> };
    const payload = gtag.gtag.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['bid_amount', 'bid_id', 'contractor_id', 'source', 'test_account']);
    expect(payload).not.toHaveProperty('address');
    expect(payload).not.toHaveProperty('claim_id');
  });

  it('M11 — an email address cast into help_tool_used.method is dropped, not forwarded', () => {
    track('help_tool_used', {
      tool: 'help_measurements',
      method: 'adjuster@example.com' as unknown as 'hover_payment',
    });
    const gtag = window as unknown as { gtag: ReturnType<typeof vi.fn> };
    const payload = gtag.gtag.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('method');
    expect(Object.values(payload)).not.toContain('adjuster@example.com');
  });

  it('M12 — an extra email key on the sign_up landing event is never read', () => {
    const leaked = { method: 'google', referral_source: 'web', email: 'user@example.com' } as unknown as {
      method: 'google';
      referral_source: 'web';
    };
    track('sign_up', leaked);
    const gtag = window as unknown as { gtag: ReturnType<typeof vi.fn> };
    const payload = gtag.gtag.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['method', 'referral_source']);
    expect(payload).not.toHaveProperty('email');
  });

  it('negative control — a legitimate closed-set value for each rejected field passes through unchanged', () => {
    track('document_uploaded', { tier: 'tier2' });
    track('help_tool_used', { tool: 'help_measurements', method: 'hover_payment' });
    const gtag = window as unknown as { gtag: ReturnType<typeof vi.fn> };
    expect((gtag.gtag.mock.calls[0][2] as Record<string, unknown>).tier).toBe('tier2');
    expect((gtag.gtag.mock.calls[1][2] as Record<string, unknown>).method).toBe('hover_payment');
  });
});

describe('fireSignUpAndWait()', () => {
  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    vi.useRealTimers();
  });

  it('resolves false immediately when window.gtag is absent — nothing was queued', async () => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    const queued = await fireSignUpAndWait({ method: 'google', referral_source: 'web' }, 1000);
    expect(queued).toBe(false);
  });

  it('resolves true as soon as event_callback fires, without waiting for the full timeout', async () => {
    vi.useFakeTimers();
    let cb: (() => void) | undefined;
    (window as unknown as { gtag: unknown }).gtag = vi.fn((..._args: unknown[]) => {
      const opts = _args[2] as { event_callback?: () => void };
      cb = opts.event_callback;
    });
    const p = fireSignUpAndWait({ method: 'google', referral_source: 'web' }, 1000);
    // event_callback fires quickly (gtag.js already loaded)
    cb?.();
    const queued = await p;
    expect(queued).toBe(true);
  });

  it('resolves true on the ~1000ms timeout when gtag was present and the call did not throw', async () => {
    vi.useFakeTimers();
    (window as unknown as { gtag: unknown }).gtag = vi.fn(); // never invokes event_callback (gtag.js never loads)
    const p = fireSignUpAndWait({ method: 'google', referral_source: 'web' }, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const queued = await p;
    expect(queued).toBe(true);
  });

  it('resolves false if the synchronous gtag(...) call throws — nothing was queued', async () => {
    (window as unknown as { gtag: unknown }).gtag = () => {
      throw new Error('boom');
    };
    const queued = await fireSignUpAndWait({ method: 'google', referral_source: 'web' }, 1000);
    expect(queued).toBe(false);
  });

  it('sends only the whitelisted sign_up keys, sanitized', async () => {
    const gtagSpy = vi.fn((..._args: unknown[]) => {
      const opts = _args[2] as { event_callback?: () => void };
      opts.event_callback?.();
    });
    (window as unknown as { gtag: unknown }).gtag = gtagSpy;
    await fireSignUpAndWait({ method: 'google', referral_source: 'partner_link' }, 1000);
    expect(gtagSpy).toHaveBeenCalledTimes(1);
    const payload = gtagSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.method).toBe('google');
    expect(payload.referral_source).toBe('partner_link');
    expect(typeof payload.event_callback).toBe('function');
  });
});


describe('measurement_purchase (gh-2078)', () => {
  let gtagSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gtagSpy = vi.fn();
    (window as unknown as { gtag?: unknown }).gtag = gtagSpy;
  });

  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  it('sends value/currency/variant exactly as given, when valid', () => {
    track('measurement_purchase', { value: 15.0, currency: 'USD', variant: 'e' });
    expect(gtagSpy).toHaveBeenCalledWith('event', 'measurement_purchase', {
      value: 15.0,
      currency: 'USD',
      variant: 'e',
    });
  });

  it('sanitizes a bad variant shape to "unknown" rather than forwarding it', () => {
    track('measurement_purchase', {
      value: 15.0,
      currency: 'USD',
      variant: 'not a real arm; DROP TABLE',
    });
    const payload = gtagSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.variant).toBe('unknown');
  });

  it('sanitizes a negative/non-finite value to 0 rather than forwarding it', () => {
    track('measurement_purchase', {
      value: -999 as unknown as number,
      currency: 'USD',
      variant: 'd',
    });
    const payload = gtagSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.value).toBe(0);
  });
});

describe('fbqTrack() (gh-2078)', () => {
  afterEach(() => {
    delete (window as unknown as { fbq?: unknown }).fbq;
  });

  it('is a silent no-op when window.fbq is not a function (MetaPixelGate has not loaded here)', () => {
    expect(() => fbqTrack('Purchase', { value: 15, currency: 'USD' })).not.toThrow();
  });

  it('calls window.fbq(\'track\', name, params) when fbq is present', () => {
    const fbqSpy = vi.fn();
    (window as unknown as { fbq: unknown }).fbq = fbqSpy;
    fbqTrack('Purchase', { value: 15, currency: 'USD', variant: 'e' });
    expect(fbqSpy).toHaveBeenCalledWith('track', 'Purchase', { value: 15, currency: 'USD', variant: 'e' });
  });

  it('calls window.fbq(\'track\', name) with no params object when none is given', () => {
    const fbqSpy = vi.fn();
    (window as unknown as { fbq: unknown }).fbq = fbqSpy;
    fbqTrack('CompleteRegistration');
    expect(fbqSpy).toHaveBeenCalledWith('track', 'CompleteRegistration');
  });

  it('never throws even if window.fbq itself throws', () => {
    (window as unknown as { fbq: unknown }).fbq = () => {
      throw new Error('boom');
    };
    expect(() => fbqTrack('Purchase', { value: 15 })).not.toThrow();
  });
});
