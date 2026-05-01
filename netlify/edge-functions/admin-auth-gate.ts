/**
 * admin-auth-gate.ts — Netlify Edge Function (W4-P1)
 *
 * Intercepts all /admin-*.html requests before the static file is served.
 * Reads the sq_at cookie (set by Auth._syncAdminCookie in js/auth.js),
 * decodes the Supabase JWT payload, and verifies:
 *   1. Token present and structurally valid
 *   2. Token not expired (exp claim)
 *   3. Email in the admin allow-list
 *
 * Security model (Option A — agreed May 1, 2026):
 *   - No signature verification at the edge (avoids needing JWT secret as Netlify env var)
 *   - A crafted JWT that passes email/exp checks still cannot read data:
 *     Supabase RLS requires a valid signed session → data gate remains intact
 *   - Defense layers: edge render gate (this) → client-side JS check → Supabase RLS
 *
 * Redirect target: /login.html?reason=admin_required
 * Pass-through: context.next() — Netlify serves the static HTML normally
 */

export default async (req: Request, context: any) => {
  const url = new URL(req.url);

  // Parse sq_at from Cookie header
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)sq_at=([^;]+)/);
  const token = match?.[1];

  const redirectToLogin = () =>
    Response.redirect(`${url.origin}/login.html?reason=admin_required`, 302);

  if (!token) return redirectToLogin();

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return redirectToLogin();

    // Base64url → base64 → JSON
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(padded));

    // Check expiry
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return redirectToLogin();
    }

    // Admin allow-list
    const ADMIN_EMAILS: string[] = [
      'dustinstohler1@gmail.com',
      'dustin@otterquote.com',
    ];
    if (!ADMIN_EMAILS.includes(payload.email)) {
      return redirectToLogin();
    }

    // All checks passed — serve the page
    return context.next();
  } catch {
    // Any parse error → redirect (fail closed)
    return redirectToLogin();
  }
};

export const config = { path: '/admin-*.html' };
