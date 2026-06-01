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
import type { AuthContextValue, AuthState, AuthUser, OtterRole } from '../types/auth';

// ─── Admin allow-list (mirrors admin-auth-gate.ts) ───────────────────────────
const ADMIN_EMAILS: string[] = [
  'dustinstohler1@gmail.com',
  'dustin@otterquote.com',
];

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
        // Resolve role + admin in parallel
        const [role, isAdmin] = await Promise.all([
          resolveRole(session.user),
          resolveIsAdmin(session.user),
        ]);
        // A competing resolver may have won during the awaits above.
        if (resolved.current) return;
        setSbAtCookie(session);
        setState({
          user: session.user as unknown as AuthUser,
          role,
          isAdmin,
          loading: false,
        });
      } else {
        setSbAtCookie(null);
        setState({ user: null, role: null, isAdmin: false, loading: false });
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
          setState({ user: null, role: null, isAdmin: false, loading: false });
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
    supabase.auth.getSession().then(({ data: { session } }) => {
      void resolveSession(session);
    });

    // DEFENSE-IN-DEPTH: if neither the event nor getSession() has resolved within
    // 1.5s, lift the blank loading screen to the unauthenticated view. The
    // functional update only flips `loading` and does NOT set `resolved`, so a
    // late real session can still correct the state without a logged-out flash.
    const fallbackTimer = setTimeout(() => {
      setState((prev) =>
        prev.loading
          ? { user: null, role: null, isAdmin: false, loading: false }
          : prev
      );
    }, 1500);

    return () => {
      clearTimeout(fallbackTimer);
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
