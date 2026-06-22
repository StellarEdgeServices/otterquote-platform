/**
 * AuthProvider — D-211 React auth layer
 *
 * Implements the F-007 ready() pattern from js/auth.js in React:
 * - Subscribes to onAuthStateChange on mount
 * - Resolves auth state after INITIAL_SESSION fires (race-free)
 * - Keeps sb_at cookie in sync on TOKEN_REFRESHED
 * - Performs contractor-table-first role check (F-007 getRole())
 * - Checks admin allow-list via email + contractors.template_review_role
 *
 * ADMIN EMAILS: dustinstohler1@gmail.com, dustin@otterquote.com
 * STORAGE KEY: sb_at (D-211 — sq_at is deprecated)
 */

'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { readValidCookieSession } from '../lib/cookie-storage';
import type { AuthContextValue, AuthState, AuthUser, OtterRole } from '../types/auth';

// ─── Admin allow-list (mirrors admin-auth-gate.ts) ───────────────────────────
const ADMIN_EMAILS: string[] = [
  'dustinstohler1@gmail.com',
  'dustin@otterquote.com',
];

// Bound role/admin resolution so a stalled Supabase read can never strand the auth
// gate on "Loading" (D-212 cookie-only contractor hang, ClickUp 86e1yv72z). On
// timeout we settle AUTHENTICATED with a best-effort null role rather than spin
// forever; the contractor gate treats a null role as not-blocked and page-level RLS
// remains the authority. Kept < the 6s settle backstop so the primary resolver
// settles before the backstop can re-enter it.
const ROLE_RESOLVE_TIMEOUT_MS = 4000;

// ─── Cookie helper (F-007 _setSingleAuthCookie) ──────────────────────────────
function setSbAtCookie(session: Session | null): void {
  if (typeof document === 'undefined') return;
  if (session?.access_token) {
    try {
      const parts = session.access_token.split('.');
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
      );
      const maxAge = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
      document.cookie = `sb_at=${session.access_token}; path=/; SameSite=Lax; max-age=${maxAge}`;
    } catch {
      // Malformed token — clear rather than leave stale
      document.cookie =
        'sb_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
  } else {
    document.cookie =
      'sb_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }
}

// ─── Role resolution (F-007 getRole — contractor-table-first) ────────────────
async function resolveRole(user: User): Promise<OtterRole> {
  try {
    const { data: contractor, error } = await supabase
      .from('contractors')
      .select('id')
      .eq('user_id', user.id)
      .single();
    if (contractor && !error) return 'contractor';
  } catch {
    // No contractor record — fall through
  }

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    return (profile?.role as OtterRole) ?? null;
  } catch {
    return null;
  }
}

// ─── Admin check (F-007 _getIsAdmin) ─────────────────────────────────────────
async function resolveIsAdmin(user: User): Promise<boolean> {
  if (ADMIN_EMAILS.includes(user.email ?? '')) return true;
  try {
    const { data } = await supabase
      .from('contractors')
      .select('template_review_role')
      .eq('user_id', user.id)
      .single();
    return data?.template_review_role === 'admin';
  } catch {
    return false;
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth() must be called inside <AuthProvider>');
  }
  return ctx;
}

