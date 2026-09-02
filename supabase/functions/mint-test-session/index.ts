/**
 * Otter Quotes Edge Function: mint-test-session
 *
 * R-174 session minting for is_test accounts only (gh-1513). The Code lane
 * has no service-role key in its own env and no auth-admin MCP tool, so it
 * has no way to obtain a signed-in session for verifying `is_test` fixtures
 * end to end. This function is that permission (R-174, Dustin: "Yes
 * (Recommended)") turned into a mechanism, with the is_test gate enforced
 * inside the handler itself — never a caller-supplied flag.
 *
 * Input: exactly one of { "contractor_id": uuid } | { "user_id": uuid }.
 *   - contractor_id: 403 unless contractors.is_test is literally true.
 *     Mints for that contractor's linked auth user (contractors.user_id).
 *   - user_id (homeowner): 403 unless the user owns at least one claim AND
 *     every claim they own has is_test = true (claims.is_test).
 *
 * Mechanism: generates a Supabase magic link via the admin auth API
 * (auth.admin.generateLink) using the service-role key injected into every
 * Edge Function by the platform (SUPABASE_SERVICE_ROLE_KEY — never stored in
 * Doppler or the Code lane's own env). Writes a non-fatal activity_log row
 * (event_type: "test_session_minted") on success.
 *
 * Response: { ok, action_link, user_id, email, is_test: true, expires_in }.
 *
 * Caller gate: same admin single-address gate as admin-contractor-action
 * (JWT must resolve via auth.getUser to dustinstohler1@gmail.com). Unlike
 * admin-contractor-action, config.toml pins verify_jwt = true here per the
 * gh-1513 spec — defense in depth (gateway signature check + in-handler
 * allow-list) for a function whose entire purpose is minting sessions.
 *
 * The gate + response-shaping logic lives in ./gate.ts (resolveAndMint) so
 * it can be unit-tested against a fake DbAdapter without a live Supabase
 * client — see ./gate.test.ts.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type DbAdapter, resolveAndMint } from "./gate.ts";

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
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Get the JWT from Authorization header ──
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const token = authHeader.substring(7);

    // ── Initialize Supabase service-role client ──
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase credentials not configured");
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Caller gate: admin allow-list (same single-admin pattern as admin-contractor-action) ──
    const { data: callerData, error: callerError } = await supabase.auth.getUser(token);
    if (callerError || !callerData?.user || callerData.user.email !== "dustinstohler1@gmail.com") {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));

    const db: DbAdapter = {
      async getContractorById(id) {
        const { data, error } = await supabase
          .from("contractors")
          .select("id, user_id, email, is_test")
          .eq("id", id)
          .maybeSingle();
        return { data, error: error ? { message: error.message } : null };
      },
      async getClaimsByUserId(userId) {
        const { data, error } = await supabase
          .from("claims")
          .select("id, is_test")
          .eq("user_id", userId);
        return { data, error: error ? { message: error.message } : null };
      },
      async getAuthUserById(userId) {
        const { data, error } = await supabase.auth.admin.getUserById(userId);
        return {
          data: data?.user ? { id: data.user.id, email: data.user.email ?? null } : null,
          error: error ? { message: error.message } : null,
        };
      },
      async generateMagicLink(email) {
        const { data, error } = await supabase.auth.admin.generateLink({
          type: "magiclink",
          email,
        });
        const actionLink = data?.properties?.action_link;
        return {
          data: actionLink ? { action_link: actionLink } : null,
          error: error ? { message: error.message } : null,
        };
      },
      async insertActivityLog(row) {
        const { error } = await supabase.from("activity_log").insert({
          ...row,
          created_at: new Date().toISOString(),
        });
        return { error: error ? { message: error.message } : null };
      },
    };

    const result = await resolveAndMint(body, db, callerData.user.email);

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("mint-test-session error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
