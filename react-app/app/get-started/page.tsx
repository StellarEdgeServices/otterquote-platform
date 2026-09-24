/**
 * Get Started — D-211 Phase 2
 *
 * Homeowner sign-up page (Google OAuth + email/password).
 * Feature-parity with static get-started.html.
 *
 * Auth flow:
 *   - If user is already logged in, redirect to appropriate dashboard.
 *   - New users choose one of two paths, both of which collect the same profile
 *     data first: Google OAuth or email + password. Google's button sits
 *     BELOW the account form as of 2026-09-15 (gh-1901 Option 1 note below),
 *     not above it and not visually primary — this line used to say
 *     otherwise and was corrected once the button moved. Either way we do
 *     leads insert (non-fatal) → write localStorage (cs_signup) → hand off
 *     to Supabase auth.
 *   - HubSpot contact creation (D-189) no longer fires from this page —
 *     the user has no session/JWT yet at this point, and create-hubspot-contact's
 *     homeowner mode requires one (D-211 CODE-3 hardening, 86e1xdaxe #1), so the
 *     pre-auth call always 401'd (#405). The cs_signup payload written below is
 *     read post-auth by the auth-callback page, which fires the HubSpot call
 *     once a valid session JWT exists.
 *
 * References: D-189 (HubSpot), D-211 (React surface), #405 (post-auth HubSpot move)
 *
 *   [gh-1901, 2026-09-14, Tier A/B] Two-step reorder: CRO RUN 20 found the
 *   page asked for an account (8 fields, 2 checkboxes) before a word about
 *   the home, against the page's own "tell us about your home" promise. Step
 *   1 asks only the property address before any account field is shown; the
 *   "what do you need help with" chip is offered but optional (CEO RUN 43
 *   review F4 — no consumer reads project_type yet, so it must not gate
 *   Step 1). Step 2 is the account form this file already had (name/email/
 *   password, Google or password). Phone stays optional on Step 2, but is
 *   now REQUIRED when the SMS-consent checkbox is ticked (CEO RUN 43 review
 *   F2 — a consent timestamp with no phone number is an orphan TCR record);
 *   see validateSmsConsent() below. Correction to the original claim here
 *   (CEO RUN 43 review F3): phone/address/name are NOT dead weight past this
 *   page — trade-selector/page.tsx writes phone/address/full_name to
 *   `profiles`, and auth-callback/page.tsx sends phone/address to HubSpot;
 *   neither call is made FROM this file, which is the only reason this
 *   page's own leads-insert/signUp() calls don't need them. No Supabase
 *   schema or Edge Function changed; SMS-consent and referrer opt-out
 *   checkbox COPY is untouched (Tier C boundary — only the phone
 *   requirement gating it is new). Closes on a fresh auth.users count 14
 *   days post-deploy beside the pre-change baseline (2 signups / 7 days,
 *   0 / 24h at 2026-09-08).
 *
 *   [CEO RUN 44 rebase, 2026-09-15] Rebased onto main past #1928 (gh-1817
 *   Meta Pixel Lead event + CRLF→LF normalization), #1914, #1934, #1935,
 *   #1936, #1937. fbq() and the fbq('track','Lead') call in
 *   fireSignupAnalytics are restored from main — see F1 in the CEO RUN 43
 *   FAIL review comment on this PR. Line endings normalized to LF to match
 *   main and remove the whole-file CRLF/LF diff that hid the pixel loss the
 *   first time.
 *
 *   [D-207 Google OAuth removed pre-launch] — REVERSED for this page on
 *   2026-08-26 by Dustin. His direction, verbatim: "The login for customers
 *   still has a magic link. I'd like to remove that as an option for homeowners
 *   if possible. I want it to be Oauth or set a password. I don't want to force
 *   homeowners to leave the site as the first step." D-207's pre-launch removal
 *   therefore no longer governs the homeowner sign-up surface: Google OAuth
 *   and email + password are both offered on Step 2, and magic link is gone
 *   from this page entirely (both the signInWithOtp call and the "check your
 *   email" panel that only it could reach). The reversal is recorded rather
 *   than deleted so nobody re-applies D-207 here without a newer decision
 *   from Dustin. /login and /contractor/login are untouched — this reversal
 *   is scoped to homeowner sign-up.
 *
 *   [Positional correction, 2026-09-15] This paragraph originally said the
 *   Google button sits "above the form as the primary path" — true on
 *   2026-08-26, false since the same-day gh-1901 Option 1 move put it BELOW
 *   the account form instead (see the note above). Corrected here rather
 *   than left stale, per the independent-review finding on PR #1929. D-207
 *   itself is unaffected; only this sentence's description of button
 *   position was wrong.
 *
 *   [gh-1940 rebase onto #1929, CEO RUN 47, 2026-09-15] #1948 (homeowner
 *   funnel GA4 step events, REVIEW: PASS at 2026-09-15T08:44:43Z on head
 *   d2901a12) was built against this file's retired single-step form and
 *   went `mergeable_state: dirty` once #1929's two-step rewrite landed
 *   first, exactly as both PRs' own collision notes predicted. Rebased
 *   here rather than re-authored from scratch, per the independent
 *   reviewer's own instruction embedded in the pre-rebase file (see the
 *   removed NOTE that used to sit above the old `profile_info`/
 *   `credentials` useEffects): `STEP_NAMES` is re-derived from #1929's
 *   real two screens (`home_info` = Step 1's address, `account` = Step
 *   2's name/email/password), and `TRACKED_FIELDS` gains `project_type`,
 *   #1929's one new Step-1 field. The security contract this PR exists
 *   for — `TRACK_EVENT_KEYS` is the only source of which keys `track()`
 *   reads, `FIELD_SANITIZERS` is the only path a value takes to reach
 *   `gtag()`, and no field VALUE (only field NAMES, closed unions) can
 *   reach GA4 — is carried over byte-for-byte; only the two step names
 *   and the one new tracked field name changed. Not re-reviewed as part
 *   of this rebase; flagged for a fresh independent review before merge.
 *
 *   [gh-1901 Option 2, 2026-09-22, CEO ruling 5780885632] Option 1 (button
 *   moved below the form, relabelled "Continue with Google") shipped the
 *   visual-order fix but left the click itself gated on
 *   validateAccountProfile() — a visitor with an empty Step 2 still saw an
 *   error instead of an OAuth redirect, the same shape of trap CRO
 *   reported, just smaller (2 fields instead of 7). handleGoogle no longer
 *   calls validateAccountProfile(); Google fires immediately regardless of
 *   Step 2 fill state. Name is recovered afterward instead of gated on
 *   upfront: auth-callback/page.tsx's backfillNameFromGoogleIdentity reads
 *   the OAuth identity's given_name/family_name (or full_name) and patches
 *   cs_signup's first_name/last_name before HubSpot and trade-selector's
 *   profile upsert read them, but only when this page left both blank —
 *   a name a visitor actually typed is never overwritten. Phone and "How
 *   did you hear about us" were already non-gating on this page (phone is
 *   optional unless SMS-consent is checked, per validateSmsConsent above;
 *   the referral chips have never had a required validator) — audited as
 *   part of this same change, not modified. SMS-consent checkbox and its
 *   wording: untouched, byte-for-byte (Tier C boundary, not crossed).
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { readReferralIds, writeReferralIds } from '@/lib/cookie-storage';
import { readFirstTouch } from '@/lib/attribution';
import { withFirstTouchParam } from '@/lib/attribution-core';
import { formatPhoneValue, isValidEmail, isValidZip, fullAddress, splitLeadName } from './utils';
import { captureVariantFromUrl } from '@/lib/variant';

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_CALLBACK_URL = 'https://app.otterquote.com/auth-callback';
// Same target the magic link used, plus the homeowner intent marker the static
// stack and /login already carry (see app/login/utils.ts GOOGLE_OAUTH_REDIRECT).
// Declared locally rather than imported from the login page so /get-started
// keeps owning its own redirect targets, as it always has.
const GOOGLE_OAUTH_REDIRECT = `${AUTH_CALLBACK_URL}?intent=homeowner`;
const DASHBOARD_URL = 'https://otterquote.com/dashboard.html';
const CONTRACTOR_DASHBOARD_URL = 'https://otterquote.com/contractor-dashboard.html';
const LOGIN_URL = 'https://otterquote.com/login.html';
const SUPPORT_EMAIL = 'info@otterquote.com';

const MIN_PASSWORD_LENGTH = 8;

/**
 * gh-1940 (amended after REVIEW: FAIL on #1948, finding 2) — how long we
 * wait, after kicking off the Google OAuth redirect, before treating
 * "still on this page" as evidence the redirect did not actually happen.
 * `signInWithOAuth` normally navigates the browser away in well under a
 * second; 2.5s is generous headroom above that, not a tuned timeout. See
 * handleGoogle for how this is used — it is a redirect-detection window,
 * not a network timeout on the Supabase call itself.
 */
const GOOGLE_REDIRECT_GRACE_MS = 2500;

/**
 * Shown when Supabase tells us the email already has an account. Dustin's
 * 2026-08-26 direction makes password the fallback path, and a generic
 * "something went wrong" on a duplicate email is the single most common way a
 * returning homeowner gets stuck on a sign-up form — so this points at sign-in
 * explicitly instead.
 */
const ALREADY_REGISTERED_MESSAGE =
  'An account with that email already exists. Sign in instead — use the "Sign in here" link below, or reset your password from that page if you have forgotten it.';

// gh-1901: Step 1 "what do you need help with" options. Kept short and
// storm-damage-led to match the trades OtterQuote actually serves; trade-selector
// (the very next screen after account creation) is still where the homeowner
// gives the full project detail — this is only the one-word headline CRO RUN 20
// asked to see ahead of account creation, not a replacement for that page.
// gh-1991: Roof/Siding/Gutters/Windows/Other — exactly the four trades
// trade-selector (TRADE_OPTIONS, ./../trade-selector/page.tsx) offers,
// plus "Other". "Water Damage" and "Doors" removed — not trades OtterQuote
// sells (CRO standing position 11). Values are named to match
// trade-selector's TradeKey 1:1 (`windows_doors` -> `windows`, new
// `gutters`) so the mapping in that page's pre-select effect is a direct
// lookup, not a translation table that can drift out of sync.
type ProjectType = 'roof' | 'siding' | 'gutters' | 'windows' | 'other' | '';

const PROJECT_TYPE_OPTIONS: { value: ProjectType; label: string }[] = [
  { value: 'roof', label: 'Roof' },
  { value: 'siding', label: 'Siding' },
  { value: 'gutters', label: 'Gutters' },
  { value: 'windows', label: 'Windows' },
  { value: 'other', label: 'Other' },
];

