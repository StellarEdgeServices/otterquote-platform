/**
 * admin-auth-gate.ts — Netlify Edge Function (W4-P1)
 *
 * Intercepts all /admin-* requests (with or without .html or a trailing slash)
 * before the static file is served.
 * Reads the sb-otterquote-at cookie (set by OtterQuoteCookieStorage v2,
 * D-212 fix). Falls back to legacy sb_at cookie for in-flight admin sessions.
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

  // D-225 fix May 13, 2026: D-212 cookie chunking renamed the access-token cookie
  // from `sb_at` to `sb-otterquote-at`. Read the new name first, fall back to the
  // legacy name during migration so any pre-D-212 admin sessions keep working.
  const cookieHeader = req.headers.get('cookie') || '';
  const newMatch = cookieHeader.match(/(?:^|;\s*)sb-otterquote-at=([^;]+)/);
  const legacyMatch = cookieHeader.match(/(?:^|;\s*)sb_at=([^;]+)/);
  const token = newMatch?.[1] || legacyMatch?.[1];

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

// gh-1598 (2026-09-05): was '/admin-*.html' only — '/admin-dashboard' (extensionless,
// and the target of the '/Admin-Dashboard.html' / '/admin-dashboard/' 301s) bypassed
// the gate. A `path` glob is case-sensitive (measured on deploy-preview-1684:
// '/Admin-Dashboard.html' fell through to Pretty URLs' 301), so this is a regex
// `pattern`: any case of 'admin-' at the root, with or without '.html' or a
// trailing slash. The service worker and manifest are public static assets with
// no admin data and the manifest is fetched without cookies, so they stay outside.
export const config = {
  pattern: '^/[Aa][Dd][Mm][Ii][Nn]-.*$',
  excludedPattern: ['^/admin-sw\\.js$', '^/admin-app\\.webmanifest$'],
};