// ─── Provider ────────────────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    role: null,
    isAdmin: false,
    loading: true,
    settled: false,
  });

  // Prevent double-resolution if StrictMode fires the effect twice
  const resolved = useRef(false);

  useEffect(() => {
    resolved.current = false;

    // Resolve auth state from a session object. Shared by the onAuthStateChange
    // listener and the proactive getSession() fetch below. The `resolved` ref
    // ensures the first resolver wins — a later real event cannot double-resolve
    // or flash a logged-in user out. (86e1mrwrx)
    const resolveSession = async (session: Session | null) => {
      if (resolved.current) return;
      if (session?.user) {
        // Resolve role + admin in parallel — but NEVER let a stalled query strand the
        // gate on "Loading". A hung contractors/profiles read (the orphaned-lock /
        // slow-auth window the rest of D-211 hardens against) must not keep
        // `resolved`/`settled` false forever: that is the D-212 cookie-only hang — the
        // 6s backstop recovers the valid cookie, re-enters this resolver, and loops
        // straight back to the spinner (86e1yv72z). Bound the wait and settle
        // AUTHENTICATED with a best-effort null role; a late real value cannot override
        // because `resolved` is set just below.
        const [role, isAdmin] = await Promise.race<[OtterRole, boolean]>([
          Promise.all([resolveRole(session.user), resolveIsAdmin(session.user)]),
          new Promise<[OtterRole, boolean]>((resolve) => {
            setTimeout(() => resolve([null, false]), ROLE_RESOLVE_TIMEOUT_MS);
          }),
        ]);
        // A competing resolver may have won during the awaits above.
        if (resolved.current) return;
        setSbAtCookie(session);
        setState({
          user: session.user as unknown as AuthUser,
          role,
          isAdmin,
          loading: false,
          settled: true,
        });
      } else {
        // COLD-START PRECEDENCE (D-211, ClickUp 86e1zpryf). A null/no-user session
        // can reach the PRIMARY resolve path before supabase-js has loaded the
        // cross-subdomain cookie session — on a fresh app.otterquote.com origin the
        // client can emit INITIAL_SESSION with session=null while storage/lock is
        // still priming, ahead of the getSession() that returns the reconstructed
        // cookie session. Settling unauthenticated here — and locking it in via
        // `resolved` — ejects an authenticated user mid-hydration: the homeowner gate
        // hard-redirects to get-started.html, the contractor gate to /contractor/login.
        // Recover the valid shared cookie session first (the SAME readValidCookieSession
        // precedence the 6s fail-safe already uses, now applied on the primary path so a
        // FAST null-resolve can't slip past it). The recovered session has a user, so the
        // recursive call takes the authenticated branch; role resolution still runs, so
        // this neither broadens access nor changes gating. A genuinely logged-out request
        // (no valid cookie) falls through and still settles unauthenticated → still bounces.
        const cookieSession = readValidCookieSession();
        if (cookieSession) {
          void resolveSession(cookieSession as unknown as Session);
          return;
        }
        setSbAtCookie(null);
        setState({ user: null, role: null, isAdmin: false, loading: false, settled: true });
      }
      resolved.current = true;
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'TOKEN_REFRESHED' && session) {
          // Keep sb_at cookie fresh across token rotations (F-007)
          setSbAtCookie(session);
          return;
        }

        if (event === 'SIGNED_OUT') {
          setSbAtCookie(null);
          setState({ user: null, role: null, isAdmin: false, loading: false, settled: true });
          resolved.current = true;
          return;
        }

        if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
          await resolveSession(session);
        }
      }
    );

    // ROOT-CAUSE FIX (86e1mrwrx): on a warm reload the Supabase client can emit
    // INITIAL_SESSION synchronously from cached storage BEFORE this listener is
    // attached, so the event is missed and the app hangs on loading:true (blank
    // get-started page). Proactively fetch the current session so we resolve
    // regardless of event timing; the `resolved` guard prevents a race with a
    // real event.
    // Fail-safe resolver: settle to unauthenticated WITHOUT marking `resolved`, so a
    // late real session event can still correct the state. Used when getSession()
    // errors or never returns (e.g. an orphaned Supabase auth Web Lock — D-211
    // 2026-06-16, the true root of Blocker 1).
    const failSafeUnauthenticated = () => {
      // A real session already won — nothing to fail-safe.
      if (resolved.current) return;
      // Do NOT fail closed to /login if the shared cross-subdomain cookie still
      // holds a valid (non-expired) session. A slow or orphaned-lock getSession()
      // must not eject an authenticated contractor whose session is sitting in the
      // sb-otterquote-at/rt cookie — the D-212 session-precedence bug. Recover the
      // session from the cookie and resolve normally (role resolution still runs, so
      // this neither broadens access nor changes role gating) instead of declaring
      // the user logged-out.
      const cookieSession = readValidCookieSession();
      if (cookieSession) {
        void resolveSession(cookieSession as unknown as Session);
        return;
      }
      setState((prev) =>
        prev.settled
          ? prev
          : { user: null, role: null, isAdmin: false, loading: false, settled: true }
      );
    };

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        void resolveSession(session);
      })
      .catch(() => {
        // getSession() should not reject, but never leave the gate unresolved if it does.
        failSafeUnauthenticated();
      });

    // DEFENSE-IN-DEPTH: if neither the event nor getSession() has resolved within
    // 1.5s, lift the blank loading screen to the unauthenticated view. The
    // functional update only flips `loading` and does NOT set `resolved`, so a
    // late real session can still correct the state without a logged-out flash.
    const fallbackTimer = setTimeout(() => {
      setState((prev) =>
        prev.loading
          ? { user: null, role: null, isAdmin: false, loading: false, settled: false }
          : prev
      );
    }, 1500);

    // BACKSTOP (D-211 2026-06-16): never let an auth gate hang forever. If neither a
    // real event nor getSession() has definitively settled auth within this window
    // (e.g. an orphaned Supabase Web Lock froze getSession), resolve to
    // unauthenticated so gates fail safe to /login instead of spinning. `resolved`
    // stays false so a late real session still corrects the state.
    const settleSafetyTimer = setTimeout(failSafeUnauthenticated, 6000);

    return () => {
      clearTimeout(fallbackTimer);
      clearTimeout(settleSafetyTimer);
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    // SIGNED_OUT event above handles state + cookie reset
  };

  return (
    <AuthContext.Provider value={{ ...state, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
