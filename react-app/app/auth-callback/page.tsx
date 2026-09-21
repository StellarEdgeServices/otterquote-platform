/**
 * Auth Callback — D-211
 *
 * Handles Supabase magic-link and OAuth redirects for the React app
 * (https://app.otterquote.com/auth-callback).
 *
 * Mirrors the routing logic of the static auth-callback.html so the
 * React sign-up flow lands users in the right place:
 *
 *   contractor record found        → otterquote.com/contractor-dashboard.html
 *   intent=contractor, no record   → otterquote.com/contractor-pre-approval.html
 *   homeowner with existing claim  → otterquote.com/dashboard.html
 *   homeowner, no claim yet        → /trade-selector  (React route)
 *
 * Error handling: expired / invalid links show a friendly retry UI
 * that sends users back to /get-started.
 *
 * #405: HubSpot contact creation (D-189) also happens here, post-auth, for the
 * homeowner path. get-started/page.tsx used to fire create-hubspot-contact
 * before the magic link was clicked, when no session JWT existed yet — the
 * function's homeowner mode requires one (D-211 CODE-3 hardening, 86e1xdaxe #1),
 * so that pre-auth call always 401'd. The session is live by the time we reach
 * routeSession() below, so supabase.functions.invoke attaches a valid JWT
 * automatically (same pattern as contractor/pre-approval's HubSpot sync).
 *
 * gh-1940: GA4 `sign_up` (Google path) also fires here, post-auth. This is
 * now the ONLY place a Google sign_up is counted — get-started/page.tsx no
 * longer fires one pre-redirect (see its `fireSignupAnalytics`) — fixed per
 * cto32-review-pr1979-20260915.md (REVIEW: FAIL, findings B1/B2): the
 * pre-redirect emit was in fact delivered (contrary to the original claim
 * this file's history carried), so keeping BOTH emits double-counted every
 * delivered Google signup. Fires at most once per user
 * (maybeFireGoogleSignUp below), gated on the account being newly created
 * with a bounded clock-skew allowance — a returning Google sign-in must
 * never emit this. The call is AWAITED (bounded to ~1s — see
 * lib/track.ts's fireSignUpAndWait) so the redirect below cannot tear the
 * page down before the hit has had a real chance to be queued/sent; the
 * referral_source dimension is carried through the `cs_signup` payload
 * get-started/page.tsx already wrote before the redirect.
 */

'use client';

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

import { readReferralIds, writeReferralIds } from '@/lib/cookie-storage';
import { maybeFireGoogleSignUp, readReferralSourceFromCsSignup } from './signup-analytics';
import { adoptFirstTouchFromParam, recordFirstTouch } from '@/lib/attribution';

// ─── HubSpot — D-189, fired post-auth (#405) ─────────────────────────────────

/** Same payload shape create-hubspot-contact's homeowner mode always expected. */
function buildHomeownerHubspotBody(email: string, signup: Record<string, unknown>) {
  return {
    email,
    firstname: (signup.first_name as string) || '',
    lastname: (signup.last_name as string) || '',
    phone: (signup.phone as string) || '',
    address: (signup.address as string) || '',
  };
}

/**
 * Fire-and-forget HubSpot contact sync for the homeowner sign-up flow.
 * Reads the cs_signup payload get-started/page.tsx wrote to localStorage pre-auth.
 * Never overwrites a contractor's HubSpot record — skips if cs_signup is absent
 * or was tagged for the contractor role (mirrors js/auth.js's same guard).
 */
function fireHomeownerHubspotContact(email: string | null | undefined) {
  if (!email) return;
  let signup: Record<string, unknown> = {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('cs_signup') : null;
    if (!raw) return;
    signup = JSON.parse(raw);
  } catch {
    return;
  }
  if (signup.role === 'contractor') return;

  supabase.functions
    .invoke('create-hubspot-contact', { body: buildHomeownerHubspotBody(email, signup) })
    .catch(() => {
      // Intentionally fire-and-forget — D-189
    });
}

// ─── Destinations ─────────────────────────────────────────────────────────────
const CONTRACTOR_DASHBOARD_URL = 'https://otterquote.com/contractor-dashboard.html';
const CONTRACTOR_SIGNUP_URL    = 'https://otterquote.com/contractor-pre-approval.html';
const HOMEOWNER_DASHBOARD_URL  = 'https://otterquote.com/dashboard.html';
const TRADE_SELECTOR_PATH      = '/trade-selector';
const GET_STARTED_PATH         = '/get-started';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read error_code from the hash fragment BEFORE Supabase clears it. */
function detectHashError(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash.includes('error=')) return null;
  const params = new URLSearchParams(hash.slice(1));
  return params.get('error_code') || params.get('error') || 'auth_error';
}

