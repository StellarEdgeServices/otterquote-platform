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
 */

'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

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

    // Immediate error — no point subscribing
    if (errorCode) {
      setPageState('error');
      return;
    }

    let handled = false;

    async function routeSession(session: { user: { id: string } } | null) {
      if (handled) return;
      handled = true;

      if (!session) {
        setPageState('error');
        return;
      }

      const intent =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem('cs_auth_role')
          : null;

      // Role resolution — contractor-table-first (F-007 pattern)
      let role: string | null = null;
      try {
        const { data: contractor } = await supabase
          .from('contractors')
          .select('id')
          .eq('user_id', session.user.id)
          .maybeSingle();
        if (contractor) {
          role = 'contractor';
        } else {
          const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', session.user.id)
            .maybeSingle();
          role = (profile?.role as string) ?? null;
        }
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
