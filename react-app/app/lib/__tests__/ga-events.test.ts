/**
 * gh-1984 — gtagEventBeforeNavigation must never strand a redirect:
 * resolves on gtag's event_callback, immediately when gtag is absent, and at
 * the timeout when a stub never calls back (adblock / gtag.js not loaded).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { gtagEventBeforeNavigation } from '../ga-events';

type W = Window & { gtag?: (...args: unknown[]) => void };

afterEach(() => {
  delete (window as W).gtag;
  vi.useRealTimers();
});

describe('gtagEventBeforeNavigation', () => {
  it('sends the event with an event_callback and resolves when gtag calls it', async () => {
    const calls: unknown[][] = [];
    (window as W).gtag = (...args: unknown[]) => {
      calls.push(args);
      const params = args[2] as { event_callback?: () => void };
      params.event_callback?.();
    };
    await gtagEventBeforeNavigation('claim_started', { job_type: 'retail', test_account: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('event');
    expect(calls[0][1]).toBe('claim_started');
    expect(calls[0][2]).toMatchObject({ job_type: 'retail', test_account: true, event_timeout: 1000 });
  });

  it('NEGATIVE CONTROL: gtag absent -> resolves immediately, nothing sent', async () => {
    vi.useFakeTimers();
    let resolved = false;
    gtagEventBeforeNavigation('claim_started', {}).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('stub that never calls back -> resolves at the timeout, not before', async () => {
    vi.useFakeTimers();
    (window as W).gtag = () => { /* dataLayer-only stub */ };
    let resolved = false;
    gtagEventBeforeNavigation('bid_accepted', {}, 1000).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('gtag that throws -> resolves', async () => {
    (window as W).gtag = () => { throw new Error('boom'); };
    await expect(gtagEventBeforeNavigation('claim_started', {})).resolves.toBeUndefined();
  });
});
