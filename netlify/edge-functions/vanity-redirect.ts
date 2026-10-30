/**
 * vanity-redirect.ts -- Netlify Edge Function (P18, #3232)
 *
 * Partner short links: otterquote.com/<slug> -> 302 /ref/<unique_code>.
 *
 * Crediting is NOT reimplemented here. The redirect goes to the existing /ref/<code> edge function (ref-redirect.ts), which
 * sets the oq-ref / oq_pc attribution exactly as a regular partner link does, so a short link credits EXACTLY like /ref/<code>.
 *
 * Never shadows anything the site serves:
 *   - only single-segment paths whose segment matches the slug format are considered;
 *   - context.next() runs FIRST; the slug is looked up ONLY when that response is a 404 (so /faq, /login, every file and
 *     folder and every _redirects rule keep winning, and the lookup is never made for them);
 *   - registered LAST in netlify.toml for /*, after every other function.
 * On a match: 302 to /ref/<code> with the incoming query string kept (utm_* etc.), Cache-Control: no-store (a cached 302 would
 * keep sending visitors to an old partner after a slug changes hands). Anything else: the original 404 is passed through.
 * A lookup failure (network, timeout, bad body) also passes the 404 through; it never produces an error page.
 *
 * Supabase access: no secret and no Netlify env var. Like admin-auth-gate.ts, it calls PostgREST with the PUBLIC project URL and
 * publishable (anon) key, the same values shipped in js/config.js. The RPC public.resolve_partner_slug(p) is SECURITY DEFINER,
 * granted to anon, and returns only unique_code or null (supabase/migrations_drafts/p18_resolve_partner_slug.sql).
 */

// Public values, identical to js/config.js (SUPABASE_URL / SUPABASE_ANON) and admin-auth-gate.ts. Not secrets.
const SUPABASE_URL = 'https://yeszghaspzwwstvsrioa.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP';
const LOOKUP_TIMEOUT_MS = 2000;

// Same format the database enforces (3-30, lower-case letters/digits/single hyphens, not all digits); case-insensitive here
// because the RPC lower-cases.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/i;
// Only a well-formed code is placed in the Location header.
const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

export function isSlugCandidate(segment: string): boolean {
  return segment.length >= 3 && segment.length <= 30 && SLUG_RE.test(segment) && !/^[0-9]+$/.test(segment);
}

async function resolveSlug(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_partner_slug`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p: slug }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const code = await res.json();
    return typeof code === 'string' && SAFE_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

export default async (req: Request, context: any) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return context.next();

  const url = new URL(req.url);
  const match = url.pathname.match(/^\/([^/]+)\/?$/);
  if (!match) return context.next();
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]);
  } catch {
    return context.next();
  }
  if (!isSlugCandidate(segment)) return context.next();

  // Whatever the site serves wins. Only a 404 is a candidate short link.
  const res = await context.next();
  if (res.status !== 404) return res;

  const code = await resolveSlug(segment.toLowerCase());
  if (!code) return res;

  const dest = `${url.origin}/ref/${code}${url.search}`;
  return new Response(null, {
    status: 302,
    headers: { location: dest, 'cache-control': 'no-store' },
  });
};

// Registered in netlify.toml (last, for /*), not here: inline config would run before the toml-declared functions.