/** True when the URL contains tokens / PKCE code that Supabase will exchange. */
function urlHasAuthTokens(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.hash.includes('access_token') ||
    window.location.search.includes('code=')
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

type PageState = 'loading' | 'error';

export default function AuthCallbackPage() {
  const [pageState, setPageState] = useState<PageState>('loading');

  useEffect(() => {
    // Capture hash state before Supabase's onAuthStateChange processes and clears it
    const errorCode = detectHashError();
    const hasTokens = urlHasAuthTokens();

    // gh-1983: hold a first touch carried on ?ft= (Google OAuth redirectTo) and
    // strip it from the address bar before analytics read the URL. It is
    // adopted in routeSession() only once a real session exists — proof of an
    // auth return (a crafted link cannot seed a campaign), with no race against
    // Supabase clearing the hash before hydration.
    let ftParam: string | null = null;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('ft')) {
        ftParam = params.get('ft');
        const clean = new URL(window.location.href);
        clean.searchParams.delete('ft');
        window.history.replaceState(window.history.state, '', clean.toString());
      }
    } catch {
      // non-fatal
    }

    // Immediate error — no point subscribing
    if (errorCode) {
      setPageState('error');
      return;
    }

    let handled = false;

    async function routeSession(session: Session | null) {
      if (handled) return;
      handled = true;

      if (!session) {
        setPageState('error');
        return;
      }

      // #571: advance referral clicked→registered via the v95 SECURITY
      // DEFINER RPC (mirrors js/auth.js handleAuthCallback — a direct UPDATE
      // no-ops against RLS), then re-key the id so the claim writer
      // (trade-selector) can stamp claims.referral_id. Non-fatal: never
      // block sign-in routing on referral bookkeeping.
      try {
        // gh-2051 PR review (finding 2): the localStorage oq_referral_id
        // preserved below after a failed advance has no natural expiry
        // (unlike the oq-ref cookie's pre-existing 90-day TTL, which is
        // untouched and out of scope here). Bound the RETRY window to 24h
        // via a sibling oq_referral_id_saved_at timestamp, stamped once on
        // the first failure (see below) — a retry that hasn't happened
        // within a day never will, and holding on longer just risks a
        // LATER, DIFFERENT visitor on the same browser inheriting a stale
        // referral id. If the stamp is present and past that window, drop
        // the preserved state here, before it ever reaches the RPC.
        const OQ_REFERRAL_RETRY_TTL_MS = 24 * 60 * 60 * 1000;
        if (typeof localStorage !== 'undefined') {
          const savedAt = localStorage.getItem('oq_referral_id_saved_at');
          if (savedAt !== null) {
            const age = Date.now() - Number(savedAt);
            if (!Number.isFinite(age) || age > OQ_REFERRAL_RETRY_TTL_MS) {
              localStorage.removeItem('oq_referral_id');
              localStorage.removeItem('oq_referral_id_saved_at');
              if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('oq_referral_id');
              }
            }
          }
        }

        const referralId =
          (typeof localStorage !== 'undefined' &&
            localStorage.getItem('oq_referral_id')) ||
          (typeof sessionStorage !== 'undefined' &&
            sessionStorage.getItem('oq_referral_id')) ||
          // Bridge 2026-08-26 (P0): cross-subdomain cookie fallback — the two
          // origin-scoped reads above are blind to anything ref.html wrote on
          // otterquote.com.
          readReferralIds().oq_referral_id ||
          null;
        if (referralId) {
          const { data: advanced, error: advanceError } = await supabase.rpc(
            'advance_referral_registered',
            { p_referral_id: referralId }
          );
          if (advanceError) {
            console.warn(
              '[auth-callback] referral advance failed (non-fatal):',
              advanceError
            );
          } else if (advanced === false) {
            // gh-2051: the RPC ran fine but UPDATE ... WHERE status='clicked'
            // matched nothing (FOUND=false) — the referral id doesn't exist,
            // or it already moved past 'clicked' (registered/job_completed).
            // Definitive, non-retryable no-op, not an error — still falls
            // through to the clears below.
            console.warn(
              '[auth-callback] advance_referral_registered found no clicked referral to advance for',
              referralId
            );
          }
          // #567: keep the id under a claim-scoped key so the claim writer
          // (trade-selector) can stamp claims.referral_id.
          // gh-2051: written UNCONDITIONALLY, even when advanceError fired
          // above. The claim linkage (claims.referral_id) is a separate
          // concern from the status advance — we already have a valid
          // referralId regardless of whether the status flip succeeded, and
          // a homeowner can submit a claim before a later retry completes.
          // Do not gate this on advanceError.
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('oq_referral_id_for_claim', referralId);
          }
          // Keep the cookie alive so the claim writer still sees it after a hop.
          {
            const kept = readReferralIds();
            writeReferralIds({
              oq_referral_id: referralId,
              oq_referral_agent_id: kept.oq_referral_agent_id,
              oq_referral_code: kept.oq_referral_code,
            });
          }
          // gh-2051 PR review (finding 1): whether preserving oq_referral_id
          // on advanceError actually leads to a retry depends on the caller.
          // This React route re-runs routeSession() from scratch on every
          // fresh page load — a revisit with a still-live session re-fires
          // INITIAL_SESSION with a session present (see the
          // onAuthStateChange wiring below), and a brand-new sign-in fires
          // SIGNED_IN — so a retry here is real, not hypothetical. (Contrast
          // js/auth.js's contractor-dashboard.html entry point, where the
          // equivalent retry is structurally impossible — see the comment
          // there.) Only a DEFINITIVE outcome — success, or the confirmed
          // no-op above — clears the keys; advanceError leaves them (bounded
          // by the TTL stamped below) for that next load to retry.
          if (!advanceError) {
            if (typeof localStorage !== 'undefined') {
              localStorage.removeItem('oq_referral_id');
              localStorage.removeItem('oq_referral_id_saved_at');
            }
            if (typeof sessionStorage !== 'undefined') {
              sessionStorage.removeItem('oq_referral_id');
            }
          } else if (
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('oq_referral_id_saved_at') === null
          ) {
            // Stamp the retry clock only on the FIRST failure, so repeated
            // failed retries don't keep pushing the 24h window out.
            localStorage.setItem('oq_referral_id_saved_at', String(Date.now()));
          }
        }
      } catch {
        // Non-fatal — see above. A thrown exception means the RPC call
        // never completed at all, so the removes above never ran and
        // oq_referral_id / its sessionStorage copy are naturally preserved
        // for a retry on the next load — same intent as the advanceError
        // branch above (gh-2051). referralId itself is out of scope here
        // (block-scoped to the try above), so stamp the retry clock off of
        // oq_referral_id's mere presence instead — same first-failure-only
        // guard, so this path can't leave the key unbounded either.
        if (
          typeof localStorage !== 'undefined' &&
          localStorage.getItem('oq_referral_id') !== null &&
          localStorage.getItem('oq_referral_id_saved_at') === null
        ) {
          localStorage.setItem('oq_referral_id_saved_at', String(Date.now()));
        }
      }

      // gh-1983: persist first-touch ad attribution (UTM / fbclid / gclid)
      // onto the profile — write-once, server-guarded, bounded to 2.5 s and
      // non-fatal. Awaited because every branch below navigates away.
      adoptFirstTouchFromParam(ftParam);
      await recordFirstTouch(supabase);

      const intent =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem('cs_auth_role')
          : null;

      // Role resolution — gh-909 (D-182 v113, 2026-08-19): single
      // fact-table-derived read via public.resolved_user_role replaces the
      // old contractors -> profiles.role cascade, which (like
      // auth-provider.tsx's resolveRole()) never queried referral_agents at
      // all. See supabase/migrations/v113_derived_role_view.sql and
      // js/auth.js getRole()'s comment for the full design. Routing below is
      // UNCHANGED — this page has no partner destination, so a partner-only
      // account still falls through to the homeowner path exactly as before;
      // only the FACT source moved.
      let role: string | null = null;
      try {
        const { data: resolved } = await supabase
          .from('resolved_user_role')
          .select('derived_role')
          .eq('user_id', session.user.id)
          .maybeSingle();
        role = (resolved?.derived_role as string) ?? null;
      } catch {
        // Proceed with null role — default to homeowner path below
      }

      // Contractor already has a record → straight to dashboard
      if (role === 'contractor') {
        window.location.href = CONTRACTOR_DASHBOARD_URL;
        return;
      }

      // Contractor sign-up intent but no record yet → pre-approval wizard
      if (intent === 'contractor') {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('cs_auth_role');
        }
        window.location.href = CONTRACTOR_SIGNUP_URL;
        return;
      }

      // Homeowner path confirmed (not a contractor record, no contractor intent) —
      // safe to fire the post-auth HubSpot sync now that a session JWT exists (#405).
      fireHomeownerHubspotContact(session.user.email);

      // gh-1940 fix2: GA4 `sign_up` (Google path) — see
      // maybeFireGoogleSignUp's header for the full guard rationale
      // (new-user + one-time marker) and lib/track.ts's fireSignUpAndWait
      // for why this is awaited before the redirect below.
      await maybeFireGoogleSignUp(session.user, readReferralSourceFromCsSignup());

      // Homeowner: returning (has claim) → dashboard, new → trade-selector
      try {
        const { data: claim } = await supabase
          .from('claims')
          .select('id')
          .eq('user_id', session.user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (claim) {
          window.location.href = HOMEOWNER_DASHBOARD_URL;
          return;
        }
      } catch {
        // No claim found — fall through to trade-selector
      }

      window.location.href = TRADE_SELECTOR_PATH;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        await routeSession(session);
      } else if (event === 'INITIAL_SESSION') {
        if (session) {
          await routeSession(session);
        } else if (!hasTokens) {
          // No tokens in URL + no existing session = something failed
          await routeSession(null);
        }
        // else: tokens present, PKCE exchange still in progress — wait for SIGNED_IN
      }
    });

    // Safety net: surface an error if nothing resolves within 30 s
    const safetyTimer = setTimeout(() => {
      if (!handled) setPageState('error');
    }, 30_000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(safetyTimer);
    };
  }, []);

  if (pageState === 'error') {
    return <ErrorCard />;
  }

  return <LoadingCard />;
}

