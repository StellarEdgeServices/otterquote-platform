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
 * Usage:
 *   POST /functions/v1/check-email-exists
 *   Body:     { "email": "someone@example.com" }
 *   Response: { "exists": boolean, "status": string | null }
 *
 * No JWT: this is called before any auth session exists (pre-magic-link,
 * pre-OAuth). verify_jwt is pinned to false in supabase/config.toml.
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

    return json({ exists: !!data, status: data?.status ?? null }, 200, corsHeaders);
  } catch (err) {
    console.error("[check-email-exists] lookup failed:", err);
    return json({ exists: false, status: null, degraded: true }, 200, corsHeaders);
  }
});
