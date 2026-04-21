/**
 * OtterQuote Edge Function: submit-partner-w9
 *
 * Accepts a W-9 PDF upload from an authenticated referral partner,
 * stores it in the partner-photos bucket (prefix: w9/{user_id}/),
 * and clears the payments_blocked flag on the partner's referral_agents row.
 *
 * Auth: partner JWT required. Caller must have a referral_agents row
 *       matching their auth.uid().
 *
 * Input: multipart/form-data with field "w9_file" (PDF, max 5 MB).
 *
 * Storage: partner-photos bucket — w9/{user_id}/{unix_ms}.pdf
 *   (private bucket; admin views W-9 via signed URL)
 *
 * DB writes on success:
 *   referral_agents.w9_file_url      = storage path
 *   referral_agents.w9_submitted_at  = NOW()
 *   referral_agents.payments_blocked = false
 *
 * Rate limit: 10/day, 30/month (row added by v49 migration).
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY (not used server-side — anon key is public)
 *
 * D-172 / ClickUp: 86e0zrnb6 (submit-partner-w9 Edge Function)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// CORS — origin-allowlisted per project standard (Session 254).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
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

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // ── JWT verification (in-handler, per --no-verify-jwt deploy flag) ───────
    const supabaseUrl     = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey         = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Use caller's JWT to verify identity (anon key + forwarded auth header).
    const sbUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const { data: { user }, error: userErr } = await sbUser.auth.getUser();
    if (userErr || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized — valid partner session required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Rate limit check ─────────────────────────────────────────────────────
    const sbAdmin = createClient(supabaseUrl, serviceRoleKey);
    const { data: rateLimitOk, error: rlErr } = await sbAdmin.rpc("check_rate_limit", {
      p_function_name: "submit-partner-w9",
      p_user_id: user.id,
    });
    if (rlErr) {
      console.error("submit-partner-w9: rate limit check error", rlErr);
      // Fail closed
      return new Response(
        JSON.stringify({ error: "Rate limit check failed — please try again later" }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!rateLimitOk) {
      return new Response(
        JSON.stringify({ error: "Upload limit reached for today — please try again tomorrow" }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Verify caller is a referral partner ──────────────────────────────────
    const { data: agent, error: agentErr } = await sbAdmin
      .from("referral_agents")
      .select("id, user_id, payments_blocked")
      .eq("user_id", user.id)
      .single();

    if (agentErr || !agent) {
      return new Response(
        JSON.stringify({ error: "No partner account found for this user" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Parse multipart form ─────────────────────────────────────────────────
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data")) {
      return new Response(
        JSON.stringify({ error: "Request must be multipart/form-data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return new Response(
        JSON.stringify({ error: "Failed to parse multipart form data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const w9File = formData.get("w9_file");
    if (!w9File || !(w9File instanceof File)) {
      return new Response(
        JSON.stringify({ error: "Missing required file field: w9_file" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Validate file type ───────────────────────────────────────────────────
    const fileType = w9File.type || "";
    if (!fileType.startsWith("application/pdf")) {
      return new Response(
        JSON.stringify({ error: "W-9 must be a PDF file (application/pdf)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Validate file size ───────────────────────────────────────────────────
    const fileBytes = await w9File.arrayBuffer();
    if (fileBytes.byteLength > MAX_FILE_SIZE_BYTES) {
      return new Response(
        JSON.stringify({ error: "File too large — maximum W-9 size is 5 MB" }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Upload to partner-photos bucket ──────────────────────────────────────
    // Path: w9/{user_id}/{timestamp_ms}.pdf
    const timestamp  = Date.now();
    const storagePath = `w9/${user.id}/${timestamp}.pdf`;

    const { error: uploadErr } = await sbAdmin.storage
      .from("partner-photos")
      .upload(storagePath, fileBytes, {
        contentType: "application/pdf",
        upsert: true,   // allow re-upload (partner correcting a bad submission)
      });

    if (uploadErr) {
      console.error("submit-partner-w9: storage upload error", uploadErr);
      throw new Error(`Storage upload failed: ${uploadErr.message}`);
    }

    // ── Update referral_agents ───────────────────────────────────────────────
    const { error: updateErr } = await sbAdmin
      .from("referral_agents")
      .update({
        w9_file_url:      storagePath,
        w9_submitted_at:  new Date().toISOString(),
        payments_blocked: false,
      })
      .eq("id", agent.id);

    if (updateErr) {
      console.error("submit-partner-w9: DB update error", updateErr);
      // Don't leave an orphaned file — attempt to clean up, but don't fail hard
      await sbAdmin.storage.from("partner-photos").remove([storagePath]).catch(() => {});
      throw new Error(`Database update failed: ${updateErr.message}`);
    }

    console.log(`submit-partner-w9: W-9 submitted for agent_id=${agent.id} user_id=${user.id} path=${storagePath}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "W-9 submitted successfully. Your payment will be processed once verified.",
        w9_file_url: storagePath,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("submit-partner-w9 error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "An unexpected error occurred" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
