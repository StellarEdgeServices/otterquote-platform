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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
          error: "No active Hover order found for this claim.",
          detail: "A measurement link can only be resent for claims with a pending or sent Hover order.",
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

Here's a reminder with your Hover measurement link for ${propertyAddress}.

To get accurate bids from contractors, we need aerial measurements of your roof. Hover makes this easy — just use the link below to submit photos from your phone or computer, and Hover's technology will generate professional measurements automatically.

Your Hover Measurement Link:
${hoverOrder.capture_link}

What to do:
1. Click the link above
2. Follow the on-screen instructions to submit photos
3. Hover will process your photos and generate measurements
4. You'll be notified when measurements are ready

This usually takes less than 24 hours. Once complete, you'll be able to submit your project for contractor bids.

If you have questions, reply to this email or call us at (844) 875-3412.

The OtterQuote Team
https://otterquote.com`;

    const formData = new URLSearchParams();
    formData.append("from", `OtterQuote <notifications@${MAILGUN_DOMAIN}>`);
    formData.append("to", homeownerEmail);
    formData.append("subject", "Your Hover Measurement Link — Action Required");
    formData.append("text", emailText);

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
        status: "sent",
        email: homeownerEmail,
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
