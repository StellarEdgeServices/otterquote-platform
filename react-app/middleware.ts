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

const ADMIN_EMAILS = ['dustinstohler1@gmail.com', 'dustin@otterquote.com'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only gate /admin/* routes
  if (!pathname.startsWith('/admin')) {
    return NextResponse.next();
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
  matcher: ['/admin/:path*'],
};
