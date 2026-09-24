'use client';

/**
 * Shared GA4 emit call site — gh-1940, rebuilt on gh-1948 / gh-1960.
 *
 * get-started/page.tsx keeps its OWN local, more tightly-typed track() (added
 * in gh-1948) for the signup form's own events (form_start,
 * form_step_complete, form_abandon, homeowner_signup, and the PASSWORD path's
 * sign_up) — that one is NOT duplicated here. This file exists for the funnel
 * steps AFTER signup, which had no shared call site before this PR, plus the
 * OAuth-callback sign_up guard in app/auth-callback/page.tsx (the GOOGLE
 * path's sign_up — see app/auth-callback/signup-analytics.ts).
 *
 * `claim_started` is deliberately NOT one of the events this file emits
 * (fix3, dedupe onto main): #1988/gh-1984 shipped `claim_started` on
 * `react-app/app/trade-selector/page.tsx` (via `@/lib/ga-events`'s
 * `gtagEventBeforeNavigation`, with `source`/`test_account`/`job_type`/
 * `trades` params and an awaited beacon-safe send) before this PR reached
 * main. This PR originally added a second, competing `track('claim_started',
 * ...)` call in the SAME branch of the SAME function — a literal same-code-
 * path double emission once merged. Rebasing onto main surfaced that exact
 * conflict; the resolution keeps main's (#1988's) emission and drops this
 * file's. See `trade-selector/__tests__/claim-started-dedupe.test.ts` for
 * the 1-not-2 count.
 *
 * `transport_type: 'beacon'` was REMOVED from this design (present in
 * PR #1960, which this PR supersedes) per the independent review at
 * cto31-pr1960-review-20260915.md (REVIEW: FAIL, findings D-B1/D-M1):
 * passing `transport_type` as a gtag EVENT PARAMETER does not change
 * delivery transport. gtag.js already ships every hit via
 * `navigator.sendBeacon` / `fetch(keepalive:true)` regardless of this
 * option — the value is instead forwarded to GA4 as a junk custom event
 * parameter (`ep.transport_type`), consuming one of the 25-per-event
 * parameter slots for nothing. Deleting it costs nothing; delivery was
 * already correct without it.
 *
 * fix2 (cto32-review-pr1979-20260915.md, REVIEW: FAIL, finding B4): this
 * file used to forward `{ ...params }` essentially unchanged, trusting
 * TypeScript's excess-property check and a handful of bare `string`-typed
 * fields (`funding_type`, `policy_type`, `tier`, `method`, `claim_id` x2) to
 * keep a field VALUE from ever reaching GA4. The refuter planted a file
 * name into `document_uploaded.tier`, a street address into
 * `bid_accepted.claim_id`, an email into `help_tool_used.method`, and an
 * extra `email` key onto two events — every one compiled clean and passed
 * the full test suite (mutants M6/M7/M8/M11/M12). That is the same class
 * of gap get-started/page.tsx's own `track()` was rebuilt to close (see
 * that file's `TrackEventParams` comment for the full excess-property-check
 * writeup) — this file now uses the identical mechanism: a per-event KEY
 * whitelist (`TRACK_EVENT_KEYS`) plus a per-event, per-key SANITIZER
 * (`FIELD_SANITIZERS`), so what reaches `gtag()` is built by this function
 * from a fixed vocabulary, never forwarded from the caller's object as-is.
 *
 * fix3 (CEO ruling, PR #1979 comment 5698022815, claim ceo-2026-09-16T13:09:26Z,
 * conditions 1-2) — two changes made rebasing this PR onto main (which by
 * then carried #1988's independent GA4 work):
 *   1. `claim_id` — a per-homeowner database identifier — is removed from
 *      every payload below (`bid_accepted`, `contract_signed`). The LEGAL-READ
 *      on this PR (comment 5690670203) flagged it as the one privacy-shaped
 *      element sending a DB id into a GA4 property linked for remarketing;
 *      the ruling's cure is to drop it, not gate it — the event NAME is the
 *      funnel step, no id travels with it. `bid_accepted` gains
 *      `bid_id`/`contractor_id`/`bid_amount`/`source`/`test_account` in its
 *      place (see next point); `contract_signed` carries no params at all.
 *   2. `bid_accepted` on this page (`(homeowner)/bids`, not linked from the
 *      live dashboard — see actions.ts's own header) is a second surface for
 *      the same conceptual funnel step #1988 already instruments on the
 *      LIVE surface, `bids.html` (`source: 'bids_page'`). Per the ruling,
 *      param NAMES now match #1988's shape (`bid_id`, `contractor_id`,
 *      `bid_amount`, `source`, `test_account`) rather than PR #1979's own
 *      `{ claim_id }` shape, so the two surfaces are analytics-equivalent —
 *      this page's `source` is `'bids_react'`, distinct from
 *      `bids.html`'s `'bids_page'`, so the two remain distinguishable in GA4
 *      while carrying the same field vocabulary. See
 *      `bids/__tests__/bids-actions-dedupe.test.ts` for the 1-not-2 count.
 *
 * Safe by construction, matching get-started's local track():
 *   - Never throws — every failure mode (gtag absent, window absent, a
 *     malformed param) is swallowed. Analytics must never break a user
 *     action.
 *   - Never blocks — synchronous, fire-and-forget. The ONE exception is
 *     `fireSignUpAndWait` below, used ONLY by the OAuth-landing sign_up
 *     call site, which intentionally waits up to a bounded timeout before
 *     resolving — see its own header for why that call site (and only that
 *     one) needs it.
 *   - Never queues — if `window.gtag` is not present right now, the event
 *     is dropped, not buffered (GA4Gate is fail-closed by design).
 *   - Never loads gtag itself — app/components/GA4Gate.tsx remains the
 *     only place the GA4 library is requested.
 *   - No PII — every param below is read through a closed vocabulary, a
 *     bounded id-shape check, or a bounded count. Nothing here forwards a
 *     caller-supplied object's keys unfiltered.
 */