// ─── UI sub-components ────────────────────────────────────────────────────────

function LoadingCard() {
  return (
    <>
      <style>{KEYFRAMES}</style>
      <div style={S.page}>
        <div style={S.card}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/otter-logo.svg"
            alt="Otter Quotes"
            style={{ width: 56, height: 56, margin: '0 auto 24px', display: 'block' }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
          <div style={S.spinner} className="oq-spin" />
          <h1 style={S.h1}>Signing you in&hellip;</h1>
          <p style={S.sub}>Just a moment while we verify your session.</p>
        </div>
      </div>
    </>
  );
}

function ErrorCard() {
  return (
    <>
      <style>{KEYFRAMES}</style>
      <div style={S.page}>
        <div style={S.card}>
          <div style={{ fontSize: '2.5rem', marginBottom: 16 }}>🔒</div>
          <h1 style={{ ...S.h1, color: '#fca5a5' }}>Sign-in link expired</h1>
          <p style={{ ...S.sub, marginBottom: 24 }}>
            Your sign-in link may have expired or already been used. Please
            request a new one.
          </p>
          <a href={GET_STARTED_PATH} style={S.btn}>
            Try again
          </a>
        </div>
      </div>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const KEYFRAMES = `@keyframes oq-spin { to { transform: rotate(360deg); } }`;

const S = {
  page: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    minHeight: '100vh',
    fontFamily: 'Rubik, sans-serif',
    background: 'var(--navy, #0B1929)',
  },
  card: {
    background: 'var(--navy-2, #0f2036)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: '48px 40px',
    textAlign: 'center' as const,
    maxWidth: 420,
    width: '90%',
  },
  spinner: {
    width: 40,
    height: 40,
    border: '3px solid rgba(255,255,255,0.10)',
    borderTopColor: 'var(--amber, #E07B00)',
    borderRadius: '50%',
    margin: '0 auto 24px',
  },
  h1: {
    fontSize: '1.375rem',
    fontWeight: 600,
    marginBottom: 8,
    color: 'var(--white, #fff)',
  },
  sub: {
    fontSize: '0.9375rem',
    color: 'var(--slate, #94a3b8)',
    lineHeight: 1.5,
    margin: 0,
  },
  btn: {
    display: 'inline-block',
    background: 'var(--amber, #E07B00)',
    color: 'var(--navy, #0B1929)',
    borderRadius: 8,
    padding: '10px 24px',
    fontSize: '0.9375rem',
    fontWeight: 700,
    textDecoration: 'none',
    fontFamily: 'inherit',
  },
} as const;
