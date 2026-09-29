/**
 * OtterQuote Edge Function: notify-partner-w9
 *
 * Sends a W-9 request email to a referral partner whose commission payment
 * has been blocked pending W-9 submission (D-172).
 *
 * Called internally by the apply_referral_commission() PostgreSQL trigger
 * via net.http_post (pg_net) — NOT called by browser clients.
 *
 * The trigger already stamps w9_notification_sent_at before calling this
 * function, so duplicate sends are impossible even if the function errors
 * and retries.
 *
 * Auth model: accepts the Supabase service role key as bearer token.
 * No user JWT (caller is a database trigger, not a browser).
 * Uses a service-role Supabase client to look up the agent by ID.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * D-172 / ClickUp: 86e0zrnbh (Mailgun email template)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { readW9GateFlag, shouldSkipW9Notification, skipResponseBody } from "./w9-gate.ts";
import { PARTNER_DASHBOARD_URL, w9RequestEmailHtml, w9RequestEmailText } from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

// CORS — origin-allowlisted per project standard (Session 254).
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

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth check ───────────────────────────────────────────────────────────
    // This function is called by a PostgreSQL trigger via pg_net using the
    // service role key. Verify the bearer token is the service role key.
    const authHeader = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!bearerToken || bearerToken !== serviceRoleKey) {
      console.error("notify-partner-w9: unauthorized call (bearer mismatch)");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Parse payload ────────────────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    const agentId = body?.agent_id as string | undefined;

    if (!agentId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: agent_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Load agent details ───────────────────────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // D-319 (gh-1509 half A): platform_settings.w9_gate_retired — flag OFF
    // (default; no row yet, this PR ships no seed/migration) sends exactly as
    // before. Flag ON no-ops with a logged skip — no email, no DB write.
    const w9GateRetired = await readW9GateFlag(
      async () => await sb.from("platform_settings").select("value").eq("key", "w9_gate_retired").maybeSingle(),
      (msg) => console.error(`notify-partner-w9: ${msg}`)
    );
    if (shouldSkipW9Notification(w9GateRetired)) {
      console.log(`notify-partner-w9: SKIPPED agent_id=${agentId} — w9_gate_retired flag is ON`);
      return new Response(
        JSON.stringify(skipResponseBody(agentId)),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: agent, error: agentErr } = await sb
      .from("referral_agents")
      // #596: this selected a `name` column that does not exist on
      // referral_agents (the schema has first_name / last_name). PostgREST
      // rejects the whole select, so this function returned 404 "Agent not
      // found" for EVERY call. It went unnoticed because the function has had
      // no live caller since the v49 trigger logic was rewritten.
      .select("id, first_name, last_name, email, payments_blocked, w9_notification_sent_at")
      .eq("id", agentId)
      .single();

    if (agentErr || !agent) {
      console.error("notify-partner-w9: agent not found", agentId, agentErr);
      return new Response(
        JSON.stringify({ error: "Agent not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!agent.email) {
      console.error("notify-partner-w9: agent has no email", agentId);
      return new Response(
        JSON.stringify({ error: "Agent has no email address on file" }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Build and send Mailgun email ─────────────────────────────────────────
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN  = Deno.env.get("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured");
    }

    // #596: read first_name directly — referral_agents stores the name split.
    const firstName = (agent.first_name || "").trim();

    const htmlBody = w9RequestEmailHtml(firstName);
    const plainText = w9RequestEmailText(firstName);

    const formData = new URLSearchParams();
    formData.append("from",    `Otter Quotes <notifications@${MAILGUN_DOMAIN}>`);
    formData.append("to",      agent.email);
    formData.append("subject", "Action required — submit your W-9 to receive your Otter Quotes referral payment");
    formData.append("text",    plainText);
    formData.append("html",    htmlBody);

    const mgRes = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}` },
        body: formData,
      }
    );

    if (!mgRes.ok) {
      const errText = await mgRes.text();
      console.error("notify-partner-w9: Mailgun error", mgRes.status, errText);
      throw new Error(`Mailgun API error (HTTP ${mgRes.status}): ${errText}`);
    }

    const mgResult = await mgRes.json();
    console.log(`notify-partner-w9: W-9 request sent to agent_id=${agentId} email=${agent.email} mailgun_id=${mgResult.id}`);

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgResult.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("notify-partner-w9 error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