import { isAdSharingOptedOut } from './ad-optout';

type PhotoTier = 'main' | 'tier1' | 'tier2' | 'tier3' | 'tier4';
type HelpTool = 'help_estimate' | 'help_materials' | 'help_measurements';
type HelpMethod = 'hover_payment' | 'email_request';
/**
 * Mirrors get-started/page.tsx's own `ReferralSource` closed set, plus
 * `partner_link` — the one additional value `persistSignupContext` there
 * writes into `cs_signup.referral_source` when a stored referral-agent id
 * is present but no explicit chip was picked. Kept as its own type here
 * (not imported from a client page component) since this is the shared
 * lib boundary; the vocabulary is the load-bearing thing to keep in sync,
 * not the TS symbol.
 */
export type ReferralSource = 'insurance_agent' | 'realtor' | 'friend' | 'web' | 'partner_link' | '';

type TrackEventParams = {
  /** repair-intake — once per confirmed photo upload. `tier` is a category label, not file content or a file name. */
  document_uploaded: { tier: PhotoTier };
  /** help-estimate / help-materials / help-measurements — fires only on confirmed success. */
  help_tool_used: { tool: HelpTool; method?: HelpMethod };
  /** bids page — first render with >=1 bid loaded. */
  bids_viewed: { bid_count: number };
  /**
   * bids/actions.ts — after every award write succeeds. No claim_id (fix3,
   * CEO ruling on PR #1979): a per-homeowner database identifier must not
   * reach a GA4 property linked for remarketing. Shape matches #1988's
   * `bids.html` bid_accepted so the two surfaces (this unlinked React page
   * and the live static page) are analytics-equivalent, distinguished only
   * by `source`.
   */
  bid_accepted: { bid_id: string; contractor_id: string; bid_amount: number; source: 'bids_react'; test_account: boolean };
  /**
   * contract-signing — after the sign-complete write settles (and only if
   * it succeeded — see that page). No params at all (fix3): the event NAME
   * is the funnel step; the claim_id this used to carry is removed per the
   * CEO ruling on PR #1979, same reasoning as bid_accepted above.
   */
  contract_signed: Record<string, never>;
  /**
   * auth-callback landing — gh-1940 sign_up reliability fix. Fired ONLY for
   * a newly-created user, ONLY once, at the point session + role are known
   * (not pre-redirect). method is deliberately narrowed to 'google': the
   * password path's sign_up already lives in get-started/page.tsx and is
   * unchanged by this PR. `referral_source` is carried through from the
   * `cs_signup` payload get-started/page.tsx wrote before the redirect (see
   * signup-analytics.ts's `readReferralSourceFromCsSignup`), so the landing
   * event does not lose the dimension the pre-redirect emit used to carry.
   */
  sign_up: { method: 'google'; referral_source: ReferralSource };
  /**
   * gh-2078 -- fires once, from the measurement ($15 Hover) checkout
   * success path (help-measurements/page.tsx's handlePaid), immediately
   * after placeHoverOrder resolves (a real, confirmed Stripe charge --
   * see HoverPaymentForm.tsx's own gh-416 double-charge guard, which this
   * reuses rather than re-deriving). `value`/`currency` are fixed
   * (the $15 RoofScope price), `variant` is the persisted router arm
   * (lib/variant.ts), `'unknown'` when none was ever captured.
   */
  measurement_purchase: { value: number; currency: 'USD'; variant: string };
};

