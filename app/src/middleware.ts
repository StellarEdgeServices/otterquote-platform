import { NextRequest, NextResponse } from 'next/server';

/**
 * Decodes JWT payload (base64) without crypto.
 * Returns the decoded payload object or null if invalid.
 */
function decodeJWT(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect /admin/* routes
  if (pathname.startsWith('/admin/')) {
    // Read sb_at cookie (NOT sq_at — sq_at is deprecated as of D-211)
    const sbAtCookie = request.cookies.get('sb-yeszghaspzwwstvsrioa-auth-token')?.value;

    if (!sbAtCookie) {
      // No session token — redirect to login
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('reason', 'admin_required');
      return NextResponse.redirect(loginUrl);
    }

    // Decode JWT to check admin email
    const payload = decodeJWT(sbAtCookie);
    if (!payload || !payload.email) {
      // Invalid token — redirect to login
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('reason', 'admin_required');
      return NextResponse.redirect(loginUrl);
    }

    // Check if token is expired
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      // Token expired — redirect to login
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('reason', 'session_expired');
      return NextResponse.redirect(loginUrl);
    }

    // Check admin allowlist
    const adminAllowlist = ['dustinstohler1@gmail.com'];
    if (!adminAllowlist.includes(payload.email)) {
      // Not in admin allowlist — redirect to home
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = '/';
      return NextResponse.redirect(homeUrl);
    }

    // Admin verified — pass through
    return NextResponse.next();
  }

  // All other paths pass through
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
