/**
 * Next.js Middleware — D-211 Admin Auth Gate
 *
 * Protects /admin/* routes in the React app.
 * Mirrors admin-auth-gate.ts (Netlify edge function) as fixed by gh-3009/PR #3040:
 *   - gh-3048: the JWT is VERIFIED through Supabase Auth (GET /auth/v1/user, the
 *     same call as supabase.auth.getUser(token)) and admin status is decided
 *     for the VERIFIED email, never the unverified payload. Needs only the
 *     public publishable key, no secret. Fails closed on any error.
 *   - Reads sb_at cookie set by AuthProvider._setSingleAuthCookie, falling back
 *     to the canonical sb-otterquote-at cookie written by cookie-storage.ts
 *   - Verifies: token present + structurally valid + not expired (cheap pre-filter)
 *     + Supabase Auth accepts it + is_admin_email() (server-side) returns true for the caller
 *
 * NOTE: Uses atob() (not Buffer) — Next.js middleware runs in the Edge runtime
 * which does not have Node.js Buffer. atob() is available in all Edge environments.
 *
 * gh-3077: there is no email list in this file. After the token is verified, the caller's own
 * JWT is sent to the SQL function public.is_admin_email() (PostgREST RPC), the single source
 * of truth for who is an admin (same call as supabase/functions/_shared/admin-gate.ts
 * requireAdmin). Anything other than a literal `true` denies (fail closed).
 * REDIRECT: /get-started (React unauthenticated landing)
 */

import { NextRequest, NextResponse } from 'next/server';
import { firstTouchSetCookie } from './app/lib/attribution-core';

// Public values (same as js/config.js and the NEXT_PUBLIC_* build env); the
// publishable key is not a secret. Fallbacks mirror PR #3040.
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://yeszghaspzwwstvsrioa.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP';

// Returns the verified email, or null on any failure (bad signature, expired,
// revoked, network error, bad body).
async function verifiedEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.email === 'string' ? user.email : null;
  } catch {
    return null;
  }
}

// gh-3077: asks the database whether THIS caller is an admin, using the caller's JWT so
// auth.jwt() inside public.is_admin_email() is theirs. True only for a literal `true`;
// any error, non-200 or other body denies.
async function isAdminCaller(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_admin_email`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // gh-1983: non-admin routes in the matcher only get the first-touch ad
  // attribution cookie (oq_ft, Domain=.otterquote.com, 90 d), set server-side
  // on the first page navigation (tagged utm_* / fbclid / gclid or not, gh-3002) when none is stored yet. A
  // server-set cookie is not subject to Safari ITP's 7-day cap on script-set
  // cookies, and exists before any JS runs (Facebook in-app browser included).
  if (!pathname.startsWith('/admin')) {
    const res = NextResponse.next();
    try {
      const setCookie = firstTouchSetCookie(
        request.url,
        request.headers.get('cookie'),
        request.headers.get('referer'),
        new Date(),
        {
          accept: request.headers.get('accept'),
          gpc: request.headers.get('sec-gpc'),
          purpose: request.headers.get('sec-purpose') || request.headers.get('purpose'),
          userAgent: request.headers.get('user-agent'),
        },
      );
      if (setCookie) res.headers.append('Set-Cookie', setCookie);
    } catch {
      // Attribution must never break a page load.
    }
    return res;
  }

  // Dual-read: AuthProvider sets sb_at, but the canonical D-212 cross-subdomain
  // cookie written by cookie-storage.ts is sb-otterquote-at. Accept either so a
  // session that arrived via SSO (or before AuthProvider synced sb_at) still
  // passes the gate. Both hold the raw access JWT.
  const token =
    request.cookies.get('sb_at')?.value ??
    request.cookies.get('sb-otterquote-at')?.value;

  const redirectToLogin = () =>
    NextResponse.redirect(new URL('/get-started', request.url));

  if (!token) return redirectToLogin();

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return redirectToLogin();

    // Base64url → JSON (atob — Edge runtime safe, mirrors admin-auth-gate.ts)
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(padded)) as { exp?: number; email?: string };

    // Expired?
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return redirectToLogin();
    }

    // gh-3048: verify the token (signature, revocation) via Supabase Auth.
    const email = await verifiedEmail(token);
    if (!email) return redirectToLogin();

    // gh-3077: admin set = whatever public.is_admin_email() accepts for this caller.
    if (!(await isAdminCaller(token))) {
      return redirectToLogin();
    }

    return NextResponse.next();
  } catch {
    return redirectToLogin();
  }
}

export const config = {
  // gh-1983: '/', '/get-started' (and sub-paths) are the paid-ad landing
  // routes; every other route still gets the client-side capture fallback.
  matcher: ['/admin/:path*', '/', '/get-started', '/get-started/:path*'],
};