/**
 * Per-event whitelist of the ONLY keys `track()`/`fireSignUpAndWait()` will
 * ever read off the caller's params object. Matches get-started/page.tsx's
 * `TRACK_EVENT_KEYS` pattern — built from the same keys as
 * `TrackEventParams` above, so this table and the type cannot silently
 * drift the way "forward the object as-is" could.
 */
const TRACK_EVENT_KEYS: { [E in keyof TrackEventParams]: ReadonlyArray<keyof TrackEventParams[E] & string> } = {
  document_uploaded: ['tier'],
  help_tool_used: ['tool', 'method'],
  bids_viewed: ['bid_count'],
  bid_accepted: ['bid_id', 'contractor_id', 'bid_amount', 'source', 'test_account'],
  contract_signed: [],
  sign_up: ['method', 'referral_source'],
  measurement_purchase: ['value', 'currency', 'variant'],
};

/**
 * Per-event, per-key sanitizers — keyed by EVENT first (not just field
 * name), because two different events legitimately use the same field name
 * (`help_tool_used.method` and `sign_up.method`) for two different closed
 * vocabularies. A flat `Record<string, sanitizer>` (get-started's shape)
 * would silently let one event's sanitizer leak onto the other's
 * same-named field the moment a second event needed it — this table
 * structurally cannot do that.
 *
 * Each sanitizer takes `unknown` (never trusts the declared TS type — a
 * caller can always reach a bad value past the type system with an `as`
 * cast, exactly the attack get-started/page.tsx's own comment documents)
 * and returns either a value from a closed set, a bounded id-shape string,
 * a bounded count, or (for the two truly optional fields) `undefined` —
 * `undefined` means "drop this key from the outgoing payload entirely",
 * used only for `help_tool_used.method`.
 */
const PHOTO_TIERS: ReadonlySet<string> = new Set(['main', 'tier1', 'tier2', 'tier3', 'tier4']);
function sanitizeTier(value: unknown): PhotoTier | 'unknown' {
  return typeof value === 'string' && PHOTO_TIERS.has(value) ? (value as PhotoTier) : 'unknown';
}

