/**
 * OtterQuote Edge Function: notify-measurement-order (gh-1412)
 *
 * Admin purchase-notification email for the MANUAL measurement-fulfilment
 * loop (D-317 cl. 7). Before this function, create-measurement-order only
 * console.log'd "order queued for manual fulfillment" — a paid order sat in
 * hover_orders where nobody would ever see it without querying the table by
 * hand (measured live on #1412: the first real-looking row sat unnoticed in
 * awaiting_fulfillment for 6h44m with zero notification artifacts anywhere).
 *
 * Called by create-measurement-order (service-role bearer, machine-to-machine
 * — same auth model as notify-admin-new-contractor) right after it inserts a
 * hover_orders row in status 'awaiting_fulfillment' (homeowner-paid) or
 * 'awaiting_quote' (contractor request, unpriced).
 *
 * Subject lines are #1339's own spec copy, verbatim:
 *   "Buy basic report — [address]"     (homeowner-priced purchase)
 *   "Buy detailed report — [address]"  (contractor request / upgrade path;
 *                                       shared substrate with #1411)
 *
 * Idempotent per order: a notifications row of type 'admin_measurement_order'
 * whose message_preview carries this order id means we already sent — skip.
 * (notifications has no order_id column; the id-in-preview probe is the same
 * trade-off notify-admin-new-contractor makes with its user_id+type key.)
 *
 * Test traffic (claims.is_test, or buyer emails matching the standing
 * test-account patterns) is skipped, matching notify-admin-new-contractor.
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { logNotificationFailure } from "./notification-failure.ts";

const FUNCTION_NAME = "notify-measurement-order";
const ADMIN_EMAIL = "dustinstohler1@gmail.com";
const ADMIN_PORTAL_URL = "https://otterquote.com/admin-measurements.html";
const NOTIFICATION_TYPE = "admin_measurement_order";

// CORS — origin-allowlisted per project standard (Session 254). This function
// is machine-called, but the standard headers keep error responses uniform.
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

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return "$" + (cents / 100).toFixed(2);
}

interface Product {
  label?: string;
  homeowner_price_cents?: number | null;
  expected_vendor_cost_cents?: number | null;
}

function buildEmailHtml(args: {
  subject: string;
  productLabel: string;
  address: string;
  buyerLine: string;
  paidLine: string;
  vendorCostLine: string;
  claimIdShort: string;
  orderedTs: string;
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
              🦦 ${escapeHtml(args.subject)}
            </h2>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              A measurement order is waiting on manual fulfilment. Order the report from the
              measurement vendor, then deliver it in the admin queue.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">
              <tr>
                <td style="padding:8px 0;color:#64748B;width:140px;vertical-align:top;">Report</td>
                <td style="padding:8px 0;font-weight:600;">${escapeHtml(args.productLabel)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Property</td>
                <td style="padding:8px 0;">${escapeHtml(args.address)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Requested by</td>
                <td style="padding:8px 0;">${escapeHtml(args.buyerLine)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Paid</td>
                <td style="padding:8px 0;">${escapeHtml(args.paidLine)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Expected cost</td>
                <td style="padding:8px 0;">${escapeHtml(args.vendorCostLine)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Claim</td>
                <td style="padding:8px 0;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(args.claimIdShort)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Ordered</td>
                <td style="padding:8px 0;">${escapeHtml(args.orderedTs)} CT</td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#F59E0B" style="border-radius:8px;">
                  <a href="${ADMIN_PORTAL_URL}"
                     style="display:inline-block;font-family:sans-serif;font-size:15px;font-weight:700;
                            color:#0B1929;text-decoration:none;padding:12px 24px;">
                    Open the fulfilment queue &rarr;
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

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, corsHeaders);

  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const mailgunKey = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN") || "";
    if (!serviceRoleKey || !supabaseUrl || !mailgunKey || !mailgunDomain) {
      throw new Error("Missing required environment variables");
    }

    // Machine-called only: the bearer must be the service role key itself
    // (same auth model as notify-admin-new-contractor). Browser clients never
    // call this function.
    const authHeader = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!bearerToken || bearerToken !== serviceRoleKey) {
      console.error(`[${FUNCTION_NAME}] unauthorized`);
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }

    const body = await req.json().catch(() => null);
    const orderId = body?.order_id as string | undefined;
    if (!orderId) {
      return json({ error: "Missing required field: order_id" }, 400, corsHeaders);
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: order, error: oErr } = await sb
      .from("hover_orders")
      .select("id, claim_id, user_id, status, product_code, requested_by_role, homeowner_charge_amount, created_at")
      .eq("id", orderId)
      .single();
    if (oErr || !order) {
      console.error(`[${FUNCTION_NAME}] order not found`, orderId, oErr);
      return json({ error: "Order not found" }, 404, corsHeaders);
    }

    const { data: claim } = await sb
      .from("claims")
      .select("id, property_address, is_test")
      .eq("id", order.claim_id)
      .maybeSingle();

    const { data: buyerProfile } = await sb
      .from("profiles")
      .select("email, full_name")
      .eq("id", order.user_id)
      .maybeSingle();

    const buyerEmail = buyerProfile?.email || "";
    if (claim?.is_test === true || (buyerEmail && isTestAccount(buyerEmail))) {
      console.log(`[${FUNCTION_NAME}] skipping test order ${orderId} (is_test=${claim?.is_test}, buyer=${buyerEmail})`);
      return json({ success: true, skipped: true, reason: "test_account" }, 200, corsHeaders);
    }

    // Idempotency: one admin email per order, ever.
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

    // Catalog lookup for the label + expected vendor cost. A missing catalog
    // entry must not block the notification — the email is the point.
    const { data: settings } = await sb
      .from("platform_settings")
      .select("value")
      .eq("key", "measurement_products")
      .maybeSingle();
    const catalog = (settings?.value ?? {}) as Record<string, Product>;
    const product = catalog[order.product_code ?? ""] ?? {};

    const address = claim?.property_address || "(no address on claim)";
    // #1339's spec copy, verbatim: priced homeowner purchase = "basic",
    // contractor request (unpriced / upgrade substrate, #1411) = "detailed".
    const isPricedPurchase =
      product.homeowner_price_cents !== null && product.homeowner_price_cents !== undefined
        ? true
        : order.homeowner_charge_amount !== null && order.homeowner_charge_amount !== undefined;
    const subject = isPricedPurchase
      ? `Buy basic report — ${address}`
      : `Buy detailed report — ${address}`;

    const productLabel = product.label || order.product_code || "Measurement report";
    const buyerLine =
      (order.requested_by_role || "homeowner") + (buyerEmail ? ` (${buyerEmail})` : "");
    const paidLine =
      order.homeowner_charge_amount !== null && order.homeowner_charge_amount !== undefined
        ? money(order.homeowner_charge_amount) + " (payment verified)"
        : "unpriced — needs a quote before any charge";
    const vendorCostLine =
      product.expected_vendor_cost_cents !== null && product.expected_vendor_cost_cents !== undefined
        ? money(product.expected_vendor_cost_cents) + " (catalog estimate)"
        : "—";
    const claimIdShort = String(order.claim_id || "").slice(0, 8);
    const orderedTs = order.created_at
      ? new Date(order.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

    const textBody = [
      `A measurement order is waiting on manual fulfilment.`,
      ``,
      `Report      : ${productLabel}`,
      `Property    : ${address}`,
      `Requested by: ${buyerLine}`,
      `Paid        : ${paidLine}`,
      `Expected cost: ${vendorCostLine}`,
      `Claim       : ${claimIdShort}`,
      `Order id    : ${order.id}`,
      `Ordered     : ${orderedTs} CT`,
      ``,
      `Order the report from the measurement vendor, then deliver it here:`,
      ADMIN_PORTAL_URL,
    ].join("\n");

    const htmlBody = buildEmailHtml({
      subject,
      productLabel,
      address,
      buyerLine,
      paidLine,
      vendorCostLine,
      claimIdShort,
      orderedTs,
    });

    const formData = new FormData();
    formData.append("from", `Otter Quotes <notifications@${mailgunDomain}>`);
    formData.append("to", ADMIN_EMAIL);
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
      // the admin purchase-notification email could fail with zero record
      // of why. Log it and return a specific error instead.
      console.error(`[${FUNCTION_NAME}] send failed for order=${orderId}:`, sendErr);
      await logNotificationFailure(
        (row) => sb.from("activity_log").insert(row),
        sendErr,
        {
          functionName: FUNCTION_NAME,
          recipientRole: order.requested_by_role || "homeowner",
          isTest: claim?.is_test === true,
          userId: order.user_id,
          extra: { order_id: orderId, claim_id: order.claim_id },
        },
      );
      return json({ error: "Failed to send notification" }, 502, corsHeaders);
    }
    console.log(`[${FUNCTION_NAME}] sent for order=${orderId} mailgun_id=${mgData.id}`);

    const { error: insertErr } = await sb.from("notifications").insert({
      user_id: order.user_id,
      claim_id: order.claim_id,
      channel: "email",
      notification_type: NOTIFICATION_TYPE,
      recipient: ADMIN_EMAIL,
      // The order id in the preview is the idempotency key — keep it here.
      message_preview: `Measurement order ${order.id}: ${productLabel} — ${address}`,
      sent_at: new Date().toISOString(),
      delivered: true,
      mailgun_id: mgData.id,
    });
    if (insertErr) {
      // Non-fatal — the email is already out; the log row is secondary.
      console.warn(`[${FUNCTION_NAME}] failed to log notification for order=${orderId}:`, insertErr);
    }

    return json({ success: true, mailgun_id: mgData.id }, 200, corsHeaders);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error:`, err);
    return json({ error: "Internal server error" }, 500, corsHeaders);
  }
});