// gh-1993: 50 states + DC + Puerto Rico — matches VALID_STATE_CODES in
// trade-selector/utils.ts (the same set that page's address-parsing safety
// net trusts) so a value picked here is never later rejected downstream as
// "not a real state". Kept local (not imported) so this page has no
// cross-feature dependency on trade-selector's module.
const STATE_CODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' }, { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' },
  { value: 'DC', label: 'District of Columbia' }, { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' }, { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' }, { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' }, { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' }, { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' }, { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' }, { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' }, { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' }, { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' }, { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' }, { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' }, { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' }, { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' }, { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' }, { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' }, { value: 'PR', label: 'Puerto Rico' },
  { value: 'RI', label: 'Rhode Island' }, { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' }, { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' }, { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' },
];

// ─── GA4 helper ───────────────────────────────────────────────────────
//
// gh-1940 (round 3, REVIEW: FAIL on #1948 twice) — every closed vocabulary
// this page hands to GA4 is defined once, as an `as const` array, with two
// things derived from it: a TypeScript literal-union type (catches a typo
// or a wrong-shaped call at `tsc --noEmit` time) and a `Set` backing a
// same-named `sanitize*` function (the SAME check, run again at runtime, on
// every call, regardless of how the value reached this file). Type and
// runtime share one source and cannot drift apart. Round 2 applied this
// pattern to exactly one field (`TrackedField`/`sanitizeTrackedField`);
// round 3 applies it to every parameter `track()` accepts, because round
// 2's per-field guarantee did not extend to the object those fields lived
// in — see the comment on `track()` below for the attack that found that
// gap and how this closes it.
//
// gh-1940 (rebase onto #1929's two-step form, CEO RUN 47) — the shipped,
// REVIEW: PASS (2026-09-15T08:44:43Z) contract of this block is unchanged
// by the rebase: TRACK_EVENT_KEYS is still the only source of which keys
// `track()` reads, FIELD_SANITIZERS is still the only path a value takes
// to reach `gtag()`, and every sanitizer is still a closed `Set.has()` or a
// bounded shape check. The only things that changed are (a) STEP_NAMES,
// re-derived below from #1929's real two screens instead of the retired
// single-step grouping, and (b) TRACKED_FIELDS gaining `project_type`,
// #1929's one new Step-1 field. See the comment on STEP_NAMES and on the
// `markFieldTouched` call sites for exactly what moved and why.

const REFERRAL_SOURCES = ['insurance_agent', 'realtor', 'friend', 'web', ''] as const;
type ReferralSource = (typeof REFERRAL_SOURCES)[number];
const REFERRAL_SOURCE_SET: ReadonlySet<string> = new Set<string>(REFERRAL_SOURCES);
function sanitizeReferralSource(value: unknown): ReferralSource {
  return typeof value === 'string' && REFERRAL_SOURCE_SET.has(value) ? (value as ReferralSource) : '';
}

const SIGNUP_METHODS = ['google', 'password'] as const;
type SignupMethod = (typeof SIGNUP_METHODS)[number];
const SIGNUP_METHOD_SET: ReadonlySet<string> = new Set<string>(SIGNUP_METHODS);
function sanitizeSignupMethod(value: unknown): SignupMethod | 'unknown' {
  return typeof value === 'string' && SIGNUP_METHOD_SET.has(value) ? (value as SignupMethod) : 'unknown';
}

/**
 * gh-1940 (rebase onto #1929, CEO RUN 47) — re-derived from #1929's real
 * two screens instead of the retired single-step `'profile_info'` /
 * `'credentials'` grouping (which matched `validateProfile()` /
 * `validateEmailAndPassword()` on the single-step form this PR was
 * originally built against). #1929 turned this into an actual two-step UI
 * gated on its own `step` state:
 *   - Step 1 ("Tell Us About Your Home", `gs-step-indicator` label "Your
 *     Home") — property address plus the optional project-type chip,
 *     gated by `validateHomeInfo()`.
 *   - Step 2 ("Create Your Account", `gs-step-indicator` label "Your
 *     Account") — name/email/password/phone/consent, gated by
 *     `validateAccountProfile()` + `validateEmailAndPassword()`.
 * `home_info` / `account` name those two screens directly, so
 * `form_step_complete` now reports a boundary the visitor can actually see
 * — the defect the independent review flagged this exact rebase for.
 */
const STEP_NAMES = ['home_info', 'account'] as const;
type StepName = (typeof STEP_NAMES)[number];
const STEP_NAME_SET: ReadonlySet<string> = new Set<string>(STEP_NAMES);
function sanitizeStepName(value: unknown): StepName | 'unknown' {
  return typeof value === 'string' && STEP_NAME_SET.has(value) ? (value as StepName) : 'unknown';
}

/**
 * `job_type` and `source` on `homeowner_signup` are `URLSearchParams.get()`
 * values off the page URL — a marketing link controls them, so there is no
 * fixed vocabulary to allowlist the way the sets above do; legitimate
 * values are open-ended by design. Round 3 (REVIEW: FAIL finding 2) asked
 * this pair be "brought inside the closed set, or routed through the same
 * sanitizer" — a closed set is not possible here, so this is the latter: a
 * bounded SHAPE check instead of a bounded VOCABULARY check. Anything
 * containing a space, `@`, `.`, `!`, or any punctuation outside `-`/`_`, or
 * longer than 40 characters, is rejected outright — which covers every
 * field this page collects except an unusually simple alphanumeric
 * password. That residual is disclosed here, not hidden: this is a bound on
 * the SHAPE of an open channel, not a closed allowlist, and is not claimed
 * to be more than that. It does stop the exact values the independent
 * reviewer planted (`Hunter2-Sekrit-9f2a!` — rejected on `!`; a street
 * address — rejected on spaces/comma/length) — see the report for the
 * re-run repro.
 */
const MARKETING_PARAM_RE = /^[A-Za-z0-9_-]{1,40}$/;
function sanitizeMarketingParam(value: unknown): string | null {
  return typeof value === 'string' && MARKETING_PARAM_RE.test(value) ? value : null;
}

function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag(...args);
  }
}

/**
 * gh-1940 (amended after REVIEW: FAIL on #1948) — closed allowlist of field
 * NAMES `form_abandon`'s `last_field` may carry. `TRACKED_FIELDS` is the
 * single source of truth: `TrackedField` is derived from it with `typeof
 * […][number]` (so the type and the runtime Set can never drift apart), and
 * `TRACKED_FIELD_SET` backs `sanitizeTrackedField` below.
 *
 * Every call site passes a hardcoded literal, never `e.target.id` /
 * `e.target.name` / `e.target.value` — that is layer 1, and it is real:
 * `markFieldTouched(field: TrackedField)` (below) rejects anything not in
 * this exact list at compile time (`tsc --noEmit`, verified by the
 * independent reviewer against the positive control
 * `markFieldTouched((e.target as HTMLInputElement).value)` → TS2345).
 *
 * The FAIL finding was that layer 1 stopped one function short of the GA4
 * boundary: `track()` took `Record<string, unknown>`, so a value could
 * reach `gtag()` through any path that did NOT go through
 * `markFieldTouched` — writing `lastFieldRef.current` directly with an `as`
 * cast, or adding an extra property to the params object. Layer 2 below
 * closes that: `track()` is now generic over a closed `TrackEventParams`
 * map, so the *parameter bag itself* — not just `markFieldTouched`'s
 * argument — is typed per event. See the comment on `track()` for exactly
 * which of the reviewer's six attacks this stops, and which one it cannot
 * (and why layer 3, `sanitizeTrackedField`, exists for that one).
 *
 * gh-1940 (rebase onto #1929, CEO RUN 47) — `project_type` added: #1929's
 * one new Step-1 field (the "what do you need help with" chip). Its click
 * handler (`handleProjectTypeChip`, below) now calls `markFieldTouched`
 * the same way every other field on this page does; everything else in
 * this list is untouched from the reviewed head.
 */
const TRACKED_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'password',
  'confirm_password',
  'phone',
  'sms_consent',
  'referrer_opt_out',
  'address',
  'referral_source',
  'ref_name',
  'ref_email',
  'project_type',
] as const;

type TrackedField = (typeof TRACKED_FIELDS)[number];

const TRACKED_FIELD_SET: ReadonlySet<string> = new Set<string>(TRACKED_FIELDS);

/**
 * Layer 3 — the runtime backstop underneath the two type-level layers.
 *
 * Why a third layer is needed at all: TypeScript's `as T` assertion can
 * force a `string` into any type that overlaps it, including a string
 * literal union like `TrackedField`, and the compiler allows this by
 * design (it is documented, intentional behavior, not a gap someone could
 * "just fix" in the parameter typing). Concretely: nothing above stops
 * `lastFieldRef.current = someInputValue as TrackedField` from compiling.
 * That is attack 5 in the independent review — the one attack of six that
 * still compiles clean after the `track()` fix below.
 *
 * This function is the boundary that attack has to cross to reach GA4: it
 * is called at the one place `lastFieldRef.current` is read for emission
 * (the `pagehide` handler), and it maps anything not in the fixed
 * `TRACKED_FIELD_SET` — a value, an empty string, `undefined` coerced to
 * "undefined", anything — to the literal string `'none'`. Unlike the type
 * checks, this runs every time, in production, regardless of whether a
 * future edit forgets a cast is dangerous. It cannot be bypassed by an `as`
 * assertion because it is not a type check — it is an actual `Set.has()`
 * evaluated at runtime.
 */
function sanitizeTrackedField(value: unknown): TrackedField | 'none' {
  return typeof value === 'string' && TRACKED_FIELD_SET.has(value) ? (value as TrackedField) : 'none';
}

/**
 * Layer 2 — typed per event instead of `Record<string, unknown>`, so a
 * value can no longer reach `gtag()` by skipping `markFieldTouched` and
 * writing an extra/mistyped property directly into the object literal at a
 * `track()` call site — for a call written as a plain object literal.
 *
 * Round 3 (REVIEW: FAIL on #1948 twice) is why that qualifier matters: this
 * check is TypeScript's excess-property ("freshness") check, and it ONLY
 * runs against a fresh object literal passed directly as the argument.
 * Assign the exact same object to a `const` first, or build it with
 * `satisfies`, and the check does not run at all:
 *
 *   const leak = { last_field: 'email' as const, addr: liveAddr, pw: livePw };
 *   track('form_abandon', leak);   // tsc --noEmit → exit 0
 *
 * The independent reviewer built that and shipped a real password and
 * street address to `analytics.google.com/g/collect`. So layer 2 alone is
 * not the guarantee it was described as — it depends on how a future call
 * site happens to be written, and a `const`-hoisted params object is an
 * entirely ordinary refactor, not an attack someone has to go looking for.
 *
 * This layer is kept (it still catches the common mistake — a bare literal
 * with a bad value — at compile time, for free) but it is no longer treated
 * as the enforcement point. That is now `track()` itself; see its comment
 * below for the choke point that does not depend on how the object was
 * constructed.
 */
