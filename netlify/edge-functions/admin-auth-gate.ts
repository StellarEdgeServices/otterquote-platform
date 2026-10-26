/**
 * admin-auth-gate.ts — Netlify Edge Function (W4-P1)
 *
 * Intercepts all /admin-* requests (with or without .html or a trailing slash)
 * before the static file is served.
 * Reads the sb-otterquote-at cookie (set by OtterQuoteCookieStorage v2,
 * D-212 fix). Falls back to legacy sb_at cookie for in-flight admin sessions.
 * checks the token's shape and expiry locally (cheap pre-filter), then VERIFIES
 * it server-side with Supabase Auth (GET /auth/v1/user, the same call as
 * supabase.auth.getUser(token)) and checks:
 *   1. Token present and structurally valid
 *   2. Token not expired (exp claim)
 *   3. Supabase Auth accepts the token (signature, expiry, revocation)
 *   4. The server-side admin check public.is_admin_email() (admin_emails table,
 *      gh-3009 item 2: no email literals in this file) says the verified
 *      caller is an admin
 *
 * Security model (gh-3009, supersedes Option A of May 1, 2026):
 *   - Option A skipped signature verification to avoid shipping the JWT secret
 *     as a Netlify env var. Verifying through Supabase Auth needs only the
 *     public publishable key (already shipped in js/config.js), no secret.
 *   - A forged or tampered JWT is now rejected at the edge (fail closed on a
 *     non-200 from Supabase Auth or on a network error).
 *   - Defense layers: edge render gate (this) -> client-side JS check -> Supabase RLS
 *
 * Redirect target: /login.html?reason=admin_required
 * Pass-through: context.next() — Netlify serves the static HTML normally
 */

// Public values, identical to js/config.js (SUPABASE_URL / SUPABASE_ANON). The
// publishable key is not a secret; it only identifies the project to the API.
const SUPABASE_URL = 'https://yeszghaspzwwstvsrioa.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP';

const AUTH_TIMEOUT_MS = 3000;

// Asks Supabase Auth to verify the token. Returns the verified email, or null
// on any failure (bad signature, expired, revoked, network error, bad body).
async function verifiedEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      // gh-3009: a hung Supabase must not hang /admin. On timeout fetch rejects
      // (TimeoutError), the catch below returns null, and the gate redirects.
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.email === 'string' ? user.email : null;
  } catch {
    return null;
  }
}

// gh-3009 item 2: the admin allow-list lives in ONE place, the admin_emails table
// behind public.is_admin_email(). This asks that function, as the caller, whether
// the (already verified) token's email is an admin. PostgREST re-verifies the token
// signature and is_admin_email() reads the verified claim. Fail closed: anything
// other than HTTP 200 with a JSON `true` is "not admin".
// Trade-off: one extra Supabase round trip per /admin-* request (admin pages only,
// a handful of users). A Netlify env-var list would avoid it but would be a second
// copy of the allow-list to keep in sync, which is the bug this removes.
async function isAdminViaRpc(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_admin_email`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}

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

    // gh-3009: verify the signature via Supabase Auth; use ITS email, not the payload's.
    const email = await verifiedEmail(token);
    if (!email) return redirectToLogin();

    // Admin allow-list: single source is public.is_admin_email() (admin_emails table).
    if (!(await isAdminViaRpc(token))) {
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