const HELP_TOOLS: ReadonlySet<string> = new Set(['help_estimate', 'help_materials', 'help_measurements']);
function sanitizeHelpTool(value: unknown): HelpTool | 'unknown' {
  return typeof value === 'string' && HELP_TOOLS.has(value) ? (value as HelpTool) : 'unknown';
}

const HELP_METHODS: ReadonlySet<string> = new Set(['hover_payment', 'email_request']);
function sanitizeHelpMethod(value: unknown): HelpMethod | undefined {
  return typeof value === 'string' && HELP_METHODS.has(value) ? (value as HelpMethod) : undefined;
}

function sanitizeBidCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Bounded id-SHAPE check (mirrors get-started/page.tsx's
 * `sanitizeMarketingParam` bound-not-vocabulary approach for its own two
 * open channels): claim ids are Supabase UUIDs in production, but a few
 * existing tests use short literal ids like `'claim-1'`, so this does not
 * hardcode UUID format — it bounds the SHAPE instead. Alphanumeric plus
 * `-`/`_` only, 1–64 chars: rejects a street address (spaces/commas), an
 * email (`@`/`.`), and anything else carrying a field VALUE this key was
 * never meant to carry.
 */
const ID_LIKE_RE = /^[A-Za-z0-9_-]{1,64}$/;
function sanitizeIdLike(value: unknown): string | null {
  return typeof value === 'string' && ID_LIKE_RE.test(value) ? value : null;
}

/** fix3 — bid_accepted.bid_amount: a bounded non-negative number, never a string. */
function sanitizeBidAmount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** fix3 — bid_accepted.source: closed set, this file's one call site only. */
const BID_ACCEPTED_SOURCES: ReadonlySet<string> = new Set(['bids_react']);
function sanitizeBidAcceptedSource(value: unknown): 'bids_react' | 'unknown' {
  return typeof value === 'string' && BID_ACCEPTED_SOURCES.has(value) ? (value as 'bids_react') : 'unknown';
}

function sanitizeBoolean(value: unknown): boolean {
  return value === true;
}

const SIGN_UP_METHODS: ReadonlySet<string> = new Set(['google']);
function sanitizeSignUpMethod(value: unknown): 'google' | 'unknown' {
  return typeof value === 'string' && SIGN_UP_METHODS.has(value) ? (value as 'google') : 'unknown';
}

/** fix -- measurement_purchase.value: fixed $15 price, but never trust the caller's number as-is. */
function sanitizeMeasurementValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

const USD_ONLY: ReadonlySet<string> = new Set(['USD']);
function sanitizeCurrency(value: unknown): 'USD' {
  return typeof value === 'string' && USD_ONLY.has(value) ? 'USD' : 'USD';
}

/** Bounded shape check, same posture as sanitizeIdLike above -- no fixed arm vocabulary here (see lib/variant.ts). */
const VARIANT_SHAPE_RE = /^[a-z0-9]{1,8}$/;
function sanitizeVariantParam(value: unknown): string {
  return typeof value === 'string' && VARIANT_SHAPE_RE.test(value) ? value : 'unknown';
}

const REFERRAL_SOURCES: ReadonlySet<string> = new Set(['insurance_agent', 'realtor', 'friend', 'web', 'partner_link', '']);
function sanitizeReferralSource(value: unknown): ReferralSource {
  return typeof value === 'string' && REFERRAL_SOURCES.has(value) ? (value as ReferralSource) : '';
}

const FIELD_SANITIZERS: { [E in keyof TrackEventParams]: { [K in keyof TrackEventParams[E]]-?: (value: unknown) => unknown } } = {
  document_uploaded: { tier: sanitizeTier },
  help_tool_used: { tool: sanitizeHelpTool, method: sanitizeHelpMethod },
  bids_viewed: { bid_count: sanitizeBidCount },
  bid_accepted: {
    bid_id: sanitizeIdLike,
    contractor_id: sanitizeIdLike,
    bid_amount: sanitizeBidAmount,
    source: sanitizeBidAcceptedSource,
    test_account: sanitizeBoolean,
  },
  contract_signed: {},
  sign_up: { method: sanitizeSignUpMethod, referral_source: sanitizeReferralSource },
  measurement_purchase: { value: sanitizeMeasurementValue, currency: sanitizeCurrency, variant: sanitizeVariantParam },
};

