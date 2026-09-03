/**
 * OtterQuote Edge Function: send-measurement-ready (gh-1412)
 *
 * Homeowner completion notification for the MANUAL measurement-fulfilment
 * loop (D-317 cl. 7). Called by admin-measurements.html (with the admin's own
 * JWT — same caller-token admin gate as approve-warranty-drift) right after
 * the fulfil action moves a hover_orders row to status 'completed'.
 *
 * Does two things, in this order:
 *   1. Writes the 'measurement_order_fulfilled' activity_log row — the CTO's
 *      #1412 ruling put the log ahead of the email: "the log row is the record
 *      that makes the order findable, auditable, and reportable."
 *   2. Emails the homeowner that their report is ready, pointing at the
 *      dashboard where the measurements now live.
 *
 * The email NEVER links or attaches the vendor PDF. Per #1339 / D-317 cl. 7
 * the vendor PDF is stored on the claim for internal records only and is
 * never served to a contractor or homeowner; what the homeowner "sees" is the
 * measurement numbers mirrored onto claims.hover_measurements, which every
 * existing surface (dashboard, bid form) already renders.
 *
 * Contractor-requested orders (requested_by_role='contractor') are skipped —
 * notifying the requesting contractor is #1411's upgrade-path substrate, and
 * emailing the claim's homeowner about a report they did not order would be
 * wrong. Skips are explicit in the response, never silent.
 *
 * Idempotent per order (notifications type 'measurement_ready' with the order
 * id in message_preview), so re-saving via the queue's Edit button cannot
 * re-email the homeowner. Test traffic (claims.is_test or test-pattern buyer
 * emails) logs but does not email.
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { logNotificationFailure } from "./notification-failure.ts";

const FUNCTION_NAME = "send-measurement-ready";
const NOTIFICATION_TYPE = "measurement_ready";
const DASHBOARD_URL = "https://otterquote.com/dashboard.html";
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts PRIMARY_ADMIN_EMAIL —
// do not edit without updating that file too (deploy path does not resolve imports).
// This function has only ever gated on the single primary email (plus the DB
// template_review_role fallback below), not the full ADMIN_EMAILS allow-list —
// do not widen the email fast-path without an explicit decision (see gh-1534).
const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

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

function json(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Same test-account patterns as notify-admin-new-contractor.
function isTestAccount(email: string): boolean {
  const lower = email.toLowerCase();
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

interface Product {
  label?: string;
}

function buildEmailHtml(args: {
  firstName: string;
  productLabel: string;
  address: string;
}): string {
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
              🦦 Your measurement report is ready
            </h2>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
              Hi ${escapeHtml(args.firstName)},
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
              Good news — the ${escapeHtml(args.productLabel)} you ordered for
              <strong>${escapeHtml(args.address)}</strong> is ready.
            </p>
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              The measurements are now on your project, and contractors bidding your job
              can use them right away. You can review everything from your dashboard.
            </p>
            <table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
              <tr>
                <td align="center" bgcolor="#E07B00" style="border-radius:8px;">
                  <a href="${DASHBOARD_URL}"
                     style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;
                            color:#ffffff;text-decoration:none;padding:14px 28px;">
                    View your project
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:13px;color:#64748B;line-height:1.6;">
              Questions? Just reply to this email or write to
              <a href="mailto:support@otterquote.com" style="color:#0EA5E9;">support@otterquote.com</a>.
            </p>
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

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, corsHeaders);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const mailgunKey = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN") || "";
    if (!supabaseUrl || !serviceRoleKey || !mailgunKey || !mailgunDomain) {
      throw new Error("Missing required environment variables");
    }

    // ── Admin gate (approve-warranty-drift pattern) ──────────────────────
    // Caller must present their own JWT; the caller must be the primary admin
    // address or a contractor row flagged template_review_role='admin' — the
    // same test admin-measurements.html itself applies before showing the queue.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }
    const userClient = createClient(supabaseUrl, anonKey || serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);

    let isAdmin = user.email === PRIMARY_ADMIN_EMAIL;
    if (!isAdmin) {
      const { data: adminRow } = await sb
        .from("contractors")
        .select("template_review_role")
        .eq("user_id", user.id)
        .maybeSingle();
      isAdmin = adminRow?.template_review_role === "admin";
    }
    if (!isAdmin) {
      return json({ error: "Forbidden: admin role required" }, 403, corsHeaders);
    }

    const body = await req.json().catch(() => null);
    const orderId = body?.order_id as string | undefined;
    if (!orderId) {
      return json({ error: "Missing required field: order_id" }, 400, corsHeaders);
    }

    // ── Load the order; it must actually be delivered ────────────────────
    const { data: order, error: oErr } = await sb
      .from("hover_orders")
      .select("id, claim_id, user_id, status, product_code, requested_by_role, fulfilled_at, fulfilled_by, report_url")
      .eq("id", orderId)
      .single();
    if (oErr || !order) {
      return json({ error: "Order not found" }, 404, corsHeaders);
    }
    if (order.status !== "completed") {
      return json(
        { error: `Order is not delivered (status: ${order.status}). Fulfil it first.` },
        409,
        corsHeaders,
      );
    }

    const { data: claim } = await sb
      .from("claims")
      .select("id, user_id, property_address, is_test")
      .eq("id", order.claim_id)
      .maybeSingle();
    const isTestClaim = claim?.is_test === true;

    // ── 1. Activity log FIRST (idempotent per order) ─────────────────────
    // The record outlives the email: even where the email is skipped (test
    // traffic, contractor-requested orders), the fulfilment is on the books.
    const { data: priorLog } = await sb
      .from("activity_log")
      .select("id")
      .eq("event_type", "measurement_order_fulfilled")
      .contains("metadata", { order_id: order.id })
      .limit(1);
    if (!priorLog || priorLog.length === 0) {
      const { error: logErr } = await sb.from("activity_log").insert({
        event_type: "measurement_order_fulfilled",
        title: "measurement_order_fulfilled",
        user_id: order.user_id,
        is_test: isTestClaim,
        metadata: {
          order_id: order.id,
          claim_id: order.claim_id,
          product_code: order.product_code,
          requested_by_role: order.requested_by_role,
          fulfilled_at: order.fulfilled_at,
          fulfilled_by: order.fulfilled_by,
          report_uploaded: !!order.report_url,
        },
      });
      if (logErr) {
        // Loud but non-fatal: the notification path continues.
        console.error(`[${FUNCTION_NAME}] activity_log insert failed for order=${orderId}:`, logErr);
      }
    }

    // ── 2. Homeowner email ───────────────────────────────────────────────
    if ((order.requested_by_role || "homeowner") === "contractor") {
      console.log(`[${FUNCTION_NAME}] contractor-requested order ${orderId} — homeowner email intentionally skipped (#1411 substrate)`);
      return json({ success: true, skipped: true, reason: "contractor_requested" }, 200, corsHeaders);
    }

    const { data: profile } = await sb
      .from("profiles")
      .select("email, full_name")
      .eq("id", claim?.user_id ?? order.user_id)
      .maybeSingle();
    const homeownerEmail = profile?.email || "";
    if (!homeownerEmail) {
      console.error(`[${FUNCTION_NAME}] no homeowner email for order=${orderId}`);
      return json({ success: false, error: "No homeowner email on file" }, 422, corsHeaders);
    }

    if (isTestClaim || isTestAccount(homeownerEmail)) {
      console.log(`[${FUNCTION_NAME}] test order ${orderId} — logged, email skipped (${homeownerEmail})`);
      return json({ success: true, skipped: true, reason: "test_account" }, 200, corsHeaders);
    }

    // Idempotency: one "ready" email per order, ever — Edit re-saves must not re-send.
    const { data: existing } = await sb
      .from("notifications")
      .select("id")
      .eq("notification_type", NOTIFICATION_TYPE)
      .eq("channel", "email")
      .ilike("message_preview", `%${orderId}%`)
      .limit(1);
    if (existing && existing.length > 0) {
      console.log(`[${FUNCTION_NAME}] already sent for order ${orderId}`);
      return json({ success: true, skipped: true, reason: "already_notified" }, 200, corsHeaders);
    }

    const { data: settings } = await sb
      .from("platform_settings")
      .select("value")
      .eq("key", "measurement_products")
      .maybeSingle();
    const catalog = (settings?.value ?? {}) as Record<string, Product>;
    const productLabel = catalog[order.product_code ?? ""]?.label || "measurement report";

    const address = claim?.property_address || "your property";
    const firstName = (profile?.full_name || "").trim().split(/\s+/)[0] || "there";
    const subject = `Your ${productLabel} is ready`;

    const textBody = [
      `Hi ${firstName},`,
      ``,
      `Good news — the ${productLabel} you ordered for ${address} is ready.`,
      ``,
      `The measurements are now on your project, and contractors bidding your job can use them right away.`,
      ``,
      `View your project: ${DASHBOARD_URL}`,
      ``,
      `Questions? Just reply to this email or write to support@otterquote.com.`,
      ``,
      `— Otter Quotes`,
    ].join("\n");

    const htmlBody = buildEmailHtml({ firstName, productLabel, address });

    const formData = new FormData();
    formData.append("from", `Otter Quotes <notifications@${mailgunDomain}>`);
    formData.append("to", homeownerEmail);
    formData.append("subject", subject);
    formData.append("text", textBody);
    formData.append("html", htmlBody);

    let mgData: any;
    try {
      const mgRes = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`api:${mailgunKey}`)}` },
        body: formData,
      });
      if (!mgRes.ok) {
        const errText = await mgRes.text();
        throw new Error(`Mailgun error ${mgRes.status}: ${errText}`);
      }
      mgData = await mgRes.json();
    } catch (sendErr) {
      // gh-1538: this used to bubble to the generic outer catch, which
      // returned "Internal server error" with no durable trace anywhere —
      // a paid $150 (or $25/$55) order's homeowner "report ready" email
      // could fail with zero record of why. The order.status is already
      // 'completed' and the #1412 fulfilment activity_log row is already
      // written above; only the email send itself failed. Log it and
      // return a specific error instead.
      console.error(`[${FUNCTION_NAME}] send failed for order=${orderId}:`, sendErr);
      await logNotificationFailure(
        (row) => sb.from("activity_log").insert(row),
        sendErr,
        {
          functionName: FUNCTION_NAME,
          recipientRole: order.requested_by_role || "homeowner",
          isTest: isTestClaim,
          userId: claim?.user_id ?? order.user_id,
          extra: { order_id: orderId, claim_id: order.claim_id },
        },
      );
      return json({ error: "Failed to send notification" }, 502, corsHeaders);
    }
    console.log(`[${FUNCTION_NAME}] sent for order=${orderId} to=${homeownerEmail} mailgun_id=${mgData.id}`);

    const { error: insertErr } = await sb.from("notifications").insert({
      user_id: claim?.user_id ?? order.user_id,
      claim_id: order.claim_id,
      channel: "email",
      notification_type: NOTIFICATION_TYPE,
      recipient: homeownerEmail,
      // The order id in the preview is the idempotency key — keep it here.
      message_preview: `Measurement report ready — order ${order.id} (${productLabel})`,
      sent_at: new Date().toISOString(),
      delivered: true,
      mailgun_id: mgData.id,
    });
    if (insertErr) {
      console.warn(`[${FUNCTION_NAME}] failed to log notification for order=${orderId}:`, insertErr);
    }

    return json({ success: true, mailgun_id: mgData.id }, 200, corsHeaders);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error:`, err);
    return json({ error: "Internal server error" }, 500, corsHeaders);
  }
});
