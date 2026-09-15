import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { track } from '../track';

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
    track('bid_accepted', { claim_id: 'claim-1' });
    expect(gtagSpy).toHaveBeenCalledTimes(1);
    expect(gtagSpy).toHaveBeenCalledWith('event', 'bid_accepted', { claim_id: 'claim-1' });
  });

  it('never sends transport_type — the D-B1/D-M1 fake fix this PR removes', () => {
    track('contract_signed', { claim_id: 'claim-2' });
    const payload = gtagSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('transport_type');
    expect(Object.keys(payload).sort()).toEqual(['claim_id']);
  });

  it('is a no-op (never throws) when window.gtag is absent — GA4Gate not loaded', () => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    expect(() => track('bids_viewed', { bid_count: 3 })).not.toThrow();
  });

  it('never throws even if gtag itself throws', () => {
    (window as unknown as { gtag: unknown }).gtag = () => {
      throw new Error('boom');
    };
    expect(() => track('claim_started', { funding_type: 'cash', policy_type: null })).not.toThrow();
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