/**
 * Builds the object actually sent to `gtag()`: for `event`, reads ONLY the
 * keys `TRACK_EVENT_KEYS[event]` lists, each through that event's own
 * sanitizer. Any other property on the caller's object — however it was
 * built — is never looked at. A sanitizer returning `undefined` drops that
 * key from the result (used for the one truly-optional field,
 * `help_tool_used.method`); every other sanitizer always returns a value
 * (falling back to `'unknown'`, `null`, `0`, or `''` as documented above),
 * so those keys are always present.
 */
function buildSafeParams<E extends keyof TrackEventParams>(
  event: E,
  params: TrackEventParams[E],
): Record<string, unknown> {
  const allowedKeys = TRACK_EVENT_KEYS[event];
  const sanitizers = FIELD_SANITIZERS[event] as Record<string, (value: unknown) => unknown>;
  const raw = params as unknown as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const sanitized = sanitizers[key](raw[key]);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return safe;
}

function getGtag(): ((...args: unknown[]) => void) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { gtag?: (...args: unknown[]) => void };
  return typeof w.gtag === 'function' ? w.gtag : undefined;
}

export function track<E extends keyof TrackEventParams>(event: E, params: TrackEventParams[E]): void {
  try {
    const gtag = getGtag();
    if (!gtag) return; // GA4Gate has not loaded (blocked host, ad blocker, SSR) — no-op, no queue.
    gtag('event', event, buildSafeParams(event, params));
  } catch {
    // Never throw — an analytics failure must never break a user-facing action.
  }
}

/**
 * gh-2078 -- guarded Meta Pixel emit, mirroring get-started/page.tsx's own
 * local `fbq()` helper (that one is not exported / not shared, per this
 * file's header -- get-started keeps its own call sites). Every call site
 * outside get-started that needs fbq (this file's `measurement_purchase`
 * callers, `partner_signup_complete`'s pages are static HTML and use their
 * own `try { fbq(...) } catch {}` idiom instead) goes through here so
 * there is exactly one `typeof window.fbq === 'function'` guard to keep in
 * sync with MetaPixelGate.tsx's own contract. Never throws, never queues:
 * if MetaPixelGate has not loaded fbq on this host+path (e.g. an
 * authenticated route outside its ALLOWED_PATHS -- see that file), this is
 * a silent no-op, exactly like `track()` above when GA4Gate has not
 * loaded gtag.
 *
 * gh-2078c: an optional third argument, `eventId`, is forwarded to fbq as
 * its 4th call argument (`fbq('track', name, params, {eventID: eventId})`)
 * -- Meta's own client-side dedup mechanism. Omitted entirely (not just
 * `undefined`) when `eventId` is not passed, so every pre-existing call
 * site and test that does not pass one is byte-identical to before this
 * change. See `buildMeasurementPurchaseEventId` below for the one id this
 * file currently computes.
 */
export function fbqTrack(eventName: string, params?: Record<string, unknown>, eventId?: string): void {
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { fbq?: (...args: unknown[]) => void };
    if (typeof w.fbq !== 'function') return;
    // gh-2107 (REVIEW N1 on #2134): re-check the advertising-sharing opt-out on EVERY event. The pixel's `allowed` state can outlive a
    // client-side navigation, and a stored opt-out may only be read after fbevents.js is already loaded (GPC or the cookie it leaves).
    if (isAdSharingOptedOut()) return;
    if (eventId) w.fbq('track', eventName, params ?? {}, { eventID: eventId });
    else if (params) w.fbq('track', eventName, params);
    else w.fbq('track', eventName);
  } catch {
    // Never throw — an analytics failure must never break a user-facing action.
  }
}

