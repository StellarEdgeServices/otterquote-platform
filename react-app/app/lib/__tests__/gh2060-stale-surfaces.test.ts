/**
 * gh-2060 — dirty-state coverage for the React-side storage surfaces whose
 * modules are pure enough to drive directly (no component tree needed).
 *
 * Every test here starts CLEAN (this file's own `beforeEach`, same default as
 * the rest of the suite) and then seeds "what a previous visit / visitor /
 * app version left behind" with `seedStaleStorage()` (app/test/storage-
 * fixtures.ts) BEFORE exercising the code under test. That is the one
 * capability the suite lacked (see #2060).
 *
 * Surfaces covered here (see tests/fixtures/gh2060-storage-surface-ledger.json
 * for the full enumeration + which test covers each surface):
 *   - oq_variant_v3        (lib/variant.ts)
 *   - oq_ft                (lib/attribution.ts, first-touch cookie + mirror)
 *   - oq_contractor_gate_bounce (lib/contractor-gate.ts)
 *   - oq_cpa_redirect_guard (contractor/_shell/cpa-guard.ts)
 *   - oq_ga4_signup_fired_v1:<uid> (auth-callback/signup-analytics.ts)
 *   - oq_ga4_measurement_purchase_fired_v1:<pi> and oq_hm_hover_charge_v1
 *     ((homeowner)/help-measurements/hover-charge-storage.ts)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedStaleStorage } from '@/test/storage-fixtures';
import { captureVariantFromUrl, getVariant } from '../variant';
import { captureFirstTouch, readFirstTouch } from '../attribution';
import {
  CONTRACTOR_GATE_BOUNCE_KEY,
  CONTRACTOR_GATE_BOUNCE_TTL_MS,
  consumeContractorGateBounce,
} from '../contractor-gate';
import {
  CPA_REDIRECT_GUARD_KEY,
  CURRENT_CPA_VERSION,
  enforceCpaRedirect,
  isCpaRedirectGuardSet,
} from '@/contractor/_shell/cpa-guard';
import { hasFiredSignUp, signUpFiredKey } from '@/auth-callback/signup-analytics';
import {
  hasFiredMeasurementPurchase,
  readHoverChargeRecord,
  saveHoverChargeRecord,
} from '@/(homeowner)/help-measurements/hover-charge-storage';

function clearAll() {
  localStorage.clear();
  sessionStorage.clear();
  for (const pair of document.cookie.split('; ')) {
    const k = pair.split('=')[0];
    if (k) document.cookie = `${k}=; path=/; max-age=0`;
  }
  window.history.replaceState({}, '', '/');
}

beforeEach(clearAll);
afterEach(clearAll);

describe('oq_variant_v3 — stale persisted arm (lib/variant.ts)', () => {
  it('a fresh ?v= on this load wins over a DIFFERENT arm left by an earlier visit in this browser', () => {
    seedStaleStorage({ localStorage: { oq_variant_v3: 'b' } });
    window.history.replaceState({}, '', '/get-started?v=e');
    captureVariantFromUrl();
    expect(getVariant()).toBe('e');
    expect(localStorage.getItem('oq_variant_v3')).toBe('e');
  });

  it('a stale value from an older app version (wrong shape) is never forwarded — reads as "unknown"', () => {
    seedStaleStorage({ localStorage: { oq_variant_v3: 'Legacy-Arm-Name-From-v2!' } });
    expect(getVariant()).toBe('unknown');
  });

  it('a stale valid arm is still reported when this load carries no ?v= (sticky by design — pinned)', () => {
    seedStaleStorage({ localStorage: { oq_variant_v3: 'd' } });
    captureVariantFromUrl();
    expect(getVariant()).toBe('d');
  });
});

describe('oq_ft — stale first-touch record (lib/attribution.ts)', () => {
  it('a junk value left in localStorage does not block capturing a real tagged touch', () => {
    seedStaleStorage({ localStorage: { oq_ft: '{"not":"a first touch"}' } });
    window.history.replaceState({}, '', '/get-started?utm_source=fb&fbclid=fresh1');
    const ft = captureFirstTouch();
    expect(ft?.utm_source).toBe('fb');
    expect(JSON.parse(localStorage.getItem('oq_ft')!).fbclid).toBe('fresh1');
  });

  it('an unparsable cookie + unparsable localStorage read as "no first touch", never throw', () => {
    seedStaleStorage({ localStorage: { oq_ft: '%%%not json' }, cookies: { oq_ft: 'also-not-json' } });
    expect(readFirstTouch()).toBeNull();
  });

  it('a valid first touch from an earlier visit is kept (first tagged touch wins) — a later tagged landing does not replace it', () => {
    seedStaleStorage({
      localStorage: { oq_ft: JSON.stringify({ v: 1, utm_source: 'youtube', ts: '2026-08-01T00:00:00.000Z' }) },
    });
    window.history.replaceState({}, '', '/get-started?utm_source=fb&fbclid=late');
    expect(captureFirstTouch()?.utm_source).toBe('youtube');
  });
});

describe('oq_contractor_gate_bounce — stale one-shot marker (lib/contractor-gate.ts)', () => {
  it('a marker older than the TTL (left by an abandoned bounce) does not suppress the redirect, and is cleared', () => {
    seedStaleStorage({
      sessionStorage: { [CONTRACTOR_GATE_BOUNCE_KEY]: String(Date.now() - CONTRACTOR_GATE_BOUNCE_TTL_MS - 1000) },
    });
    expect(consumeContractorGateBounce()).toBe(false);
    expect(sessionStorage.getItem(CONTRACTOR_GATE_BOUNCE_KEY)).toBeNull();
  });

  it('a FUTURE-dated marker (negative age) is not "fresh" — it must not suppress the redirect', () => {
    seedStaleStorage({
      sessionStorage: { [CONTRACTOR_GATE_BOUNCE_KEY]: String(Date.now() + 60 * 60 * 1000) },
    });
    expect(consumeContractorGateBounce()).toBe(false);
  });

  it('a fresh marker still suppresses exactly one redirect (positive control)', () => {
    seedStaleStorage({ sessionStorage: { [CONTRACTOR_GATE_BOUNCE_KEY]: String(Date.now() - 1000) } });
    expect(consumeContractorGateBounce()).toBe(true);
    expect(consumeContractorGateBounce()).toBe(false);
  });
});

describe('oq_cpa_redirect_guard — stale anti-loop guard (contractor/_shell/cpa-guard.ts)', () => {
  it('a guard left by an earlier session is cleared once this contractor is current on the CPA', () => {
    seedStaleStorage({ localStorage: { [CPA_REDIRECT_GUARD_KEY]: '1' } });
    const redirect = (() => {
      const calls: string[] = [];
      const fn = (u: string) => calls.push(u);
      return Object.assign(fn, { calls });
    })();
    const redirected = enforceCpaRedirect({ cpa_version: CURRENT_CPA_VERSION, needs_cpa_reattestation: false }, redirect);
    expect(redirected).toBe(false);
    expect(redirect.calls).toEqual([]);
    expect(isCpaRedirectGuardSet()).toBe(false);
  });

  it('a stale contractor with NO guard is bounced to the dashboard exactly once (positive control)', () => {
    const calls: string[] = [];
    expect(enforceCpaRedirect({ cpa_version: 'v0-old' }, (u) => calls.push(u))).toBe(true);
    expect(enforceCpaRedirect({ cpa_version: 'v0-old' }, (u) => calls.push(u))).toBe(false);
    expect(calls).toEqual(['/contractor/dashboard']);
  });
});

describe('oq_ga4_signup_fired_v1:<uid> — stale once-only marker (auth-callback/signup-analytics.ts)', () => {
  it("another user's marker on a shared browser does not suppress this user's sign_up", () => {
    seedStaleStorage({ localStorage: { [signUpFiredKey('user-previous')]: '1' } });
    expect(hasFiredSignUp('user-previous')).toBe(true);
    expect(hasFiredSignUp('user-new')).toBe(false);
  });
});

describe('hover-charge surfaces — stale markers ((homeowner)/help-measurements/hover-charge-storage.ts)', () => {
  it("a PaymentIntent marker from a previous purchase does not mark a NEW PaymentIntent as already fired", () => {
    seedStaleStorage({ localStorage: { 'oq_ga4_measurement_purchase_fired_v1:pi_previous': '1' } });
    expect(hasFiredMeasurementPurchase('pi_previous')).toBe(true);
    expect(hasFiredMeasurementPurchase('pi_new')).toBe(false);
  });

  it('a pending-charge pointer with the wrong shape (older app version) reads as "no record"', () => {
    seedStaleStorage({ sessionStorage: { oq_hm_hover_charge_v1: JSON.stringify({ claimId: 42, pi: 'x' }) } });
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('a well-formed pointer from another claim is returned as-is; callers must compare claimId (pinned)', () => {
    seedStaleStorage({
      sessionStorage: {
        oq_hm_hover_charge_v1: JSON.stringify({ claimId: 'claim-other', paymentIntentId: 'pi_x', ts: 1 }),
      },
    });
    expect(readHoverChargeRecord()).toMatchObject({ claimId: 'claim-other' });
    // …and a later save replaces the single slot rather than queueing behind it.
    saveHoverChargeRecord({ claimId: 'claim-mine', paymentIntentId: 'pi_mine', ts: Date.now() });
    expect(readHoverChargeRecord()).toMatchObject({ claimId: 'claim-mine' });
  });
});
