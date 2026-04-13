/**
 * OtterQuote Edge Function: notify-contractors
 *
 * Handles three event types:
 *
 *   1. new_opportunity (default) — called when a homeowner submits for bidding.
 *      Notifies all matching active contractors via email + SMS.
 *      Rate-limited: 10/day, 30/month (D-030). Capped at 6 contractors per opportunity.
 *
 *   2. contract_signed — called from docusign-webhook when envelope status = completed.
 *      Looks up the winning contractor for the claim and sends a targeted
 *      "your project package is ready" email + SMS.
 *
 *   3. bid_update_confirmed — called from contractor-bid-form.html after a successful
 *      bid update. Sends a confirmation email to the contractor who submitted the update.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "notify-contractors";
const DASHBOARD_URL = "https://otterquote.com/contractor-dashboard.html";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function buildTradeLabel(trades: string[]): string {
  if (!trades || trades.length === 0) return "general";
  if (trades.length === 1) return trades[0].toLowerCase();
  if (trades.length === 2) return trades.map((t) => t.toLowerCase()).join(" & ");
  return "multiple trades";
}

/** Send a single Mailgun email. Returns true on success. */
async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  from: string,
  subject: string,
  text: string
): Promise<boolean> {
  const basicAuth = btoa(`api:${apiKey}`);
  const formData = new URLSearchParams();
  formData.append("from", from);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", text);

  const response = await fetch(
    `https://api.mailgun.net/v3/${domain}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}` },
      body: formData,
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Mailgun error (${response.status}):`, errText);
    return false;
  }
  return true;
}

/** Send SMS via the send-sms Edge Function. Returns true on success. */
async function sendSmsViaEdgeFunction(
  supabaseUrl: string,
  supabaseKey: string,
  to: string,
  message: string,
  contractorId: string
): Promise<boolean> {
  const response = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ to, message }),
  });

  if (response.status === 429) {
    console.warn(`SMS rate limit exceeded for contractor ${contractorId} — skipping`);
    return false;
  }
  if (!response.ok) {
    const errText = await response.text();
    console.error(`send-sms error for contractor ${contractorId}:`, response.status, errText);
    return false;
  }
  return true;
}

// =============================================================================
// HANDLER: contract_signed
// Called by docusign-webhook when the homeowner countersigns the contract.
// Sends a targeted "project package ready" email + SMS to the winning contractor.
// =============================================================================
async function handleContractSigned(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  supabaseUrl: string,
  supabaseKey: string
): Promise<Response> {
  const { claim_id } = body;

  if (!claim_id) {
    return new Response(
      JSON.stringify({ error: "contract_signed requires claim_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Look up the claim and winning contractor ID
  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("id, selected_contractor_id, property_address")
    .eq("id", claim_id)
    .single();

  if (claimErr || !claim) {
    console.error("contract_signed: could not find claim", claim_id, claimErr?.message);
    return new Response(
      JSON.stringify({ error: "Claim not found", detail: claimErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!claim.selected_contractor_id) {
    console.warn("contract_signed: claim has no selected_contractor_id", claim_id);
    return new Response(
      JSON.stringify({ error: "No winning contractor on this claim" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Look up the winning contractor
  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, phone, contact_name, company_name, notification_emails, notification_phones, notification_preferences")
    .eq("id", claim.selected_contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.error("contract_signed: could not find contractor", claim.selected_contractor_id, contractorErr?.message);
    return new Response(
      JSON.stringify({ error: "Contractor not found", detail: contractorErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Respect notification preferences
  const prefs = contractor.notification_preferences || {};
  if (prefs.contract_signed === false) {
    console.log("Contractor", contractor.id, "opted out of contract_signed notifications");
    return new Response(
      JSON.stringify({ notified: false, reason: "opt_out" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const emailRecipients: string[] =
    contractor.notification_emails?.length > 0
      ? contractor.notification_emails
      : contractor.email ? [contractor.email] : [];

  const rawPhones: string[] =
    contractor.notification_phones?.length > 0
      ? contractor.notification_phones
      : contractor.phone ? [contractor.phone] : [];

  const phoneRecipients = rawPhones
    .map((p: string) => normalizePhone(p))
    .filter((p: string | null): p is string => p !== null);

  const contractorName = contractor.contact_name || contractor.company_name || "Contractor";
  const fromAddress = `OtterQuote <notifications@${mailgunDomain}>`;

  const emailSubject = `Your contract is signed — project package ready`;
  const emailBody = `Hi ${contractorName},

A homeowner has countersigned your contract. Your complete project package is ready in your OtterQuote dashboard.

What's included:
- Fully executed contract
- Insurance loss sheet with AI-parsed summary
- Trade-specific Hover aerial measurements
- Material and color selections
- Homeowner contact information (released now)

You have 48 hours to make initial contact with the homeowner.

Log in to view your project package:
${DASHBOARD_URL}

Best regards,
OtterQuote Team
support@otterquote.com | (844) 875-3412`;

  const smsMessage = `OtterQuote: Your contract is signed. Project package is ready — log in within 48 hrs to contact the homeowner: ${DASHBOARD_URL}`;

  let emailSent = false;
  let smsSent = false;

  // Send emails
  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailBody
      );
      if (ok) {
        emailSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "email",
          notification_type: "contract_signed",
          recipient: recipientEmail,
          message_preview: `Contract signed — project package ready for claim ${claim_id.slice(0, 8)}`,
        });
        console.log("contract_signed email sent to", recipientEmail, "for claim", claim_id);
      }
    } catch (err) {
      console.error("Error sending contract_signed email:", err);
    }
  }

  // Send SMS
  for (const phone of phoneRecipients) {
    try {
      const ok = await sendSmsViaEdgeFunction(supabaseUrl, supabaseKey, phone, smsMessage, contractor.id);
      if (ok) {
        smsSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "sms",
          notification_type: "contract_signed",
          recipient: phone,
          message_preview: smsMessage.substring(0, 100),
        });
      }
    } catch (err) {
      console.error("Error sending contract_signed SMS:", err);
    }
  }

  return new Response(
    JSON.stringify({ notified: true, email_sent: emailSent, sms_sent: smsSent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// HANDLER: bid_update_confirmed
// Called from contractor-bid-form.html after a successful bid update.
// Sends a confirmation email to the contractor confirming their update was saved.
// =============================================================================
async function handleBidUpdateConfirmed(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string
): Promise<Response> {
  const { claim_id, contractor_id } = body;

  if (!claim_id || !contractor_id) {
    return new Response(
      JSON.stringify({ error: "bid_update_confirmed requires claim_id and contractor_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Look up the contractor
  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, contact_name, company_name, notification_emails, notification_preferences")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.warn("bid_update_confirmed: contractor not found", contractor_id, contractorErr?.message);
    // Non-fatal — return success so the frontend does not show an error to the contractor
    return new Response(
      JSON.stringify({ notified: false, reason: "contractor_not_found" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Respect notification preferences
  const prefs = contractor.notification_preferences || {};
  if (prefs.bid_updates === false) {
    return new Response(
      JSON.stringify({ notified: false, reason: "opt_out" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const emailRecipients: string[] =
    contractor.notification_emails?.length > 0
      ? contractor.notification_emails
      : contractor.email ? [contractor.email] : [];

  if (emailRecipients.length === 0) {
    console.warn("bid_update_confirmed: no email recipients for contractor", contractor_id);
    return new Response(
      JSON.stringify({ notified: false, reason: "no_recipients" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const contractorName = contractor.contact_name || contractor.company_name || "Contractor";
  const fromAddress = `OtterQuote <notifications@${mailgunDomain}>`;
  const emailSubject = `Bid update confirmed — homeowner notified`;
  const emailBody = `Hi ${contractorName},

Your updated bid has been saved. The homeowner has been notified and will see your revised figures when they review their options.

You can update your bid any time before the homeowner makes a selection.

Log in to your dashboard:
${DASHBOARD_URL}

Best regards,
OtterQuote Team
support@otterquote.com | (844) 875-3412`;

  let emailSent = false;

  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailBody
      );
      if (ok) {
        emailSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "email",
          notification_type: "bid_update_confirmed",
          recipient: recipientEmail,
          message_preview: `Your bid update was saved — homeowner notified`,
        });
        console.log("bid_update_confirmed email sent to", recipientEmail);
      }
    } catch (err) {
      console.error("Error sending bid_update_confirmed email:", err);
    }
  }

  return new Response(
    JSON.stringify({ notified: true, email_sent: emailSent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// HANDLER: new_opportunity (default)
// Original flow — notifies matching active contractors of a new claim.
// =============================================================================
async function handleNewOpportunity(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  supabaseUrl: string,
  supabaseKey: string
): Promise<Response> {
  const { claim_id, claim_zip, claim_city, claim_state, trade_types, job_type } = body;

  if (!claim_id || !claim_zip || !claim_city || !claim_state) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: claim_id, claim_zip, claim_city, claim_state" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Rate limit check
  const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
    p_function_name: FUNCTION_NAME,
    p_caller_id: claim_id,
  });

  if (rlError) {
    console.error("Rate limit check failed:", rlError);
    return new Response(
      JSON.stringify({ error: "Rate limit check failed", detail: rlError.message }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!rateLimitResult?.allowed) {
    console.warn(`RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`);
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded", reason: rateLimitResult?.reason }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Find matching contractors (capped at 6 per D-030)
  const { data: contractors, error: contractorsError } = await supabase
    .from("contractors")
    .select("id, user_id, email, phone, contact_name, notification_emails, notification_phones, notification_preferences, trades")
    .eq("status", "active")
    .limit(6);

  if (contractorsError) throw new Error(`Database query failed: ${contractorsError.message}`);

  if (!contractors || contractors.length === 0) {
    return new Response(
      JSON.stringify({ notified_count: 0, message: "No active contractors found" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const tradeLabel = buildTradeLabel(trade_types || []);
  const opportunityLink = "https://otterquote.com/contractor-opportunities.html";
  const emailSubject = `New Opportunity in ${claim_city}, ${claim_state}`;
  const smsMessage = `New OtterQuote opportunity in ${claim_city}, ${claim_zip} — ${tradeLabel}. Log in to bid: ${opportunityLink}`;
  const fromAddress = `OtterQuote <notifications@${mailgunDomain}>`;

  // Filter by trade
  let matchedContractors = contractors;
  if (trade_types && trade_types.length > 0) {
    const requestedTrades = trade_types.map((t: string) => t.toLowerCase());
    matchedContractors = contractors.filter((c: any) => {
      if (!c.trades || c.trades.length === 0) return true;
      return c.trades.some((t: string) => requestedTrades.includes(t.toLowerCase()));
    });
  }

  const notifiedContractors = [];

  for (const contractor of matchedContractors) {
    let emailSent = false;
    let smsSent = false;

    const prefs = contractor.notification_preferences || {};
    if (prefs.new_opportunity === false) {
      notifiedContractors.push({ id: contractor.id, email_sent: false, sms_sent: false, skipped: true });
      continue;
    }

    const emailRecipients: string[] =
      contractor.notification_emails?.length > 0
        ? contractor.notification_emails
        : contractor.email ? [contractor.email] : [];

    const rawPhones: string[] =
      contractor.notification_phones?.length > 0
        ? contractor.notification_phones
        : contractor.phone ? [contractor.phone] : [];

    const phoneRecipients = rawPhones
      .map((p: string) => normalizePhone(p))
      .filter((p: string | null): p is string => p !== null);

    const emailBody = `Hi ${contractor.contact_name || "Contractor"},

A new opportunity is available in ${claim_city}, ${claim_state} for ${job_type || "a new job"}.

Log in to OtterQuote to view the project details, measurements, and submit your bid:
${opportunityLink}

Best regards,
OtterQuote Team
support@otterquote.com | (844) 875-3412`;

    for (const recipientEmail of emailRecipients) {
      try {
        const ok = await sendMailgunEmail(
          mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailBody
        );
        if (ok) {
          emailSent = true;
          await supabase.from("notifications").insert({
            user_id: contractor.user_id,
            claim_id,
            channel: "email",
            notification_type: "new_opportunity",
            recipient: recipientEmail,
            message_preview: `New opportunity in ${claim_city}, ${claim_state}`,
          });
          console.log("new_opportunity email sent to contractor", contractor.id, "->", recipientEmail);
        }
      } catch (err) {
        console.error("Error sending new_opportunity email to contractor", contractor.id, ":", err);
      }
    }

    for (const phone of phoneRecipients) {
      try {
        const smsResponse = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
          body: JSON.stringify({ to: phone, message: smsMessage }),
        });

        if (smsResponse.status === 429) {
          console.warn("SMS rate limit exceeded for contractor", contractor.id);
          continue;
        }
        if (!smsResponse.ok) continue;

        const smsData = await smsResponse.json();
        smsSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "sms",
          notification_type: "new_opportunity",
          recipient: phone,
          message_preview: smsMessage.substring(0, 100),
        });
        console.log("new_opportunity SMS sent for contractor", contractor.id, "SID:", smsData.sid);
      } catch (err) {
        console.error("Error sending SMS to contractor", contractor.id, ":", err);
      }
    }

    notifiedContractors.push({ id: contractor.id, email_sent: emailSent, sms_sent: smsSent });
  }

  return new Response(
    JSON.stringify({
      notified_count: notifiedContractors.length,
      contractors: notifiedContractors,
      rate_limit_counts: rateLimitResult?.counts,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
  const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");

  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    return new Response(
      JSON.stringify({ error: "Mailgun credentials not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const event_type = body.event_type || "new_opportunity";

    console.log(`notify-contractors: event_type=${event_type}, claim_id=${body.claim_id}`);

    if (event_type === "contract_signed") {
      return await handleContractSigned(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, supabaseUrl, supabaseKey);
    }

    if (event_type === "bid_update_confirmed") {
      return await handleBidUpdateConfirmed(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN);
    }

    // Default: new_opportunity
    return await handleNewOpportunity(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, supabaseUrl, supabaseKey);

  } catch (error) {
    console.error("notify-contractors unhandled error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