/**
 * gh-2078c / D-330 reconciliation (Q: on #2078, comment 5780969290):
 * deterministic Meta dedup id for a measurement-order `Purchase` event.
 *
 * MUST match `supabase/functions/stripe-webhook/meta-capi.ts`'s
 * `buildCapiEventId` EXACTLY -- same `measurement_purchase:<paymentIntentId>`
 * format, same `paymentIntentId` string already in scope at both of
 * help-measurements/page.tsx's `fbqTrack('Purchase', ...)` call sites (the
 * PR #2107 server-side CAPI event computes the identical string from the
 * SAME PaymentIntent id, independently, with no coordination needed at
 * request time). Meta dedupes a client pixel event against a server CAPI
 * event ONLY when both carry the identical `event_name` + `event_id`; a
 * value that "almost" matches (different prefix, different casing, a
 * hash instead of the raw id) does not dedupe at all -- see
 * `__tests__/track.test.ts`'s pinned-equivalence test.
 */
export function buildMeasurementPurchaseEventId(paymentIntentId: string): string {
  return `measurement_purchase:${paymentIntentId}`;
}

/**
 * gh-1940 fix2 (cto32-review-pr1979-20260915.md, findings B1/B2) — the
 * ONLY call in this app that waits on gtag before continuing. Used
 * exclusively by auth-callback/signup-analytics.ts's `maybeFireGoogleSignUp`,
 * which gates a `window.location.href` full-page navigation: navigating away
 * before gtag.js has processed the queued hit can lose it entirely (no
 * `sendBeacon` has been issued yet), the same failure mode B1/B2 found on
 * both sides of this fix (the old pre-redirect emit AND a naive fire-and-
 * continue landing emit).
 *
 * Sends the event with gtag's own `event_callback`, and races it against a
 * local `timeoutMs` timer (default ~1000ms) — whichever settles first wins,
 * so a slow or never-loading gtag.js adds at most `timeoutMs` of delay
 * before the caller is told to proceed, never more.
 *
 * Resolves:
 *   - `false` immediately if `window.gtag` is not present at all (GA4Gate
 *     has not mounted, or threw before it could) — nothing was queued, so
 *     the caller must not treat this as "handled" (see signup-analytics.ts
 *     for why that matters for the once-marker).
 *   - `false` if the synchronous `gtag(...)` call itself throws — again,
 *     nothing was successfully queued.
 *   - `true` once `event_callback` actually fires (gtag.js loaded, queued
 *     and — per GA4's own `event_timeout` semantics — sent or scheduled to
 *     send the hit).
 *   - `true` on the `timeoutMs` timeout, PROVIDED the synchronous
 *     `gtag(...)` call above did not throw: by the time the timer fires,
 *     `dataLayer.push` has already run (it is synchronous), so the event
 *     is durably queued for whenever the real gtag.js library loads and
 *     drains that queue — this function cannot wait forever for a
 *     library that may take seconds to load without defeating the entire
 *     point of bounding the navigation delay, so "queued" is treated as
 *     good enough to count once the bound is reached, not as a delivery
 *     guarantee. See cto32-review-pr1979-20260915.md's S3 scenario for the
 *     measured gap this leaves on a multi-second gtag.js load.
 */
export function fireSignUpAndWait(params: TrackEventParams['sign_up'], timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let gtag: ((...args: unknown[]) => void) | undefined;
    try {
      gtag = getGtag();
    } catch {
      gtag = undefined;
    }
    if (!gtag) {
      resolve(false);
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (queued: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(queued);
    };
    timer = setTimeout(() => finish(true), timeoutMs);

    try {
      const safe = buildSafeParams('sign_up', params);
      gtag('event', 'sign_up', { ...safe, event_callback: () => finish(true) });
    } catch {
      finish(false);
    }
  });
}
