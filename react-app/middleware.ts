/**
 * Next.js Middleware — D-211 Admin Auth Gate
 *
 * Protects /admin/* routes in the React app.
 * Mirrors the security model of admin-auth-gate.ts (Netlify edge function):
 *   - No JWT signature verification (Supabase RLS is the real data gate)
 *   - Reads sb_at cookie set by AuthProvider._setSingleAuthCookie, falling back
 *     to the canonical sb-otterquote-at cookie written by cookie-storage.ts
 *   - Verifies: token present + structurally valid + not expired + email in allowlist
 *
 * NOTE: Uses atob() (not Buffer) — Next.js middleware runs in the Edge runtime
 * which does not have Node.js Buffer. atob() is available in all Edge environments.
 *
 * ADMIN EMAILS: dustinstohler1@gmail.com, dustin@otterquote.com
 * REDIRECT: /get-started (React unauthenticated landing)
 */

import { NextRequest, NextResponse } from 'next/server';
import { firstTouchSetCookie } from './app/lib/attribution-core';

const ADMIN_EMAILS = ['dustinstohler1@gmail.com', 'dustin@otterquote.com'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // gh-1983: non-admin routes in the matcher only get the first-touch ad
  // attribution cookie (oq_ft, Domain=.otterquote.com, 90 d), set server-side
  // on a tagged landing (utm_* / fbclid / gclid) when none is stored yet. A
  // server-set cookie is not subject to Safari ITP's 7-day cap on script-set
  // cookies, and exists before any JS runs (Facebook in-app browser included).
  if (!pathname.startsWith('/admin')) {
    const res = NextResponse.next();
    try {
      const setCookie = firstTouchSetCookie(
        request.url,
        request.headers.get('cookie'),
        request.headers.get('referer'),
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

    // Admin allow-list
    if (!payload.email || !ADMIN_EMAILS.includes(payload.email)) {
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
