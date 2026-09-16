/**
 * gh-1940 fix3 (CEO ruling, PR #1979 comment 5698022815, condition 1) —
 * proves the `claim_started` double-emission this rebase fixes.
 *
 * BEFORE this fix: rebasing PR #1979 onto main produced a literal merge
 * conflict in `trade-selector/page.tsx`'s claim-creation branch — BOTH
 * main's (#1988/gh-1984) `gtagEventBeforeNavigation('claim_started', ...)`
 * call AND this PR's own, separately-added `track('claim_started', ...)`
 * call lived in the exact same `if (insertedClaim) { ... }` block, so a
 * single new-claim action fired `claim_started` TWICE. The resolution
 * (this file, and the current `trade-selector/page.tsx`) keeps only main's
 * emission.
 *
 * This test cannot render the full multi-step wizard (auth, address
 * parsing, referral resolution, three chained Supabase tables) as a unit
 * test, so it isolates the two REAL, unmodified library calls the two
 * competing code paths made — `gtagEventBeforeNavigation` (still exported
 * from `@/lib/ga-events`, still the surviving call in `page.tsx`) and a
 * direct `gtag(...)` call reproducing exactly what the removed
 * `track('claim_started', ...)` call compiled down to (see `lib/track.ts`'s
 * `track()`: `gtag('event', event, buildSafeParams(event, params))`, and
 * this repo's own history for the pre-fix call site) — and counts real
 * `window.gtag` invocations for the `claim_started` event name for both
 * the pre-fix (2 call sites) and post-fix (1 call site) shape.
 *
 * The source-count assertion at the bottom ties this back to the actual
 * shipped file: it greps the real `trade-selector/page.tsx` for every call
 * site that can emit a `claim_started` GA4 event and asserts there is
 * exactly one, the same structural technique this repo already uses in
 * `scripts/check-gtag-single-source.py` for the single-loader invariant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gtagEventBeforeNavigation } from '../../lib/ga-events';

describe('claim_started — dedupe onto #1988 (CEO ruling condition 1)', () => {
  let gtagSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gtagSpy = vi.fn((_cmd: string, _name: string, opts?: { event_callback?: () => void }) => {
      opts?.event_callback?.();
    });
    (window as unknown as { gtag?: unknown }).gtag = gtagSpy;
  });

  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  function countClaimStartedCalls(spy: ReturnType<typeof vi.fn>): number {
    return spy.mock.calls.filter((call) => call[0] === 'event' && call[1] === 'claim_started').length;
  }

  it('NEGATIVE CONTROL — the pre-rebase shape (main\'s call + PR #1979\'s own call, both present) fires claim_started twice for one new-claim action', async () => {
    // main's (#1988/gh-1984) emission — unchanged, still the real exported function.
    const mainSend = gtagEventBeforeNavigation('claim_started', {
      funding_type: 'cash',
      policy_type: null,
      job_type: 'retail',
      trades: 'roofing',
      source: 'trade_selector',
      test_account: false,
    });
    // PR #1979's own (now-removed) `track('claim_started', ...)` compiled to
    // exactly this: `gtag('event', 'claim_started', buildSafeParams(...))`,
    // fire-and-forget, no event_callback wait (track() never awaits).
    (window as any).gtag('event', 'claim_started', { funding_type: 'cash', policy_type: null });
    await mainSend;

    expect(countClaimStartedCalls(gtagSpy)).toBe(2);
  });

  it('FIX — only main\'s emission survives the rebase, so one new-claim action fires claim_started once', async () => {
    // This is the actual surviving call in trade-selector/page.tsx after
    // conflict resolution — see the source-count assertion below for proof
    // this is the ONLY claim_started call site left in that file.
    await gtagEventBeforeNavigation('claim_started', {
      funding_type: 'cash',
      policy_type: null,
      job_type: 'retail',
      trades: 'roofing',
      source: 'trade_selector',
      test_account: false,
    });

    expect(countClaimStartedCalls(gtagSpy)).toBe(1);
  });

  it('structural — trade-selector/page.tsx contains exactly one call site that can emit claim_started', () => {
    const src = readFileSync(join(__dirname, '../page.tsx'), 'utf8');
    const callSites = src.match(/(?:gtagEventBeforeNavigation|track)\(\s*['"]claim_started['"]/g) ?? [];
    expect(callSites).toHaveLength(1);
    // And it is main's (#1988's) richer-params mechanism, not a bare track().
    expect(src).toContain("gtagEventBeforeNavigation('claim_started'");
  });

  it('structural — trade-selector.html (the static twin surface) also has exactly one claim_started emitter', () => {
    const src = readFileSync(join(__dirname, '../../../../trade-selector.html'), 'utf8');
    const callSites = src.match(/gtag\(\s*['"]event['"]\s*,\s*['"]claim_started['"]/g) ?? [];
    expect(callSites).toHaveLength(1);
  });
});