interface TrackEventParams {
  // Renamed from `form_start` (see round 2, finding 4): GA4 Enhanced
  // Measurement auto-collects its own `form_start` on every page with a
  // <form>, and reusing that name merged two populations with different
  // parameter shapes into one event. Namespacing this one avoids the
  // collision without touching any GA4 property setting (out of scope for
  // this PR). index.html's homeowner-CTA event was renamed too, to a THIRD,
  // distinctly-named event (`homeowner_cta_form_start`) rather than this
  // one — see the comment there for why they should not share a name.
  homeowner_form_start: Record<string, never>;
  form_step_complete: { step_name: StepName };
  form_abandon: { last_field: TrackedField | 'none' };
  sign_up: { method: SignupMethod; referral_source: ReferralSource };
  // job_type/source: URLSearchParams.get() off the page URL, controlled by
  // a marketing link — round 3 finding 2 flagged these as the two open
  // `string` channels inside an otherwise-closed map. Kept as `string |
  // null` / `string` here (no fixed vocabulary is possible for campaign
  // data), and instead routed through `sanitizeMarketingParam` inside
  // `track()` itself — see that function and `sanitizeMarketingParam`'s own
  // comment for what that bound does and does not guarantee.
  homeowner_signup: { job_type: string | null; source: string };
}

/**
 * Per-event whitelist of the ONLY keys `track()` will ever read off the
 * caller's params object, and the sanitizer each of those keys is passed
 * through before being handed to `gtag()`. Built from the same kind of `as
 * const` source as the types above (`TrackEventParams`'s own keys), so this
 * table and the interface cannot silently drift apart the way `track()`'s
 * old behavior (forward the object as-is) could drift from what the type
 * claimed to guarantee.
 */
const TRACK_EVENT_KEYS: { [E in keyof TrackEventParams]: ReadonlyArray<keyof TrackEventParams[E] & string> } = {
  homeowner_form_start: [],
  form_step_complete: ['step_name'],
  form_abandon: ['last_field'],
  sign_up: ['method', 'referral_source'],
  homeowner_signup: ['job_type', 'source'],
};

const FIELD_SANITIZERS: Record<string, (value: unknown) => unknown> = {
  step_name: sanitizeStepName,
  last_field: sanitizeTrackedField,
  method: sanitizeSignupMethod,
  referral_source: sanitizeReferralSource,
  job_type: sanitizeMarketingParam,
  source: sanitizeMarketingParam,
};

/**
 * gh-1940 — single GA4 call site for this page, so a reviewer auditing
 * "does any event parameter carry a field VALUE" has one function to read
 * instead of N.
 *
 * gh-1940 (round 3, REVIEW: FAIL on #1948 twice, finding 1) — `track()` used
 * to trust the shape of whatever object the caller handed it, forwarding it
 * to `gtag()` essentially unchanged, and relying on TypeScript's
 * excess-property check to have already rejected anything extra. That check
 * is a compile-time convenience with a documented hole (see the comment on
 * `TrackEventParams` above), so this function no longer relies on it, or on
 * anything else about how the caller constructed the object.
 *
 * `track()` now builds the object it sends to `gtag()` itself: for the
 * event being fired, it reads ONLY the keys `TRACK_EVENT_KEYS[event]` lists
 * — any other property on the object the caller passed, however that
 * object was built (`const`-hoisted, `satisfies`-cast, spread from
 * somewhere else, a shape nobody has written yet), is never looked at and
 * cannot reach GA4 through this function. Every value it DOES read is also
 * passed through that key's `FIELD_SANITIZERS` entry before being included
 * — a closed `Set` lookup for the five keys that have a fixed vocabulary
 * (`step_name`, `last_field`, `method`, `referral_source`), and a bounded
 * shape check for the two that cannot (`job_type`, `source`). This is the
 * single runtime choke point the round-3 review asked for: it runs
 * unconditionally, on every call, in production, and it is what actually
 * decides what reaches `gtag()` — not the object literal's freshness.
 *
 * Re-run against the round-3 attacks:
 *   - `const leak = {...}; track('form_abandon', leak)`                → `addr`/`pw` are not in `TRACK_EVENT_KEYS.form_abandon`, dropped; `last_field` still sanitized
 *   - `track('homeowner_signup', { job_type: password, source: address })` → both rejected by `sanitizeMarketingParam` (punctuation/length)
 *   - `track('form_step_complete', { step_name: email as StepName })`  → `sanitizeStepName` returns `'unknown'`, not the cast-laundered value
 *   - `gtag('event', 'form_abandon', { last_field: password, addr: address })` → NOT stopped by this function, because it does not go through this function at all — see below.
 *
 * What this does NOT do: prevent something from calling `gtag(...)`
 * directly instead of going through `track()`. `gtag` is an ordinary
 * module-level function in this file, not a private class member, and nothing
 * in TypeScript can make a function callable from exactly one other function
 * in the same module. That gap is real, disclosed rather than claimed away:
 * the realistic fix is outside what a type signature in this file can do —
 * an ESLint rule (e.g. `no-restricted-syntax` matching a bare `gtag(` call
 * outside `track()`/`fbq`) enforced in CI, or a naming convention hostile
 * enough to deter an accidental direct call. Neither is implemented here;
 * both are repo-wide tooling changes and out of this PR's footprint.
 *
 * Production/staging/localhost gating is inherited for free: `gtag()`
 * above is a no-op unless `window.gtag` exists, and `window.gtag` is only
 * ever defined by <GA4Gate> (app/components/GA4Gate.tsx), which requests
 * the GA4 library at all only on ALLOWED_HOSTS (gh-1619). Do not add a
 * second host check here — one gate, same as gh-1619 intended.
 */
function track<E extends keyof TrackEventParams>(event: E, params: TrackEventParams[E]): void {
  const allowedKeys = TRACK_EVENT_KEYS[event];
  const raw = params as unknown as Record<string, unknown>;
  const safeParams: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const sanitize = FIELD_SANITIZERS[key];
    safeParams[key] = sanitize ? sanitize(raw[key]) : undefined;
  }
  gtag('event', event, safeParams);
}

// ─── Meta Pixel helper — gh-1817 ──────────────────────────────────────────

function fbq(...args: unknown[]) {
  if (typeof window !== 'undefined' && (window as any).fbq) {
    (window as any).fbq(...args);
  }
}

/**
 * True when Supabase is telling us this email already has an account.
 * GoTrue reports this two different ways depending on project settings, and
 * both have to land on the same user-facing message (requirement from Dustin
 * 2026-08-26): an outright "User already registered" error when email
 * confirmation is off, or a 422 with code user_already_exists.
 */
function isAlreadyRegisteredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const code = (err as { code?: string } | null)?.code ?? '';
  return (
    /already\s+(registered|exists|been registered)/i.test(message) ||
    code === 'user_already_exists'
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GetStartedPage() {
  const { user, role, loading } = useAuthReady();

  // gh-2078: capture ?v=<arm> (forwarded by start.html's redirectTo/
  // collectAttribution) into this app's own localStorage on the very
  // first /get-started load -- see lib/variant.ts for why the marketing
  // site's own oq_variant_v3 cookie/localStorage cannot be read directly
  // from this origin. Runs once per mount; best-effort, never throws.
  useEffect(() => {
    captureVariantFromUrl();
  }, []);

  // Form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  // gh-1993: single free-text "address" box replaced with four separate
  // fields (Street / City / State / ZIP) — Dustin, 2026-09-16 chat,
  // verbatim: "Every address collection should have separate boxes...
  // Not all in one box." `state` is a 2-letter USPS code (STATE_CODE_OPTIONS
  // below drives the <select>, so an invalid code can't be typed) and `zip`
  // is validated to exactly 5 digits in validateHomeInfo(). See fullAddress()
  // below for how these four recombine into the one `address` string
  // existing readers (auth-callback's HubSpot sync) still expect.
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [addrState, setAddrState] = useState('');
  const [zip, setZip] = useState('');
  // gh-1901: asked in Step 1, before any account field — "what does the
  // homeowner want help with" is the value CRO RUN 20 found missing ahead of
  // account creation. Informational only: carried in the cs_signup
  // localStorage payload for the next step (trade-selector) to prefill, never
  // sent to the `leads` insert or supabase.auth.signUp() — no backend schema
  // touched by this field.
  const [projectType, setProjectType] = useState<ProjectType>('');
  // gh-1901: two-step flow — Step 1 asks about the home, Step 2 asks for the
  // account. Client-side only; no route change, so /get-started keeps its
  // one URL and Google's redirectTo target is untouched.
  const [step, setStep] = useState<1 | 2>(1);
  const [smsConsent, setSmsConsent] = useState(false);
  // gh-1337: homeowner opt-out for referrer progress-update emails. Copy
  // approved by Dustin on #1336 (R-120) — do not reword. Default false
  // (not null) so an unchecked box still records "shown, did not opt out",
  // the only value that permits the send-partner-status-email consent gate
  // to fire (see supabase/functions/send-partner-status-email/index.ts).
  const [referrerOptOut, setReferrerOptOut] = useState(false);
  const [referralSource, setReferralSource] = useState<ReferralSource>('');
  const [refName, setRefName] = useState('');
  const [refEmail, setRefEmail] = useState('');

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmEmailSent, setConfirmEmailSent] = useState(false);
  const [sentToEmail, setSentToEmail] = useState('');

  /**
   * Set the instant we begin our own post-sign-up navigation. When the Supabase
   * project auto-confirms emails, signUp() hands back a live session right away,
   * which would otherwise trip the "already logged in" redirect below and drop a
   * brand-new homeowner on the dashboard before /auth-callback has run the
   * post-auth HubSpot sync (#405) and the referral advance (#571). A ref, not
   * state, because this must take effect without waiting for a re-render.
   */
  const signupNavigation = useRef(false);

  // ── gh-1940: funnel step instrumentation ──
  //
  // formStartedRef: has the visitor touched this form at all yet. Gates
  // `homeowner_form_start` (fires once) and gates `form_abandon` (never
  // fires for a visitor who only looked at the page — page_view already
  // covers that).
  //
  // lastFieldRef: the NAME (never the value — see TrackedField above) of the
  // most recently touched field, read by the pagehide handler below when it
  // decides whether to send `form_abandon`. Written by markFieldTouched
  // ONLY — every call site below passes a hardcoded TrackedField literal,
  // and the pagehide handler additionally re-validates it through
  // `sanitizeTrackedField` at the point of emission (see that function's
  // comment for why the second check is not redundant).
  //
  // signupCompletedRef: true once the visitor has genuinely converted (or,
  // for the Google path, is genuinely mid-redirect to Google — see
  // handleGoogle's grace-period comment below for why that path needs more
  // care than "set it and forget it"). Suppresses `form_abandon` on a real
  // conversion's navigation-away.
  //
  // abandonFiredRef: once-guard so `form_abandon` cannot double-fire. The
  // independent review could not prove a double-fire in headless Chromium
  // (no bfcache restore in that harness) but flagged it as unproven, not
  // cleared — real bfcache restore-then-leave, or iOS Safari backgrounding,
  // can both re-run `pagehide`. A ref costs nothing and removes the question
  // entirely rather than leaving it to a browser this harness cannot drive.
  //
  // homeInfoStepFiredRef / accountStepFiredRef: gh-1940 (rebase onto #1929,
  // CEO RUN 47) — renamed from profileStepFiredRef/credentialsStepFiredRef
  // to match the STEP_NAMES rename (home_info/account) below them; same
  // once-guard role, now gating the two screens #1929 actually has instead
  // of the retired single-step field grouping.
  const formStartedRef = useRef(false);
  const lastFieldRef = useRef<TrackedField | null>(null);
  const signupCompletedRef = useRef(false);
  const abandonFiredRef = useRef(false);
  const homeInfoStepFiredRef = useRef(false);
  const accountStepFiredRef = useRef(false);
  // Pending "did the Google redirect actually happen" timer — see
  // handleGoogle and GOOGLE_REDIRECT_GRACE_MS above.
  const googleGraceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markFieldTouched = useCallback((field: TrackedField) => {
    lastFieldRef.current = field;
    if (!formStartedRef.current) {
      formStartedRef.current = true;
      track('homeowner_form_start', {});
    }
  }, []);

  // `form_step_complete{step_name:'home_info'}` no longer fires from an
  // `[address]` effect (gh-1940, CEO RUN 47 fix, ceo47-review-pr1948 defect
  // 1) — that effect fired on the FIRST KEYSTROKE in the address box
  // because `validateHomeInfo()`'s criterion (`address.trim()` non-empty)
  // is satisfied by one character, long before the visitor has actually
  // finished Step 1. The event now fires exactly once, inside
  // `handleContinueToAccount`, immediately after `validateHomeInfo()`
  // passes — the moment the visitor actually completes Step 1 and clicks
  // Continue. See `handleContinueToAccount` below.

  /**
   * `form_step_complete{step_name:'account'}` — fires once Step 2 (name,
   * email, password) is valid, using the same criteria
   * `validateAccountProfile()` + `validateEmailAndPassword()` gate on
   * submit. gh-1940 (rebase onto #1929, CEO RUN 47): this replaces the
   * retired `'credentials'` step. Under #1929's reorder, name and
   * email/password now live on the same screen (Step 2), so the two
   * former sub-groups collapse into the one real screen boundary; phone
   * and the two consent checkboxes are optional on Step 2 and are not
   * required for this event, matching validateAccountProfile/
   * validateEmailAndPassword exactly.
   */
  useEffect(() => {
    if (
      !accountStepFiredRef.current &&
      firstName.trim() &&
      lastName.trim() &&
      email.trim() &&
      isValidEmail(email.trim()) &&
      password.length >= MIN_PASSWORD_LENGTH &&
      password === confirmPassword
    ) {
      accountStepFiredRef.current = true;
      track('form_step_complete', { step_name: 'account' });
    }
  }, [firstName, lastName, email, password, confirmPassword]);

  // `form_abandon` — fires on real page unload (pagehide beats beforeunload
  // for mobile Safari/bfcache reliability) when the visitor started the form
  // but did not complete signup. `last_field` is re-validated through
  // `sanitizeTrackedField` immediately before it is read here — this is the
  // runtime layer described on that function, and it is what stands between
  // GA4 and a value smuggled into `lastFieldRef.current` via an `as`
  // assertion (the one attack the type system cannot see through).
  // `abandonFiredRef` makes this a true once-guard: the event fires on the
  // FIRST pagehide only, never on a bfcache restore-then-leave-again.
  useEffect(() => {
    const handlePageHide = () => {
      if (
        formStartedRef.current &&
        !signupCompletedRef.current &&
        !abandonFiredRef.current
      ) {
        abandonFiredRef.current = true;
        track('form_abandon', {
          last_field: sanitizeTrackedField(lastFieldRef.current ?? 'none'),
        });
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  // ── Redirect if already logged in ──
  useEffect(() => {
    if (loading) return;
    if (!user) return;
    if (signupNavigation.current) return;
    if (role === 'contractor') {
      window.location.href = CONTRACTOR_DASHBOARD_URL;
    } else {
      window.location.href = DASHBOARD_URL;
    }
  }, [loading, user, role]);

  /**
   * gh-2046: prefill Step 2 (name/email/phone) from the router's lead row,
   * via the EXISTING get_lead_prefill RPC (30-minute window,
   * prefill_used_at single-use — both enforced server-side; this effect
   * does not duplicate or relax either guard, it only calls the RPC and
   * reacts to what comes back).
   *
   * window.__oqRouterLeadId is set by the beforeInteractive strip script in
   * app/layout.tsx (see LEAD_STRIP_SCRIPT there) — by the time this effect
   * runs, the URL itself no longer carries `lead` at all, so this reads the
   * bridge variable rather than location.search. prefillAttemptedRef makes
   * this a true once-guard: get_lead_prefill stamps prefill_used_at on its
   * first successful call, so a second call for the same id (e.g. a
   * StrictMode double-invoke in dev) would legitimately come back empty —
   * guarding here avoids burning the single use on a call this page did not
   * need to make twice.
   *
   * Fields stay fully editable after prefill (setFirstName/etc. are the same
   * setters the form's own onChange handlers use) — this is prefill, not a
   * lock, per the issue's own requirement. A visitor with no `?lead=` param
   * (direct navigation, or a stripped id that already returned once) simply
   * never populates window.__oqRouterLeadId or gets an empty RPC result, and
   * the form renders exactly as it always has — this is additive, not a
   * behavior change to the no-prefill path.
   */
  const prefillAttemptedRef = useRef(false);
  useEffect(() => {
    if (prefillAttemptedRef.current) return;
    const leadId = typeof window !== 'undefined' ? window.__oqRouterLeadId : undefined;
    if (!leadId) return;
    prefillAttemptedRef.current = true;

    supabase
      .rpc('get_lead_prefill', { p_lead_id: leadId })
      .then(({ data, error: rpcError }) => {
        if (rpcError) {
          console.warn('[get-started] get_lead_prefill failed (non-fatal):', rpcError);
          return;
        }
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return; // no prefill available: expired, already used, or unknown id
        if (typeof row.name === 'string' && row.name.trim()) {
          const { firstName: fn, lastName: ln } = splitLeadName(row.name);
          if (fn) setFirstName(fn);
          if (ln) setLastName(ln);
        }
        if (typeof row.email === 'string' && row.email.trim()) {
          setEmail(row.email.trim());
        }
        if (typeof row.phone === 'string' && row.phone.trim()) {
          setPhone(formatPhoneValue(row.phone));
        }
      });
  }, []);

  // ── Phone formatting on autofill ──
  const handlePhoneChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPhone(formatPhoneValue(e.target.value));
    // gh-1940 (REVIEW: FAIL finding 3) — shared onChange/onBlur handler, so
    // this also covers the autofill case markFieldTouched's onFocus-only
    // wiring used to miss.
    markFieldTouched('phone');
  }, [markFieldTouched]);

  // ── Referral chip click ──
  const handleReferralChip = useCallback((val: ReferralSource) => {
    setReferralSource(prev => (prev === val ? '' : val));
    markFieldTouched('referral_source');
  }, [markFieldTouched]);

  // ── Project-type chip click (Step 1) — gh-1901 ──
  // gh-1940 (rebase onto #1929, CEO RUN 47): new markFieldTouched call site
  // — project_type did not exist when #1948 was written; it is #1929's one
  // new Step-1 field, added to TRACKED_FIELDS above.
  const handleProjectTypeChip = useCallback((val: ProjectType) => {
    setProjectType(prev => (prev === val ? '' : val));
    markFieldTouched('project_type');
  }, [markFieldTouched]);

  // ── Step 1 → Step 2 (gh-1901: home info before account fields) ──
  const handleContinueToAccount = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const problem = validateHomeInfo();
    if (problem) {
      setError(problem);
      return;
    }
    // gh-1940 (CEO RUN 47 fix, ceo47-review-pr1948 defect 1) — this is the
    // real Step 1 -> Step 2 boundary the visitor can actually see (the
    // Continue click, after validateHomeInfo() has already passed), not an
    // `[address]` effect that fired on the first keystroke. Once-guarded
    // the same way every other step event is.
    if (!homeInfoStepFiredRef.current) {
      homeInfoStepFiredRef.current = true;
      track('form_step_complete', { step_name: 'home_info' });
    }
    setStep(2);
  };

  // ── Validation ──

  /**
   * gh-1901: Step 1 — about the home, asked before any account field exists
   * on screen. Only the address is required to advance. The "what do you
   * need help with" chip (project_type) is offered but NOT required (CEO
   * RUN 43 review F4): requiring it would add funnel friction for an
   * optional signal. gh-1991 (CEO RUN 48): trade-selector now reads it to
   * pre-select a trade, but that is prefill convenience, not a gate — it
   * stays optional.
   *
   * gh-1993 (CEO RUN 48): the single "address" box is now four required
   * fields — street, city, state, ZIP — each checked individually so the
   * error names the actual missing piece instead of a generic "enter your
   * address". ZIP is shape-checked (5 digits) here; state can't be invalid
   * since it only ever comes from the STATE_CODE_OPTIONS <select>.
   */
  const validateHomeInfo = (): string | null => {
    if (!street.trim()) {
      return 'Please enter your street address.';
    }
    if (!city.trim()) {
      return 'Please enter your city.';
    }
    if (!addrState.trim()) {
      return 'Please select your state.';
    }
    if (!isValidZip(zip)) {
      return 'Please enter a valid 5-digit ZIP code.';
    }
    return null;
  };

  /**
   * Step 2 — account fields both the Google and password paths need. Google
   * hands us the email only after the round-trip, so email/password are
   * validated separately by the form path — but name has to be on the
   * clipboard before we leave the site, because register-time data cannot be
   * recovered from an OAuth callback. Step 1 (validateHomeInfo) already
   * guarantees address by the time this runs — projectType is optional
   * (CEO RUN 43 review F4: no consumer reads it yet), so it is NOT
   * guaranteed here. This line used to claim otherwise; corrected per the
   * independent-review finding on PR #1929.
   */
  const validateAccountProfile = (): string | null => {
    if (!firstName.trim() || !lastName.trim()) {
      return 'Please fill in your name before continuing.';
    }
    return null;
  };

  const validateEmailAndPassword = (): string | null => {
    if (!email.trim()) return 'Please fill in all required fields.';
    if (!isValidEmail(email.trim())) return 'Please enter a valid email address.';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password !== confirmPassword) return 'Passwords do not match.';
    return null;
  };

  /**
   * CEO RUN 43 review F2: phone is optional on Step 2, but the SMS-consent
   * checkbox writes `sms_consent_ts` into cs_signup regardless of whether a
   * phone number was ever entered — a consent timestamp for a subscriber
   * who does not exist. Required on both the Google and password paths
   * (handleGoogle and handleSubmit each call this before persisting), the
   * same way validateAccountProfile is required on both. Consent checkbox
   * copy itself is untouched — this only adds a phone requirement to using
   * it, which is validation logic, not consent wording (Tier C boundary).
   */
  const validateSmsConsent = (): string | null => {
    if (smsConsent && !phone.trim()) {
      return 'Please add a phone number, or leave the SMS-consent box unchecked, before continuing.';
    }
    return null;
  };

  // ── Shared pre-auth persistence ──

  /**
   * Everything that has to be on disk BEFORE we hand control to Supabase, used
   * identically by the password path and the Google path.
   *
   * For Google this is the "stash the pending signup payload before navigating"
   * step (same shape as the static partner-insurance.html cs_pending_partner_signup
   * pattern), except there is no need for a second pending-payload key here:
   * /auth-callback already reads cs_signup out of localStorage post-auth to fire
   * the HubSpot contact (#405), and /trade-selector already reads it to upsert
   * profiles. /get-started and /auth-callback are both on app.otterquote.com, so
   * localStorage — which is origin-scoped — survives the Google round-trip intact.
   * Reusing cs_signup keeps one mechanism instead of inventing a parallel one.
   */
  const persistSignupContext = (emailForLead: string | null) => {
    // 1. Insert into leads table (non-fatal, fire-and-forget — no await).
    //    Skipped when we have no email to attach: on the Google path the visitor
    //    may leave the email field blank, and the real address only arrives with
    //    the OAuth session.
    if (emailForLead) {
      supabase.from('leads').insert({
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: emailForLead,
        source: referralSource || 'web',
        created_at: new Date().toISOString(),
      }).then(({ error: leadErr }) => {
        if (leadErr) console.warn('[get-started] leads insert failed (non-fatal):', leadErr);
      });
    }

    // 2. Persist referral attribution.
    // Bridge 2026-08-26 (P0): cookie FIRST. ref.html writes these on
    // otterquote.com; this page is on app.otterquote.com and localStorage is
    // ORIGIN-scoped, so both reads below were always null here. Also note the
    // agent-id read had no localStorage fallback at all (unlike the id above),
    // so it lost the value on a new tab even same-origin.
    const refCookie = readReferralIds();
    const storedReferralId =
      refCookie.oq_referral_id ||
      (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('oq_referral_id')) ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('oq_referral_id')) ||
      null;
    const storedReferralAgentId =
      refCookie.oq_referral_agent_id ||
      (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('oq_referral_agent_id')) ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('oq_referral_agent_id')) ||
      null;

    // 3. Write cs_signup to localStorage
    localStorage.setItem(
      'cs_signup',
      JSON.stringify({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone.trim(),
        // gh-1993: combined line kept for existing readers (auth-callback's
        // HubSpot sync reads `address` as one string) alongside the four
        // split fields trade-selector's claim/profile writers now read
        // directly — no re-parsing needed on that end.
        address: fullAddress(street, city, addrState, zip),
        address_street: street.trim(),
        address_city: city.trim(),
        address_state: addrState.trim(),
        address_zip: zip.trim(),
        // gh-1901: Step 1's "what do you need help with" answer, carried
        // forward for trade-selector to prefill — same non-schema-touching
        // localStorage bridge every other field here already uses.
        project_type: projectType || null,
        referral_source:
          referralSource || (storedReferralAgentId ? 'partner_link' : 'web'),
        referring_agent_name: refName.trim() || null,
        referring_agent_email: refEmail.trim() || null,
        role: 'homeowner',
        sms_consent_ts: smsConsent ? new Date().toISOString() : null,
        // gh-1337: FALSE (not omitted/null) means "shown the checkbox, did not
        // opt out" — the only value that permits send-partner-status-email's
        // consent gate to fire. Read downstream by the claim-creation writer
        // and persisted to claims.referrer_updates_opt_out.
        referrer_updates_opt_out: referrerOptOut,
      }),
    );

    // 4. Persist referral_id so auth-callback can advance referral status.
    // Written through the cookie bridge so it survives the app<->www hop —
    // and, since 2026-08-26, the Google round-trip through accounts.google.com.
    if (storedReferralId) {
      writeReferralIds({
        oq_referral_id: storedReferralId,
        oq_referral_agent_id: storedReferralAgentId || undefined,
        oq_referral_code: refCookie.oq_referral_code,
      });
    }

    // 5. Store intended role for post-auth routing
    localStorage.setItem('cs_auth_role', 'homeowner');
  };

  /**
   * GA4 sign-up events — `method` distinguishes the two paths Dustin asked
   * for.
   *
   * gh-1940 (amended after REVIEW: FAIL on #1948, finding 2): this function
   * used to also set `signupCompletedRef.current = true` here, on the
   * theory that reaching this point means the signup genuinely happened.
   * That was true for the password path but NOT for the Google path: on
   * Google, this fires BEFORE `supabase.auth.signInWithOAuth` is even
   * called (deliberately — see handleGoogle), so "reached here" only meant
   * "about to attempt the redirect", not "converted". If the redirect
   * then failed to complete, nothing ever cleared the flag, and every
   * visitor who clicked Google and did not come back was invisible to
   * `form_abandon` while still being counted as a `sign_up`. Each caller
   * now owns setting `signupCompletedRef` itself, at the point it actually
   * knows whether the funnel step it represents will complete.
   *
   * gh-1940 fix2 (cto32-review-pr1979-20260915.md, REVIEW: FAIL, findings
   * B1/B2): this used to fire `sign_up` for BOTH methods here, pre-redirect.
   * For the Google path, that pre-redirect hit turned out to be reliably
   * delivered (contradicting this PR's original premise) and auth-callback's
   * OAuth-landing emit (signup-analytics.ts's maybeFireGoogleSignUp) was
   * ADDED alongside it rather than replacing it, so every delivered Google
   * signup was counted twice. `sign_up` is now counted in exactly one place
   * per method: the landing, for Google; here, unchanged, for password.
   * `referral_source` still reaches the landing's emit — it was already
   * being written into `cs_signup` below (persistSignupContext), which
   * auth-callback reads via `readReferralSourceFromCsSignup`.
   * `homeowner_signup` and the Meta `Lead` call below are UNCHANGED for
   * both methods: neither was identified as double-counted or lost by the
   * review (only `sign_up` was), and Meta Pixel is host-AND-path-gated to
   * `/get-started` only (components/MetaPixelGate.tsx `ALLOWED_PATHS`) —
   * `window.fbq` is never defined on `/auth-callback`, so a Lead call moved
   * there would silently no-op. Not adding a Meta Pixel mount there, or any
   * other new vendor call, per that gate's own "do not add a second mount"
   * warning.
   */
  const fireSignupAnalytics = (method: 'google' | 'password') => {
    const params = new URLSearchParams(
      typeof window !== 'undefined' ? window.location.search : '',
    );
    if (method === 'password') {
      track('sign_up', {
        method,
        referral_source: referralSource || 'web',
      });
    }
    track('homeowner_signup', {
      job_type: params.get('job_type') || null,
      source: params.get('utm_source') || referralSource || 'direct',
    });
    // gh-1817: Meta Pixel Lead event — fires on both the Google OAuth and
    // password sign-up paths, matching the GA4 call sites above exactly.
    fbq('track', 'Lead');
  };

  // ── Google OAuth sign-up (Dustin 2026-08-26; button sits below the form
  //    since the gh-1901 Option 1 move, not primary — see header) ──
  const handleGoogle = async () => {
    setError('');

    // gh-1901 (2026-09-22, Option 2 — CEO ruling 5780885632): name is no
    // longer required before this click fires OAuth. The previous
    // validateAccountProfile() gate here required first/last name before
    // Google would fire at all, which was itself a smaller version of the
    // exact trap CRO reported (comment 5673014838): a button that silently
    // refuses until other fields are typed. Google's own OAuth response
    // supplies given_name/family_name (or full_name), and
    // auth-callback/page.tsx's backfillNameFromGoogleIdentity fills
    // cs_signup's first_name/last_name from that identity on return when
    // this page left them blank — "collect what is still needed
    // afterward," per the issue body, rather than gate on it here. The
    // password path (handleSubmit) still calls validateAccountProfile(),
    // since there is no OAuth identity to backfill from on that path.
    // gh-1940 (CEO RUN 47 fix, ceo47-review-pr1948 defect 2) — the
    // `[firstName, lastName, email, password, confirmPassword]` effect
    // above requires a valid email+password, so it never fires for a
    // visitor who converts through Google. This is the moment the visitor
    // commits to the Google sign-in, so `account` fires here instead,
    // once-guarded on the SAME ref as the password path (whichever path
    // reaches its completion point first wins; the other is a no-op).
    // Deliberately no `method` param: `form_step_complete`'s
    // `TRACK_EVENT_KEYS` entry is `['step_name']` only — adding a value-
    // carrying key here would mean widening that allowlist, which is out
    // of scope (see track()'s comment on the security contract).
    if (!accountStepFiredRef.current) {
      accountStepFiredRef.current = true;
      track('form_step_complete', { step_name: 'account' });
    }
    // CEO RUN 43 review F2 — see validateSmsConsent(). Untouched by this
    // change: the SMS-consent checkbox's default (unchecked) and wording
    // are Tier C and are not part of this fix. This call only blocks a
    // click where the visitor already ticked consent but left phone
    // blank — not the reported trap, which reproduces on the untouched
    // default (unchecked) state.
    const smsProblemGoogle = validateSmsConsent();
    if (smsProblemGoogle) {
      setError(smsProblemGoogle);
      return;
    }

    setGoogleLoading(true);
    try {
      const typedEmail = email.trim();
      // Stash the profile payload BEFORE the browser leaves for Google —
      // nothing in the OAuth callback can reconstruct it otherwise.
      persistSignupContext(typedEmail && isValidEmail(typedEmail) ? typedEmail : null);
      // Fired here rather than after the call because a successful
      // signInWithOAuth unloads this page immediately.
      fireSignupAnalytics('google');
      signupNavigation.current = true;

      // gh-1940 (REVIEW: FAIL finding 2) — optimistically suppress
      // form_abandon, since a successful signInWithOAuth unloads this page
      // in well under GOOGLE_REDIRECT_GRACE_MS and we want no abandon on
      // that ordinary-success path. But arm a grace-period timer that
      // flips the suppression back off if we are STILL on this page once
      // it elapses — meaning the redirect did not actually happen (blocked,
      // stalled, or the user backed out of the Google chooser without it
      // registering as an error here). If it fires, a later real leave
      // is then correctly captured as an abandonment instead of being
      // permanently invisible.
      signupCompletedRef.current = true;
      if (googleGraceTimeoutRef.current !== null) {
        clearTimeout(googleGraceTimeoutRef.current);
      }
      googleGraceTimeoutRef.current = setTimeout(() => {
        signupCompletedRef.current = false;
        googleGraceTimeoutRef.current = null;
      }, GOOGLE_REDIRECT_GRACE_MS);

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // gh-1983: carry the first touch in the callback URL — survives the
        // FB/IG in-app browser -> Safari/Chrome switch Google's WebView block forces.
        options: { redirectTo: withFirstTouchParam(GOOGLE_OAUTH_REDIRECT, readFirstTouch()) },
      });
      if (oauthError) throw oauthError;
      // On success the browser navigates to Google; nothing else to do.
    } catch (err: unknown) {
      console.error('[get-started] Google sign-up error:', err);
      signupNavigation.current = false;
      // gh-1940 (REVIEW: FAIL finding 2) — a caught error means the OAuth
      // round-trip definitely did not start, so un-suppress form_abandon
      // immediately rather than waiting out the grace period, and cancel
      // the pending timer so it cannot re-run this after a later, unrelated
      // successful signup attempt.
      if (googleGraceTimeoutRef.current !== null) {
        clearTimeout(googleGraceTimeoutRef.current);
        googleGraceTimeoutRef.current = null;
      }
      signupCompletedRef.current = false;
      setGoogleLoading(false);
      setError('Google sign-up failed. Please try again, or create your account with the email and password form above.');
    }
  };

  // ── Email + password sign-up (alternative path) ──
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    const profileProblem = validateAccountProfile();
    if (profileProblem) {
      setError(profileProblem);
      return;
    }
    const credentialProblem = validateEmailAndPassword();
    if (credentialProblem) {
      setError(credentialProblem);
      return;
    }
    // An UNCHECKED SMS-consent box is fine per TCR/CTIA rules — do not block
    // on that. A CHECKED box with no phone number is the defect (CEO RUN 43
    // review F2); validateSmsConsent() only fires when the box is checked.
    const smsProblem = validateSmsConsent();
    if (smsProblem) {
      setError(smsProblem);
      return;
    }

    setSubmitting(true);

    try {
      const emailTrimmed = email.trim();

      // D-189/#405: HubSpot contact creation still runs post-auth in
      // auth-callback, unchanged by the 2026-08-26 auth rework — the JWT that
      // create-hubspot-contact's homeowner mode requires does not exist until
      // Supabase establishes a session, which is true of the password path for
      // exactly the same reason it was true of the magic link. cs_signup,
      // written by persistSignupContext below, is what carries the fields over.
      persistSignupContext(emailTrimmed);

      // Password sign-up. Mirrors js/auth.js signUpWithPassword (the helper the
      // static partner signup pages call) — same supabase.auth.signUp call with
      // an emailRedirectTo pointed at our own callback. Not routed through that
      // helper because it lives in the static stack's global Auth object, which
      // the React app deliberately does not load; the React surfaces call
      // `supabase.auth.*` directly (same convention as /login).
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: emailTrimmed,
        password,
        options: {
          emailRedirectTo: AUTH_CALLBACK_URL,
          // gh-1983: carry the first-touch ad attribution in user_metadata so a
          // confirmation link opened in a different browser/device still
          // attributes (record_first_touch_attribution falls back to it).
          data: { role: 'homeowner', oq_attribution: readFirstTouch() },
        },
      });
      if (signUpError) throw signUpError;

      // GoTrue's anti-enumeration behaviour: when email confirmation is ON, an
      // email that already has an account comes back as a SUCCESS with an empty
      // identities array rather than an error. Without this branch that user
      // would sit on a "check your email" panel waiting for a mail that never
      // arrives, which is precisely the dead end Dustin wanted removed.
      const identities = data.user?.identities;
      if (Array.isArray(identities) && identities.length === 0) {
        setError(ALREADY_REGISTERED_MESSAGE);
        return;
      }

      fireSignupAnalytics('password');
      // gh-1940 (REVIEW: FAIL finding 2) — unlike the Google path, reaching
      // this line means supabase.auth.signUp already returned successfully
      // (no signUpError, and not the already-registered branch above), so
      // the account genuinely exists now. No grace period needed: set the
      // completion flag immediately, whether or not a session redirect
      // follows.
      signupCompletedRef.current = true;

      if (data.session) {
        // Project auto-confirms email — session is live, so hand off to
        // /auth-callback for the normal post-auth routing (HubSpot sync,
        // referral advance, trade-selector vs dashboard).
        signupNavigation.current = true;
        window.location.href = AUTH_CALLBACK_URL;
        return;
      }

      // No session means the project requires email confirmation first. This is
      // a one-time account-confirmation mail, not a magic-link sign-in loop:
      // the password they just set is what they use from here on.
      setSentToEmail(emailTrimmed);
      setConfirmEmailSent(true);
    } catch (err: unknown) {
      console.error('[get-started] signup error:', err);
      if (isAlreadyRegisteredError(err)) {
        setError(ALREADY_REGISTERED_MESSAGE);
        return;
      }
      const msg =
        err instanceof Error ? err.message : 'An unexpected error occurred.';
      setError(`Something went wrong. Please try again or email us at ${SUPPORT_EMAIL}. (${msg})`);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / redirect in-flight ──
  if (loading || (user && !loading)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ width: 24, height: 24, border: '3px solid rgba(224,123,0,0.2)', borderTopColor: 'var(--amber, #E07B00)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const showReferralAgentFields = referralSource === 'insurance_agent' || referralSource === 'realtor';

  return (
    <>
      <style>{`
        .gs-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          min-height: calc(100vh - 64px);
        }
        .gs-left {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--sp-12, 3rem) var(--sp-8, 2rem);
        }
        .gs-form-wrap {
          width: 100%;
          max-width: 440px;
        }
        .gs-form-wrap h1 {
          font-size: 2rem;
          margin-bottom: var(--sp-2, 0.5rem);
          color: var(--white, #fff);
        }
        .gs-subtitle {
          color: var(--slate, #94a3b8);
          font-size: 1rem;
          margin-bottom: var(--sp-8, 2rem);
          line-height: 1.6;
        }
        /* gh-1901: two-step layout — step indicator + back link */
        .gs-step-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 0.8rem;
          font-weight: 600;
          color: var(--slate, #94a3b8);
          margin-bottom: var(--sp-4, 1rem);
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }
        .gs-step-indicator .gs-step-current { color: var(--amber, #E07B00); }
        .gs-back-link {
          background: none;
          border: none;
          color: var(--slate, #94a3b8);
          font-size: 0.85rem;
          font-family: inherit;
          cursor: pointer;
          padding: 0;
          margin-bottom: var(--sp-4, 1rem);
        }
        .gs-back-link:hover { color: var(--amber, #E07B00); }
        .project-type-options {
          display: flex;
          gap: var(--sp-3, 0.75rem);
          flex-wrap: wrap;
        }
        .project-type-chip {
          padding: 10px 18px;
          border-radius: 9999px;
          border: 1px solid rgba(255,255,255,0.15);
          background: transparent;
          color: var(--slate, #94a3b8);
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }
        .project-type-chip:hover { border-color: var(--amber, #E07B00); color: var(--amber, #E07B00); }
        .project-type-chip.active {
          background: var(--amber, #E07B00);
          color: var(--navy, #0B1929);
          border-color: var(--amber, #E07B00);
          font-weight: 700;
        }
        .gs-form {
          display: flex;
          flex-direction: column;
          gap: var(--sp-5, 1.25rem);
        }
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--sp-4, 1rem);
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: var(--sp-1, 0.25rem);
        }
        .form-label {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--white, #fff);
        }
        .form-input {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 8px;
          padding: 10px 14px;
          color: var(--white, #fff);
          font-size: 1rem;
          width: 100%;
          box-sizing: border-box;
          font-family: inherit;
          transition: border-color 0.15s;
        }
        .form-input:focus {
          outline: none;
          border-color: var(--amber, #E07B00);
        }
        .form-hint {
          font-size: 0.8rem;
          color: var(--slate, #94a3b8);
        }
        /* Google button + divider — same rules as /login's .btn-google so both
           auth surfaces stay visually identical (Dustin 2026-08-26). */
        .btn-google {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          width: 100%;
          padding: 12px 20px;
          border-radius: 8px;
          border: 1.5px solid #dadce0;
          background: #fff;
          cursor: pointer;
          font-size: 15px;
          font-weight: 500;
          color: #3c4043;
          transition: box-shadow 0.15s, border-color 0.15s;
          font-family: inherit;
        }
        .btn-google:hover:not(:disabled) {
          box-shadow: 0 1px 4px rgba(0,0,0,.16);
          border-color: #c6c9cd;
        }
        .btn-google:disabled { opacity: 0.7; cursor: not-allowed; }
        .gs-oauth-hint {
          font-size: 0.8rem;
          color: var(--slate, #94a3b8);
          text-align: center;
          margin: 8px 0 0;
        }
        .oauth-divider {
          display: flex;
          align-items: center;
          gap: 12px;
          margin: 20px 0;
          color: var(--gray, #64748b);
          font-size: 13px;
        }
        .oauth-divider::before, .oauth-divider::after {
          content: '';
          flex: 1;
          height: 1px;
          background: rgba(255,255,255,0.12);
        }
        .referral-section {
          padding: var(--sp-4, 1rem);
          background: rgba(255,255,255,0.03);
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.06);
        }
        .referral-legend {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--slate, #94a3b8);
          margin-bottom: var(--sp-3, 0.75rem);
          display: block;
        }
        .referral-options {
          display: flex;
          gap: var(--sp-3, 0.75rem);
          flex-wrap: wrap;
          margin-bottom: var(--sp-3, 0.75rem);
        }
        .referral-chip {
          padding: 6px 16px;
          border-radius: 9999px;
          border: 1px solid rgba(255,255,255,0.15);
          background: transparent;
          color: var(--slate, #94a3b8);
          font-size: 0.85rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }
        .referral-chip:hover { border-color: var(--amber, #E07B00); color: var(--amber, #E07B00); }
        .referral-chip.active {
          background: var(--amber, #E07B00);
          color: var(--navy, #0B1929);
          border-color: var(--amber, #E07B00);
          font-weight: 700;
        }
        .referral-name-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--sp-3, 0.75rem);
          margin-top: var(--sp-3, 0.75rem);
        }
        .form-checkbox-wrapper {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          cursor: pointer;
        }
        .form-checkbox {
          appearance: none;
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          border: 2px solid var(--slate, #94a3b8);
          border-radius: 4px;
          background: transparent;
          cursor: pointer;
          transition: all 0.15s;
          flex-shrink: 0;
          margin-top: 2px;
          position: relative;
        }
        .form-checkbox:hover { border-color: var(--amber, #E07B00); }
        .form-checkbox:checked {
          background: var(--amber, #E07B00);
          border-color: var(--amber, #E07B00);
        }
        .form-checkbox:checked::after {
          content: '✓';
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--navy, #0B1929);
          font-size: 0.75rem;
          font-weight: 700;
        }
        .form-error {
          background: rgba(239,68,68,0.1);
          border: 1px solid rgba(239,68,68,0.3);
          border-left: 4px solid #EF4444;
          color: #FECACA;
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 0.9rem;
        }
        .btn-primary-full {
          background: var(--amber, #E07B00);
          color: var(--navy, #0B1929);
          border: none;
          border-radius: 8px;
          padding: 14px 24px;
          font-size: 1rem;
          font-weight: 700;
          cursor: pointer;
          width: 100%;
          font-family: inherit;
          transition: all 0.15s;
          position: relative;
        }
        .btn-primary-full:hover:not(:disabled) {
          background: #f08c10;
          transform: translateY(-1px);
        }
        .btn-primary-full:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-loading-spinner {
          display: inline-block;
          width: 18px;
          height: 18px;
          border: 2px solid rgba(11,25,41,0.3);
          border-top-color: var(--navy, #0B1929);
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
          vertical-align: middle;
          margin-right: 8px;
        }        .text-sm-center {
          font-size: 0.85rem;
          text-align: center;
          color: var(--gray, #64748b);
          margin-top: var(--sp-4, 1rem);
        }
        .text-sm-center a { color: var(--amber, #E07B00); font-weight: 600; text-decoration: none; }
        /* Account-confirmation panel. Same visual treatment the magic-link
           "check your email" panel used before 2026-08-26 — the panel survives
           because Supabase can still require a one-time confirmation click on a
           brand-new password account; only the magic-link sign-in loop is gone. */
        .gs-confirm-sent {
          text-align: center;
          padding: var(--sp-8, 2rem) 0;
        }
        .gs-confirm-icon { font-size: 3rem; margin-bottom: 1rem; }
        .gs-confirm-sent h2 {
          font-size: 1.5rem;
          color: var(--white, #fff);
          margin-bottom: 0.75rem;
        }
        .gs-confirm-sent p {
          color: var(--slate, #94a3b8);
          max-width: 340px;
          margin: 0 auto;
        }
        .gs-confirm-email {
          display: inline-block;
          background: rgba(224,123,0,0.12);
          color: var(--amber, #E07B00);
          font-weight: 700;
          padding: 6px 14px;
          border-radius: 4px;
          margin: 12px 0;
          font-family: monospace;
          font-size: 0.9rem;
        }
        .gs-right {
          background: var(--navy-2, #0f2036);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--sp-12, 3rem) var(--sp-8, 2rem);
          border-left: 1px solid rgba(255,255,255,0.06);
        }
        .gs-benefits { max-width: 380px; }
        .gs-benefits h2 {
          font-size: 1.5rem;
          color: var(--white, #fff);
          margin-bottom: 2rem;
        }
        .benefit-item {
          display: flex;
          gap: 1rem;
          margin-bottom: 1.5rem;
        }
        .benefit-icon {
          width: 40px;
          height: 40px;
          border-radius: 8px;
          background: rgba(224,123,0,0.12);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.2rem;
          flex-shrink: 0;
        }
        .benefit-text h4 {
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--white, #fff);
          margin: 0 0 4px;
        }
        .benefit-text p {
          font-size: 0.85rem;
          color: var(--slate, #94a3b8);
          margin: 0;
          line-height: 1.5;
        }
        @media (max-width: 768px) {
          .gs-layout { grid-template-columns: 1fr; }
          .gs-right {
            border-left: none;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            padding: 1.5rem;
            /* order: -1 removed 2026-09-15 (gh-1901 round 3, independent
               review): this rule put the benefits panel — including the
               "Continue with Google" copy above — ahead of the account
               form on phones, undoing the Option 1 move for the mobile
               majority of homeowner traffic even though desktop and the
               form's own internal order were already form-first. Natural
               source order (form, then benefits) now applies at this
               breakpoint too. */
          }
          .gs-left { padding: 2rem 1.5rem; }
          .form-row { grid-template-columns: 1fr; }
          .referral-name-row { grid-template-columns: 1fr; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div className="gs-layout">
        {/* ── Left: Form ── */}
        <div className="gs-left">
          <div className="gs-form-wrap">
            {/* ── Account-Confirmation State ── */}
            {confirmEmailSent ? (
              <>
                <h1>Get Started</h1>
                <p className="gs-subtitle">
                  Create your free account and start getting competitive quotes from contractors.
                </p>
                <div className="gs-confirm-sent">
                  <div className="gs-confirm-icon">✉️</div>
                  <h2>Confirm Your Email</h2>
                  <p>Your account is created. We sent a one-time confirmation link to:</p>
                  <div className="gs-confirm-email">{sentToEmail}</div>
                  <p style={{ marginTop: '1rem' }}>
                    Click the link to activate your account. After that, sign in any time with
                    the password you just set.
                  </p>
                  <p className="text-sm-center">
                    <a href={LOGIN_URL}>Go to sign in</a>
                  </p>
                </div>
              </>
            ) : step === 1 ? (
              /*
                ── Step 1: About the home — gh-1901 ──
                CRO RUN 20 (#1901): the page's own promise is "tell us about
                your home", but the old single-step form asked for an account
                first — 8 fields and 2 checkboxes, none about the home, before
                anything else. This step asks only what the backend needs to
                let the homeowner move forward: the property address (already
                collected pre-account, just reordered — see form-group below)
                and, new, a one-tap "what do you need help with" chip. Neither
                field touches the `leads` insert or supabase.auth.signUp() —
                both are staged in cs_signup for trade-selector, same as every
                other pre-account field on this page already was.
              */
              <form
                className="gs-form"
                onSubmit={handleContinueToAccount}
                noValidate
              >
                <h1>Tell Us About Your Home</h1>
                <p className="gs-subtitle">
                  It&apos;s free, and takes under a minute. Create your account next.
                </p>

                {/*
                  gh-1993: single free-text box split into Street / City /
                  State / ZIP — Dustin's ruling, verbatim, in the file
                  header at the top of this component. Autocomplete
                  attributes (address-line1/address-level2/address-level1/
                  postal-code) are the standard WHATWG token set, so phones
                  autofill each box correctly instead of dumping the whole
                  saved address into one field.
                */}
                <div className="form-group">
                  <label className="form-label" htmlFor="street">Street Address</label>
                  <input
                    type="text"
                    id="street"
                    className="form-input"
                    required
                    autoComplete="address-line1"
                    placeholder="123 Main St"
                    value={street}
                    onChange={e => { setStreet(e.target.value); markFieldTouched('address'); }}
                    onFocus={() => markFieldTouched('address')}
                  />
                  <span className="form-hint">The address for your project.</span>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="city">City</label>
                    <input
                      type="text"
                      id="city"
                      className="form-input"
                      required
                      autoComplete="address-level2"
                      placeholder="Anytown"
                      value={city}
                      onChange={e => { setCity(e.target.value); markFieldTouched('address'); }}
                      onFocus={() => markFieldTouched('address')}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="state">State</label>
                    <select
                      id="state"
                      className="form-input"
                      required
                      autoComplete="address-level1"
                      value={addrState}
                      onChange={e => { setAddrState(e.target.value); markFieldTouched('address'); }}
                      onFocus={() => markFieldTouched('address')}
                    >
                      <option value="">Select...</option>
                      {STATE_CODE_OPTIONS.map(({ value, label }) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="zip">ZIP Code</label>
                    <input
                      type="text"
                      id="zip"
                      className="form-input"
                      required
                      inputMode="numeric"
                      autoComplete="postal-code"
                      pattern="\d{5}"
                      maxLength={5}
                      placeholder="12345"
                      value={zip}
                      onChange={e => { setZip(e.target.value.replace(/\D/g, '').slice(0, 5)); markFieldTouched('address'); }}
                      onFocus={() => markFieldTouched('address')}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">What do you need help with?</label>
                  <div className="project-type-options">
                    {PROJECT_TYPE_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        className={`project-type-chip${projectType === value ? ' active' : ''}`}
                        onClick={() => handleProjectTypeChip(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {error && <div className="form-error" role="alert">{error}</div>}

                <button type="submit" className="btn-primary-full">
                  Continue
                </button>

                <p className="text-sm-center">
                  Already have an account?{' '}
                  <a href={LOGIN_URL}>Sign in here</a>
                </p>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="gs-back-link"
                  onClick={() => { setError(''); setStep(1); }}
                >
                  &larr; Back
                </button>
                <div className="gs-step-indicator">
                  <span>Your Home</span>
                  <span>&rarr;</span>
                  <span className="gs-step-current">Your Account</span>
                </div>
                <h1>Create Your Account</h1>
                <p className="gs-subtitle">
                  Free, and takes under a minute. We&apos;ll match {street ? 'your home' : 'you'} with contractors next.
                </p>
                {/* ── Email + Password Sign-Up Form ── */}
                <form className="gs-form" onSubmit={handleSubmit} noValidate>
                {/* Name row */}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="first-name">First Name</label>
                    <input
                      type="text"
                      id="first-name"
                      className="form-input"
                      required
                      autoComplete="given-name"
                      placeholder="Jane"
                      value={firstName}
                      onChange={e => { setFirstName(e.target.value); markFieldTouched('first_name'); }}
                      onFocus={() => markFieldTouched('first_name')}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="last-name">Last Name</label>
                    <input
                      type="text"
                      id="last-name"
                      className="form-input"
                      required
                      autoComplete="family-name"
                      placeholder="Smith"
                      value={lastName}
                      onChange={e => { setLastName(e.target.value); markFieldTouched('last_name'); }}
                      onFocus={() => markFieldTouched('last_name')}
                    />
                  </div>
                </div>

                {/* Email */}
                <div className="form-group">
                  <label className="form-label" htmlFor="email">Email</label>
                  <input
                    type="email"
                    id="email"
                    className="form-input"
                    required
                    autoComplete="email"
                    placeholder="jane@example.com"
                    value={email}
                    onChange={e => { setEmail(e.target.value); markFieldTouched('email'); }}
                    onFocus={() => markFieldTouched('email')}
                  />
                  <span className="form-hint">This is how you&apos;ll sign in, and where bid alerts go.</span>
                </div>

                {/* Password + confirm — the alternative to Google, per Dustin 2026-08-26 */}
                <div className="form-group">
                  <label className="form-label" htmlFor="password">Password</label>
                  <input
                    type="password"
                    id="password"
                    className="form-input"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={e => { setPassword(e.target.value); markFieldTouched('password'); }}
                    onFocus={() => markFieldTouched('password')}
                  />
                  <span className="form-hint">Minimum {MIN_PASSWORD_LENGTH} characters.</span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="confirm-password">Confirm Password</label>
                  <input
                    type="password"
                    id="confirm-password"
                    className="form-input"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={e => { setConfirmPassword(e.target.value); markFieldTouched('confirm_password'); }}
                    onFocus={() => markFieldTouched('confirm_password')}
                  />
                </div>

                {/* Phone — optional by default (gh-1901: this page's own
                    leads-insert/signUp() calls never read it). But see the
                    SMS-consent checkbox just below: validateSmsConsent()
                    now requires a phone number the moment that box is
                    ticked, so a consent timestamp is never recorded against
                    no phone (CEO RUN 43 review F2). Phone still matters
                    downstream even when unchecked — trade-selector writes
                    it to `profiles` and auth-callback sends it to HubSpot
                    (CEO RUN 43 review F3). */}
                <div className="form-group">
                  <label className="form-label" htmlFor="phone">Phone <span style={{ fontWeight: 400, color: 'var(--slate, #94a3b8)' }}>(optional)</span></label>
                  <input
                    type="tel"
                    id="phone"
                    className="form-input"
                    autoComplete="tel"
                    placeholder="(317) 555-1234"
                    value={phone}
                    onChange={handlePhoneChange}
                    onBlur={handlePhoneChange}
                    onFocus={() => markFieldTouched('phone')}
                  />
                  <span className="form-hint">For bid notifications and updates via text.</span>
                </div>

                {/* SMS Consent — TWILIO MESSAGE_FLOW / TCPA */}
                {/* Text source: legal.ts SMS_CONSENT_LABEL + inline privacy/terms links */}
                <div className="form-group">
                  <label className="form-checkbox-wrapper">
                    <input
                      type="checkbox"
                      id="sms-consent"
                      className="form-checkbox"
                      checked={smsConsent}
                      onChange={e => { setSmsConsent(e.target.checked); markFieldTouched('sms_consent'); }}
                      onFocus={() => markFieldTouched('sms_consent')}
                    />
                    <span style={{ fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--slate, #94a3b8)' }}>
                      {/* TWILIO MESSAGE_FLOW required language */}
                      I agree to receive transactional SMS from Otter Quotes. Message frequency varies.
                      Message and data rates may apply. Reply STOP to unsubscribe. See our{' '}
                      <a href="https://otterquote.com/privacy.html" style={{ color: 'var(--amber, #E07B00)', textDecoration: 'underline' }}>
                        Privacy Policy
                      </a>{' '}
                      and{' '}
                      <a href="https://otterquote.com/terms.html" style={{ color: 'var(--amber, #E07B00)', textDecoration: 'underline' }}>
                        Terms of Service
                      </a>
                      .
                    </span>
                  </label>
                </div>

                {/* Referrer-updates opt-out — gh-1337, copy approved by Dustin on #1336 (R-120) */}
                {/* Text source: referrer-disclosure-copy-2026-08-19.md § 2 — verbatim, do not reword */}
                <div className="form-group">
                  <label className="form-checkbox-wrapper">
                    <input
                      type="checkbox"
                      id="referrer-updates-opt-out"
                      className="form-checkbox"
                      checked={referrerOptOut}
                      onChange={e => { setReferrerOptOut(e.target.checked); markFieldTouched('referrer_opt_out'); }}
                      onFocus={() => markFieldTouched('referrer_opt_out')}
                    />
                    <span style={{ fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--slate, #94a3b8)' }}>
                      <strong style={{ color: 'inherit' }}>Don&apos;t send project updates to the person who referred me</strong>
                      <br />
                      If someone referred you to Otter Quotes, we send them short updates as your project moves —
                      claim submitted, bids in, contractor picked, agreement signed, job done — using your first
                      name and last initial only. We never share your claim amount, your contractor&apos;s name, or
                      damage details with them. Check this box if you&apos;d rather they not get these updates.
                      Questions? Email support@otterquote.com.
                    </span>
                  </label>
                </div>

                {/* Property Address moved to Step 1 (gh-1901) — already
                    captured in street/city/addrState/zip state (gh-1993)
                    by the time this step renders. */}

                {/* Referral Source */}
                <fieldset className="referral-section" style={{ padding: '1rem', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                  <legend className="referral-legend">How did you hear about us?</legend>
                  <div className="referral-options">
                    {(
                      [
                        { value: 'insurance_agent', label: 'Insurance Agent' },
                        { value: 'realtor', label: 'Realtor' },
                        { value: 'friend', label: 'Friend/Family' },
                        { value: 'web', label: 'Found Online' },
                      ] as { value: ReferralSource; label: string }[]
                    ).map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        className={`referral-chip${referralSource === value ? ' active' : ''}`}
                        onClick={() => handleReferralChip(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {showReferralAgentFields && (
                    <div className="referral-name-row">
                      <div className="form-group">
                        <label className="form-label" htmlFor="ref-name">Their Name</label>
                        <input
                          type="text"
                          id="ref-name"
                          className="form-input"
                          placeholder="Agent / Realtor name"
                          value={refName}
                          onChange={e => { setRefName(e.target.value); markFieldTouched('ref_name'); }}
                          onFocus={() => markFieldTouched('ref_name')}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor="ref-email">Their Email (optional)</label>
                        <input
                          type="email"
                          id="ref-email"
                          className="form-input"
                          placeholder="agent@company.com"
                          value={refEmail}
                          onChange={e => { setRefEmail(e.target.value); markFieldTouched('ref_email'); }}
                          onFocus={() => markFieldTouched('ref_email')}
                        />
                      </div>
                    </div>
                  )}
                </fieldset>

                {/* Error */}
                {error && <div className="form-error" role="alert">{error}</div>}

                {/* Submit */}
                <button
                  type="submit"
                  className="btn-primary-full"
                  disabled={submitting || googleLoading}
                >
                  {submitting ? (
                    <><span className="btn-loading-spinner" />Creating account…</>
                  ) : (
                    'Create My Free Account'
                  )}
                </button>

                <p className="text-sm-center">
                  By creating an account, you agree to our{' '}
                  <a href="https://otterquote.com/terms.html">Terms of Service</a> and{' '}
                  <a href="https://otterquote.com/privacy.html">Privacy Policy</a>.
                </p>

                <p className="text-sm-center">
                  Already have an account?{' '}
                  <a href={LOGIN_URL}>Sign in here</a>
                </p>

                <p className="text-sm-center">
                  Are you a contractor?{' '}
                  <a href="https://otterquote.com/contractor-join.html">Apply to join here</a>
                </p>
                </form>

                <div className="oauth-divider"><span>or continue with Google</span></div>

                {/*
                  Google OAuth — alternative path (restored 2026-08-26 on
                  Dustin's direction, see the file header for the D-207
                  reversal). MOVED BELOW the form 2026-09-15 (gh-1901 comment
                  5673014838, Option 1): the button sat above the form,
                  styled primary, read "Sign up with Google", and did
                  nothing but show validateAccountProfile's error until
                  name/phone/address were filled — a trap for the mobile /
                  in-app-browser audience the ads deliver. Moving it below
                  the form makes the visual order match the actual order.
                  validateAccountProfile() (name) and validateSmsConsent()
                  (phone, only if SMS-consent is checked) still run on
                  click, and persistSignupContext() still stashes Step 1 +
                  Step 2 fields before the browser leaves for Google —
                  unchanged. Relabelled "Continue with Google" per the same
                  finding: button copy only, no consent/terms/legal text
                  touched (Tier B, Dustin-ruled on #1901). Options 2 and 3
                  from the same finding are NOT implemented here — Dustin's
                  ruling covers Option 1 only.
                */}
                <button
                  type="button"
                  className="btn-google"
                  onClick={handleGoogle}
                  disabled={googleLoading || submitting}
                >
                  {googleLoading ? (
                    'Redirecting to Google…'
                  ) : (
                    <>
                      <GoogleIcon />
                      Continue with Google
                    </>
                  )}
                </button>
                <p className="gs-oauth-hint">
                  We&apos;ll carry the details above into your new account.
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Right: Benefits ── */}
        <div className="gs-right">
          <div className="gs-benefits">
            <h2>What Happens Next</h2>

            {/* Copy updated 2026-08-26 with the auth rework — the old first step
                described the magic-link inbox round-trip, which no longer exists
                on this page. */}
            <div className="benefit-item">
              <div className="benefit-icon">🔐</div>
              <div className="benefit-text">
                <h4>Create your account</h4>
                <p>Continue with Google or set a password. You stay on the site — no waiting on an email to get started.</p>
              </div>
            </div>

            <div className="benefit-item">
              <div className="benefit-icon">📄</div>
              <div className="benefit-text">
                <h4>Build your project details</h4>
                <p>Upload your documents or use our &ldquo;Help Me&rdquo; tools. We&apos;ll guide you through everything.</p>
              </div>
            </div>

            <div className="benefit-item">
              <div className="benefit-icon">🎯</div>
              <div className="benefit-text">
                <h4>Contractors compete</h4>
                <p>We put your job in front of contractors who serve your area. You compare the quotes that come in and choose the best deal.</p>
              </div>
            </div>

            <div className="benefit-item">
              <div className="benefit-icon">💰</div>
              <div className="benefit-text">
                <h4>Always free for you</h4>
                <p>Otter Quotes is 100% free for homeowners. Contractors pay to earn your business, not you.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Google "G" mark (same SVG as /login and the static login.html) ──────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
