/**
 * OtterQuote Edge Function: notify-admin-new-contractor
 *
 * Sends an admin notification email to Dustin whenever a contractor signs up
 * and enters pending_approval status.
 *
 * Triggered by a PostgreSQL trigger (trg_notify_admin_new_contractor) via
 * pg_net on INSERT or UPDATE to contractors where status = 'pending_approval'.
 * NOT called by browser clients.
 *
 * Auth model: accepts the Supabase service role key as bearer token.
 * Idempotency: checks notifications table before sending — skips if
 * admin_new_contractor notification already sent for this contractor.
 *
 * Test account filter: skips emails matching:
 *   %otterquote-internal.test%  |  %pfw-%  |  %authdoctor%
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * ClickUp: 86e1nr89h
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { buildEmailHtml, buildEmailText, ADMIN_PORTAL_URL } from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

const ADMIN_EMAIL        = "dustinstohler1@gmail.com";
const NOTIFICATION_TYPE  = "admin_new_contractor";

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function isTestAccount(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    lower.includes("otterquote-internal.test") ||
    lower.includes("pfw-") ||
    lower.includes("authdoctor")
  );
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseUrl    = Deno.env.get("SUPABASE_URL") || "";
    const mailgunKey     = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain  = Deno.env.get("MAILGUN_DOMAIN") || "";

    if (!serviceRoleKey || !supabaseUrl || !mailgunKey || !mailgunDomain) {
      throw new Error("Missing required environment variables");
    }

    const authHeader  = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!bearerToken || bearerToken !== serviceRoleKey) {
      console.error("notify-admin-new-contractor: unauthorized");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => null);
    const contractorId = body?.contractor_id as string | undefined;
    if (!contractorId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: contractor_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: contractor, error: cErr } = await sb
      .from("contractors")
      .select("id, user_id, company_name, contact_name, email, status, created_at")
      .eq("id", contractorId)
      .single();

    if (cErr || !contractor) {
      console.error("notify-admin-new-contractor: contractor not found", contractorId, cErr);
      return new Response(
        JSON.stringify({ error: "Contractor not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const email = contractor.email || "";
    if (isTestAccount(email)) {
      console.log(`notify-admin-new-contractor: skipping test account ${email}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "test_account" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: existing } = await sb
      .from("notifications")
      .select("id")
      .eq("user_id", contractor.user_id)
      .eq("notification_type", NOTIFICATION_TYPE)
      .eq("channel", "email")
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`notify-admin-new-contractor: already sent for contractor_id=${contractorId}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_notified" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const companyName  = contractor.company_name || "(unnamed company)";
    const contactName  = contractor.contact_name || "(no contact name)";
    const signupTs     = contractor.created_at
      ? new Date(contractor.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

    const subject  = `🦦 New Contractor Signup — ${companyName} (pending review)`;
    const textBody = buildEmailText(companyName, contactName, email, signupTs);
    const htmlBody = buildEmailHtml(companyName, contactName, email, signupTs);

    const formData = new FormData();
    formData.append("from",    `Otter Quotes <notifications@${mailgunDomain}>`);
    formData.append("to",      ADMIN_EMAIL);
    formData.append("subject", subject);
    formData.append("text",    textBody);
    formData.append("html",    htmlBody);

    const mgRes = await fetch(
      `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
      {
        method:  "POST",
        headers: { Authorization: `Basic ${btoa(`api:${mailgunKey}`)}` },
        body:    formData,
      },
    );

    if (!mgRes.ok) {
      const errText = await mgRes.text();
      throw new Error(`Mailgun error ${mgRes.status}: ${errText}`);
    }

    const mgData = await mgRes.json();
    console.log(`notify-admin-new-contractor: sent for contractor_id=${contractorId} mailgun_id=${mgData.id}`);

    const { error: insertErr } = await sb.from("notifications").insert({
      user_id:          contractor.user_id,
      claim_id:         null,
      channel:          "email",
      notification_type: NOTIFICATION_TYPE,
      recipient:        ADMIN_EMAIL,
      message_preview:  `New contractor signup: ${companyName} (${email})`,
      sent_at:          new Date().toISOString(),
      delivered:        true,
      mailgun_id:       mgData.id,
    });

    if (insertErr) {
      // Non-fatal — email already sent, just log the warning
      console.warn(`notify-admin-new-contractor: failed to log notification for contractor_id=${contractorId}:`, insertErr);
    }

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("notify-admin-new-contractor error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
