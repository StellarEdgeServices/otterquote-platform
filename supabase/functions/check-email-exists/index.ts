/**
 * OtterQuote Edge Function: check-email-exists
 *
 * gh-1544: contractor signup did not detect an existing application by
 * email before writing a new `contractors` row. Stohler Roofing ended up
 * with two rows for the same email (8e90ff23 created 2026-07-20, ee452a12
 * created 2026-07-24) because contractor-join.html offers two independent
 * sign-in paths — magic-link/OTP and Google OAuth — and Supabase mints a
 * distinct auth user (and therefore a distinct `contractors.user_id`) per
 * identity/provider. The existing per-user_id lookup on
 * contractor-pre-approval.html only ever catches a duplicate for the SAME
 * auth user; it cannot see a second identity created via the other path.
 *
 * `contractors` RLS scopes SELECT to `user_id = auth.uid()` (plus an
 * admin-email carve-out), so neither an anonymous pre-signup client nor an
 * authenticated-but-different-user client can look this up itself. This
 * function runs the lookup with the service role and returns only the
 * minimum needed to gate the signup UI — never the row itself.
 *
 * gh-1724 [SECURITY]: `status` used to be returned to every caller
 * regardless of who was asking, which made this endpoint both an
 * unauthenticated account-enumeration oracle (anyone can probe any address
 * for `exists`) AND a pipeline-stage leak (anyone could also read the
 * contractor's application `status`) — a competitor with a list of roofing-
 * company addresses could learn membership *and* stage. Two callers use
 * this function and they are NOT equivalent:
 *   - contractor-join.html: calls BEFORE any auth session exists
 *     (pre-magic-link, pre-OAuth). This caller must stay anonymous-safe.
 *   - contractor-pre-approval.html: calls AFTER the caller has already
 *     signed in (magic-link/OAuth completed), asking about THEIR OWN
 *     account (`currentUser.email`) to render the "Application Already
 *     Exists (status: ...)" panel. That status disclosure is legitimate —
 *     the caller is looking up themselves, not a third party — and
 *     removing it entirely would have broken that panel's copy
 *     (verified: `git grep -n "dup.status\|dupRace.*\.status" contractor-pre-approval.html`
 *     finds three live call sites feeding `.status` into
 *     `showDuplicateApplicationPanel()`; this endpoint is NOT status-free
 *     for every consumer, contrary to an earlier read of this issue).
 *
 * Fix: `status` is now included in the response ONLY when the caller
 * presents a valid Supabase user JWT (in the `Authorization: Bearer`
 * header — supabase-js attaches the current session's access token to
 * `functions.invoke()` automatically when one exists, so the already-
 * authenticated pre-approval flow needs no front-end change) whose OWN
 * verified email matches the email being looked up. Any other caller —
 * anonymous (no token, or the anon key, which is what supabase-js sends
 * when there is no session), a caller not signed in as the looked-up
 * address, or an invalid/expired token — gets `{ exists: boolean }` only,
 * same shape on hit and miss. This is the manual-JWT-check-despite-
 * verify_jwt=false pattern already used by resend-hover-link/index.ts.
 *
 * Residual, stated honestly (see gh-1724 acceptance criteria): this closes
 * the `status`/stage leak and the third-party self-check leak entirely,
 * but the `exists` boolean itself is still an oracle for any caller,
 * anonymous or not — an unauthenticated `curl` still learns whether an
 * address has an account. Volume is what step 2 (per-IP rate limiting)
 * would address; it is not done here (see PR description / issue comment
 * for why: check_rate_limit() denies by default when no rate_limit_config
 * row exists for a function — see create-docusign-envelope/index.ts:2477-86
 * — "That default has produced this exact outage four times now" — and
 * this issue's own file scope does not include a migration to add one).
 *
 * Usage:
 *   POST /functions/v1/check-email-exists
 *   Body:     { "email": "someone@example.com" }
 *   Response: { "exists": boolean }
 *             { "exists": boolean, "status": string | null }  -- only when
 *               the caller's own verified session email matches the email
 *               being checked.
 *
 * No JWT required to call this at all: it is called before any auth
 * session exists on the join page (pre-magic-link, pre-OAuth), so
 * verify_jwt stays pinned to false in supabase/config.toml — but a JWT, if
 * present and valid, is now used to gate the `status` field above.
 *
 * Fails OPEN (`exists: false`) on any lookup error — a transient DB/EF
 * failure must never trap a legitimate new applicant. The signup write
 * path (contractor-pre-approval.html) re-checks before inserting, so a
 * false negative here is not the only guard.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Escape Postgres LIKE/ILIKE wildcard characters so an email containing a
// literal "%" or "_" can't turn this into a pattern match against other
// addresses.
function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

// gh-1724: the decision of whether to disclose `status` in the response.
// Pulled out as a pure function (no Supabase call, no request object) so it
// is unit-testable in isolation from the auth.getUser() network call and the
// DB lookup -- this is the security-critical branch in this file, so it is
// the one most worth testing directly rather than only via the handler.
// `false` on any doubt (no caller email, an auth error, a mismatched
// email) -- the anonymous-safe shape is always the default.
function computeSelfCheck(
  requestedEmail: string,
  callerEmail: string | null | undefined,
  authErr: unknown,
): boolean {
  if (authErr || !callerEmail) return false;
  return callerEmail.toLowerCase() === requestedEmail.toLowerCase();
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  let email = "";
  try {
    const body = await req.json();
    email = String(body?.email || "").trim();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: "Missing or invalid email" }, 400, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const sb = createClient(supabaseUrl, serviceRoleKey);

  // gh-1724: gate the `status` field on the caller proving (via a valid
  // Supabase user JWT) that they ARE the email address being looked up.
  // No token, an anon-key token, a token for a different user, or an
  // invalid/expired token all fall through to `selfCheck = false` — the
  // anonymous-safe shape. This never rejects the request; a failed/absent
  // auth check only narrows the response, matching the fail-OPEN posture
  // of the rest of this function (a broken auth check must not block a
  // legitimate new applicant from getting their `exists` boolean).
  let selfCheck = false;
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    try {
      const { data: { user: caller }, error: authErr } = await sb.auth.getUser(token);
      selfCheck = computeSelfCheck(email, caller?.email, authErr);
    } catch (authCheckErr) {
      console.warn("[check-email-exists] auth check failed, treating as anonymous:", authCheckErr);
    }
  }

  try {
    // Case-insensitive match against the stored email (issue text: "look up
    // contractors by lower-cased email"). Deliberately NOT filtered by
    // is_test — the seeded E2E contractor fixture (is_test=true) must trip
    // this gate the same way a real duplicate would (contractor-journey.spec
    // A1b asserts exactly that), and a real applicant sharing an email with
    // a stray test row should still be caught.
    const { data, error } = await sb
      .from("contractors")
      .select("status")
      .ilike("email", escapeIlike(email))
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    const responseBody: Record<string, unknown> = { exists: !!data };
    if (selfCheck) responseBody.status = data?.status ?? null;
    return json(responseBody, 200, corsHeaders);
  } catch (err) {
    console.error("[check-email-exists] lookup failed:", err);
    const responseBody: Record<string, unknown> = { exists: false, degraded: true };
    if (selfCheck) responseBody.status = null;
    return json(responseBody, 200, corsHeaders);
  }
});
