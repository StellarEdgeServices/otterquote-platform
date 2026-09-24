/**
 * OtterQuote Edge Function: notify-admin-new-partner
 *
 * Sends an admin notification email to Dustin whenever a new partner
 * (referral agent) signs up.
 *
 * Triggered by a PostgreSQL trigger (trg_notify_admin_new_partner) via
 * pg_net on INSERT to public.referral_agents. NOT called by browser
 * clients.
 *
 * Structural copy of notify-admin-new-contractor (see that function's own
 * index.ts) with two deliberate deviations, both documented at gh-2154 P-3:
 *
 *   1. Export shape: this module exports its handler
 *      (handleNotifyAdminNewPartner) and its dependencies as an injected
 *      PartnerDeps object, instead of notify-admin-new-contractor's fully
 *      inline serve() body. This mirrors send-home-profile-prompt/index.ts's
 *      ProcessClaimSupabase + injected-fetch convention and is what P-3's
 *      test (written first, per #2154 comment 5816579743) was written
 *      against.
 *   2. is_test handling (Ben, DECIDED bus 19:58:00Z): unlike
 *      notify-admin-new-contractor's isTestAccount(), which always silently
 *      skips, is_test=true partners here DO alert -- with a "[TEST] "
 *      subject prefix -- so Dustin still hears about his own test signups.
 *      Pattern-matched bot accounts (isTestAccount(): otterquote-internal.test
 *      / pfw- / authdoctor) that are NOT is_test still skip entirely. Order
 *      of checks: is_test is checked FIRST and wins -- a bot-pattern email
 *      with is_test=true alerts (with the [TEST] prefix), it does not skip.
 *
 * Auth model: accepts the Supabase service role key as bearer token (exact
 * match only, matching notify-admin-new-contractor -- no anon-key carve-out).
 * Idempotency: checks notifications table before sending — skips if
 * admin_new_partner_alert notification already sent for this partner.
 *
 * Never includes the raw fbclid value, or any secret/token, in the email.
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * gh-2154 P-3
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

export const ADMIN_EMAIL       = "dustinstohler1@gmail.com";
export const ADMIN_PORTAL_URL  = "https://otterquote.com/admin-partners.html";
export const NOTIFICATION_TYPE = "admin_new_partner_alert";

// CORS — origin-allowlisted per project standard (Session 254), matching
// notify-admin-new-contractor.
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

/** Same three bot-account patterns notify-admin-new-contractor matches. */
export function isTestAccount(email: string): boolean {
  const lower = (email || "").toLowerCase();
  return (
    lower.includes("otterquote-internal.test") ||
    lower.includes("pfw-") ||
    lower.includes("authdoctor")
  );
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PartnerRow {
  id: string;
  user_id: string | null;
  agent_type: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
  company: string | null;
  funnel_id: string | null;
  fbclid: string | null;
  is_test: boolean | null;
  created_at: string | null;
}

interface SupabaseQuery {
  select(cols: string): SupabaseQuery;
  eq(col: string, val: unknown): SupabaseQuery;
  limit(n: number): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
  single(): Promise<{ data: PartnerRow | null; error: { message: string } | null }>;
  insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
}

export interface PartnerSupabase {
  from(table: string): SupabaseQuery;
}

export interface PartnerDeps {
  serviceRoleKey: string;
  mailgunKey: string;
  mailgunDomain: string;
  supabase: PartnerSupabase;
  fetchImpl: typeof fetch;
}

function buildEmailHtml(
  isTest: boolean,
  fullName: string,
  agentType: string,
  email: string,
  company: string,
  funnelId: string,
  fbclidPresent: boolean,
  signupTs: string,
): string {
  const testBanner = isTest
    ? `<tr><td style="background:#FEF3C7;color:#92400E;padding:8px 24px;font-family:sans-serif;font-size:13px;font-weight:600;">TEST SIGNUP — not a real partner lead</td></tr>`
    : "";
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr>
          <td style="background:#0B1929;padding:20px 24px;">
            <h2 style="color:#F59E0B;margin:0;font-size:1.1rem;font-family:sans-serif;">
              🦦 New Partner Signup
            </h2>
          </td>
        </tr>
        ${testBanner}
        <!-- Body -->
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              A new partner has signed up.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">
              <tr>
                <td style="padding:8px 0;color:#64748B;width:130px;vertical-align:top;">Name</td>
                <td style="padding:8px 0;font-weight:600;">${escapeHtml(fullName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Agent type</td>
                <td style="padding:8px 0;">${escapeHtml(agentType)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Email</td>
                <td style="padding:8px 0;">
                  <a href="mailto:${escapeHtml(email)}" style="color:#0369A1;">${escapeHtml(email)}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Company</td>
                <td style="padding:8px 0;">${escapeHtml(company)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Funnel</td>
                <td style="padding:8px 0;">${escapeHtml(funnelId)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">fbclid</td>
                <td style="padding:8px 0;">${fbclidPresent ? "present" : "not present"}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Signed up</td>
                <td style="padding:8px 0;">${escapeHtml(signupTs)} CT</td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#F59E0B" style="border-radius:8px;">
                  <a href="${ADMIN_PORTAL_URL}"
                     style="display:inline-block;font-family:sans-serif;font-size:15px;font-weight:700;
                            color:#0B1929;text-decoration:none;padding:12px 24px;">
                    Review in Admin Portal &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td align="center"
              style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px;
                     font-family:sans-serif;font-size:12px;color:#94A3B8;">
            Otter Quotes &nbsp;|&nbsp;
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

// =============================================================================
// TESTABLE HANDLER
// =============================================================================

export async function handleNotifyAdminNewPartner(req: Request, deps: PartnerDeps): Promise<Response> {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader  = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!bearerToken || bearerToken !== deps.serviceRoleKey) {
      console.error("notify-admin-new-partner: unauthorized");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => null);
    const partnerId = (body as { partner_id?: string } | null)?.partner_id;
    if (!partnerId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: partner_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: partner, error: pErr } = await deps.supabase
      .from("referral_agents")
      .select("id, user_id, agent_type, first_name, last_name, email, company, funnel_id, fbclid, is_test, created_at")
      .eq("id", partnerId)
      .single();

    if (pErr || !partner) {
      console.error("notify-admin-new-partner: partner not found", partnerId, pErr);
      return new Response(
        JSON.stringify({ error: "Partner not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const email  = partner.email || "";
    const isTest = partner.is_test === true;

    // is_test is checked FIRST and wins: an is_test=true row always alerts
    // (with the [TEST] prefix below), even if its email also matches a bot
    // pattern. Only a NON-is_test row matching a bot pattern is skipped.
    if (!isTest && isTestAccount(email)) {
      console.log(`notify-admin-new-partner: skipping test account ${email}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "test_account" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: existing } = await deps.supabase
      .from("notifications")
      .select("id")
      .eq("user_id", partner.user_id)
      .eq("notification_type", NOTIFICATION_TYPE)
      .eq("channel", "email")
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`notify-admin-new-partner: already sent for partner_id=${partnerId}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_notified" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const fullName    = [partner.first_name, partner.last_name].filter(Boolean).join(" ") || "(unnamed partner)";
    const agentType   = partner.agent_type || "(unspecified)";
    const company     = partner.company || "(unnamed company)";
    const funnelId    = partner.funnel_id || "(none)";
    const fbclidPresent = Boolean(partner.fbclid);
    const signupTs = partner.created_at
      ? new Date(partner.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

    const subjectPrefix = isTest ? "[TEST] " : "";
    const subject  = `${subjectPrefix}🦦 New Partner Signup — ${fullName} (${agentType})`;
    const textBody = [
      isTest ? `TEST SIGNUP — not a real partner lead.` : null,
      isTest ? `` : null,
      `New partner signup on Otter Quotes.`,
      ``,
      `Name     : ${fullName}`,
      `Type     : ${agentType}`,
      `Email    : ${email}`,
      `Company  : ${company}`,
      `Funnel   : ${funnelId}`,
      `fbclid   : ${fbclidPresent ? "present" : "not present"}`,
      `Signed up: ${signupTs} CT`,
      ``,
      `Review in admin portal:`,
      ADMIN_PORTAL_URL,
    ].filter((l) => l !== null).join("\n");

    const htmlBody = buildEmailHtml(isTest, fullName, agentType, email, company, funnelId, fbclidPresent, signupTs);

    const formData = new FormData();
    formData.append("from",    `Otter Quotes <notifications@${deps.mailgunDomain}>`);
    formData.append("to",      ADMIN_EMAIL);
    formData.append("subject", subject);
    formData.append("text",    textBody);
    formData.append("html",    htmlBody);

    const mgRes = await deps.fetchImpl(
      `https://api.mailgun.net/v3/${deps.mailgunDomain}/messages`,
      {
        method:  "POST",
        headers: { Authorization: `Basic ${btoa(`api:${deps.mailgunKey}`)}` },
        body:    formData,
      },
    );

    if (!mgRes.ok) {
      const errText = await mgRes.text();
      console.error(`notify-admin-new-partner: Mailgun error ${mgRes.status}: ${errText}`);
      return new Response(
        JSON.stringify({ error: "Failed to send notification email" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const mgData = await mgRes.json();
    console.log(`notify-admin-new-partner: sent for partner_id=${partnerId} mailgun_id=${mgData.id}`);

    const { error: insertErr } = await deps.supabase.from("notifications").insert({
      user_id:          partner.user_id,
      claim_id:         null,
      channel:          "email",
      notification_type: NOTIFICATION_TYPE,
      recipient:        ADMIN_EMAIL,
      message_preview:  `New partner signup: ${fullName} (${email})`,
      sent_at:          new Date().toISOString(),
      delivered:        true,
      mailgun_id:       mgData.id,
    });

    if (insertErr) {
      // Non-fatal — email already sent, just log the warning
      console.warn(`notify-admin-new-partner: failed to log notification for partner_id=${partnerId}:`, insertErr);
    }

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("notify-admin-new-partner error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}

// =============================================================================
// MAIN HANDLER (wires real deps: Supabase client + Mailgun + global fetch)
// =============================================================================

// Guarded like send-home-profile-prompt/index.ts: `deno test` imports this
// module to reach handleNotifyAdminNewPartner, and import.meta.main is
// false in that case (only true when Deno actually runs this file as the
// entrypoint, i.e. in the deployed Edge Function), so serve() never binds a
// listener during tests.
if (import.meta.main) {
serve(async (req: Request) => {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabaseUrl    = Deno.env.get("SUPABASE_URL") || "";
  const mailgunKey     = Deno.env.get("MAILGUN_API_KEY") || "";
  const mailgunDomain  = Deno.env.get("MAILGUN_DOMAIN") || "";

  if (!serviceRoleKey || !supabaseUrl || !mailgunKey || !mailgunDomain) {
    console.error("notify-admin-new-partner: missing required environment variables");
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const sb = createClient(supabaseUrl, serviceRoleKey);

  return handleNotifyAdminNewPartner(req, {
    serviceRoleKey,
    mailgunKey,
    mailgunDomain,
    // deno-lint-ignore no-explicit-any
    supabase: sb as any,
    fetchImpl: fetch,
  });
});
}
