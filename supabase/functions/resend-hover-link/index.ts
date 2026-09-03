/**
 * OtterQuote Edge Function: resend-hover-link
 *
 * Re-sends the existing Hover capture link to the homeowner via Mailgun.
 * Does NOT create a new Hover order — just re-emails the link already stored
 * in hover_orders.capture_link.
 *
 * Rate limit: 3 resends per claim per day (enforced here via hover_orders columns).
 * A global kill switch row exists in rate_limit_config ('resend-hover-link').
 *
 * Environment variables required (already set in Supabase secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const MAX_RESENDS_PER_DAY = 3;

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
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

// ── Inlined from _shared/email.ts (#869) — see that file's header comment ──
// for why this is duplicated rather than imported (the EF body-deploy path
// does not resolve `_shared/` imports). Table-based CTA + MSO VML conditional
// so Outlook renders a real filled rectangle, not a bare link. Brand amber #E07B00.
function emailButton({ href, label }: { href: string; label: string }): string {
  const BRAND_AMBER = "#E07B00";
  const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  return `
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="${BRAND_AMBER}" fillcolor="${BRAND_AMBER}">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:${FONT_STACK};font-size:16px;font-weight:700;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${BRAND_AMBER}" style="border-radius:8px;">
      <a href="${href}" style="display:inline-block;font-family:${FONT_STACK};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">${label}</a>
    </td>
  </tr>
</table>
<!--<![endif]-->`.trim();
}

// #869 AC 4: this was the one genuinely customer-facing bare-URL offender —
// the homeowner-facing capture link was printed as raw text with no HTML
// part at all. The text/plain part below deliberately KEEPS the bare URL
// (#869 AC 2 — accessibility / HTML-blocked-client fallback); only the new
// HTML part turns it into a button.
function buildHtmlBody(homeownerName: string, propertyAddress: string, captureLink: string): string {
  const body = `
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Hi ${homeownerName},</p>
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Here&rsquo;s a reminder with your measurement link for <strong>${propertyAddress}</strong>.</p>
<p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">To get accurate bids from contractors, we need aerial measurements of your roof. It&rsquo;s easy &mdash; just use the button below to submit photos from your phone or computer, and professional measurements will be generated automatically.</p>
${emailButton({ href: captureLink, label: "Open Your Measurement Link →" })}
<p style="margin:20px 0 8px;color:#374151;font-size:15px;font-weight:600;">What to do:</p>
<ol style="margin:0 0 20px;padding-left:20px;color:#374151;font-size:15px;line-height:1.8;">
  <li>Click the button above</li>
  <li>Follow the on-screen instructions to submit photos</li>
  <li>Your photos will be processed to generate measurements</li>
  <li>You&rsquo;ll be notified when measurements are ready</li>
</ol>
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">This usually takes less than 24 hours. Once complete, you&rsquo;ll be able to submit your project for contractor bids.</p>
<p style="margin:0;color:#64748B;font-size:13px;line-height:1.6;">If you have questions, reply to this email or call us at (844) 875-3412.</p>
`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${body}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { claim_id } = await req.json();

    if (!claim_id) {
      return new Response(
        JSON.stringify({ error: "Missing required field: claim_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Auth + claim ownership (D-211 P19 Unit 7c) ────────────────────────
    // verify_jwt=false, so enforce in-code. Dual pattern (mirrors
    // parse-loss-sheet): trusted service-role callers bypass; user-JWT callers
    // must own the claim. Closes the unauthenticated-email + PII-echo hole.
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const isServiceRole = token === supabaseKey;

    if (!isServiceRole) {
      if (!token) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data: { user: caller }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !caller) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: invalid token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data: ownerRow, error: ownerErr } = await supabase
        .from("claims")
        .select("user_id")
        .eq("id", claim_id)
        .single();
      if (ownerErr || !ownerRow || ownerRow.user_id !== caller.id) {
        return new Response(
          JSON.stringify({ error: "Forbidden: caller does not own this claim" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Global kill switch check ──────────────────────────────────────────
    const { data: configRow } = await supabase
      .from("rate_limit_config")
      .select("enabled")
      .eq("function_name", "resend-hover-link")
      .single();

    if (configRow && !configRow.enabled) {
      return new Response(
        JSON.stringify({ error: "Resend functionality is temporarily disabled." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Fetch hover order for this claim ──────────────────────────────────
    const { data: hoverOrder, error: hoError } = await supabase
      .from("hover_orders")
      .select(
        "id, claim_id, status, capture_link, capturing_user_email, resend_count, last_resend_at"
      )
      .eq("claim_id", claim_id)
      .in("status", ["pending", "link_sent"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (hoError || !hoverOrder) {
      return new Response(
        JSON.stringify({
          error: "No active measurement order found for this claim.",
          detail: "A measurement link can only be resent for claims with a pending or sent measurement order.",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!hoverOrder.capture_link) {
      return new Response(
        JSON.stringify({ error: "No capture link on file for this order. Contact support." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Per-claim per-day rate limit ──────────────────────────────────────
    const todayUTC = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const lastResendDate = hoverOrder.last_resend_at
      ? new Date(hoverOrder.last_resend_at).toISOString().slice(0, 10)
      : null;

    const todayResendCount =
      lastResendDate === todayUTC ? (hoverOrder.resend_count ?? 0) : 0;

    if (todayResendCount >= MAX_RESENDS_PER_DAY) {
      console.warn(
        `RATE LIMITED [resend-hover-link]: claim ${claim_id} has ${todayResendCount} resends today`
      );
      return new Response(
        JSON.stringify({
          error: "Daily resend limit reached",
          reason: `You can resend this link up to ${MAX_RESENDS_PER_DAY} times per day. Please try again tomorrow.`,
          resend_count: todayResendCount,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Fetch homeowner profile for email personalization ─────────────────
    // claims.user_id → profiles.id → profiles.full_name + email
    const { data: claimRow } = await supabase
      .from("claims")
      .select("user_id, property_address")
      .eq("id", claim_id)
      .single();

    let homeownerName = "there";
    let homeownerEmail = hoverOrder.capturing_user_email; // fallback

    if (claimRow?.user_id) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", claimRow.user_id)
        .single();

      if (profile?.full_name) {
        homeownerName = profile.full_name.split(" ")[0] || "there";
      }
      if (profile?.email) {
        homeownerEmail = profile.email;
      }

      // Also try auth.users for email if profile doesn't have it
      if (!homeownerEmail) {
        const { data: authUser } = await supabase.auth.admin.getUserById(
          claimRow.user_id
        );
        homeownerEmail = authUser?.user?.email || null;
      }
    }

    if (!homeownerEmail) {
      return new Response(
        JSON.stringify({ error: "Could not determine homeowner email address." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Send Mailgun email ────────────────────────────────────────────────
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY")!;
    const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN")!;

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured.");
    }

    const propertyAddress = claimRow?.property_address || "your property";

    const emailText = `Hi ${homeownerName},

Here's a reminder with your measurement link for ${propertyAddress}.

To get accurate bids from contractors, we need aerial measurements of your roof. It's easy — just use the link below to submit photos from your phone or computer, and professional measurements will be generated automatically.

Your Measurement Link:
${hoverOrder.capture_link}

What to do:
1. Click the link above
2. Follow the on-screen instructions to submit photos
3. Your photos will be processed to generate measurements
4. You'll be notified when measurements are ready

This usually takes less than 24 hours. Once complete, you'll be able to submit your project for contractor bids.

If you have questions, reply to this email or call us at (844) 875-3412.

The Otter Quotes Team
https://otterquote.com`;

    const emailHtml = buildHtmlBody(homeownerName, propertyAddress, hoverOrder.capture_link);

    const formData = new URLSearchParams();
    formData.append("from", `Otter Quotes <notifications@${MAILGUN_DOMAIN}>`);
    formData.append("to", homeownerEmail);
    formData.append("subject", "Your Measurement Link — Action Required");
    formData.append("text", emailText);
    formData.append("html", emailHtml);

    const mailgunResponse = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
        },
        body: formData,
      }
    );

    if (!mailgunResponse.ok) {
      const errText = await mailgunResponse.text();
      console.error("Mailgun error:", mailgunResponse.status, errText);
      throw new Error(
        `Email delivery failed (HTTP ${mailgunResponse.status}). Please try again.`
      );
    }

    const mailgunResult = await mailgunResponse.json();
    console.log(
      `[resend-hover-link] Email sent to ${homeownerEmail} for claim ${claim_id}. Mailgun ID: ${mailgunResult.id}`
    );

    // ── Update resend tracking on hover_orders ────────────────────────────
    const newCount = todayResendCount + 1;
    const { error: updateError } = await supabase
      .from("hover_orders")
      .update({
        resend_count: newCount,
        last_resend_at: new Date().toISOString(),
      })
      .eq("id", hoverOrder.id);

    if (updateError) {
      // Non-fatal — the email was sent; just log the tracking failure
      console.error(
        "[resend-hover-link] Failed to update resend tracking:",
        updateError
      );
    }

    return new Response(
      JSON.stringify({
        // PII: do NOT echo the homeowner email back to the caller (D-211 P19 Unit 7c).
        status: "sent",
        resend_count: newCount,
        resends_remaining_today: MAX_RESENDS_PER_DAY - newCount,
        mailgun_id: mailgunResult.id,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[resend-hover-link] Uncaught error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
