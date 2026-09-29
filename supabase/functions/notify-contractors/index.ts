/**
 * Otter Quotes Edge Function: notify-contractors
 *
 * Handles four event types:
 *
 *   1. new_opportunity (default) — called when a homeowner submits for bidding.
 *      Notifies all matching active contractors via email + SMS.
 *      Rate-limited: 10/day, 30/month (D-030). Capped at 6 contractors per opportunity.
 *      #564 test-world symmetry: real claims fan out to real contractors only
 *      (#543 exclusion, v69 behavior); is_test=true claims fan out to
 *      is_test=true contractors ONLY — mirroring the v96 claims RLS carve-out.
 *
 *   2. contract_signed — called from docusign-webhook when envelope status = completed.
 *      Looks up the winning contractor for the claim and sends a targeted
 *      "your project package is ready" email + SMS.
 *
 *   3. bid_update_confirmed — called from contractor-bid-form.html after a successful
 *      bid update. Sends a confirmation email to the contractor who submitted the update.
 *
 *   4. agreement_requested (DEPRECATED — D-134 removed) — formerly called from bids.html
 *      when a homeowner clicked "Request Agreement." No longer triggered in the current
 *      flow since signing happens after homeowner selection, not before.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { selectFanOutContractors } from "./test-exclusion.ts";
import {
  DASHBOARD_URL,
  OPPORTUNITIES_URL,
  newOpportunityEmailHtml,
  newOpportunityEmailText,
  contractSignedEmailHtml,
  contractSignedEmailText,
  bidAcceptedEmailHtml,
  bidAcceptedEmailText,
  bidUpdateEmailHtml,
  bidUpdateEmailText,
  agreementRequestedEmailHtml,
  agreementRequestedEmailText,
  bidExpiredEmailHtml,
  bidExpiredEmailText,
  bidRenewalRequestedEmailHtml,
  bidRenewalRequestedEmailText,
} from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

const FUNCTION_NAME = "notify-contractors";

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

// =============================================================================
// NOTIFICATION PREFERENCE HELPER
// =============================================================================

/**
 * Determine whether a notification should be sent to a contractor based on their
 * saved notification_preferences JSONB.
 *
 * Key mapping — MUST match the keys written by contractor-settings.html:
 *   new_opportunity      → notification_preferences.new_opportunity
 *   bid_accepted         → notification_preferences.bid_accepted (gh-1293 criterion 3b —
 *                           contractor-settings.html:3124 has written this key since before
 *                           this handler existed; "Bid accepted by homeowner" was a toggle
 *                           for a notification that had no sender)
 *   contract_signed      → notification_preferences.contract_signed
 *   bid_update_confirmed → notification_preferences.bid_update_confirmed
 *   auto_bid_selected    → notification_preferences.auto_bid_placed
 *   agreement_requested  → notification_preferences.agreement_requested
 *
 * Defaults to TRUE (send) when the preference key is absent, null, or undefined.
 * Only suppresses when the key is explicitly set to false.
 */
function shouldNotify(
  contractor: Record<string, any>,
  notificationType: string
): boolean {
  const prefs: Record<string, any> = contractor.notification_preferences || {};

  const keyMap: Record<string, string> = {
    new_opportunity: "new_opportunity",
    bid_accepted: "bid_accepted",
    contract_signed: "contract_signed",
    bid_update_confirmed: "bid_update_confirmed",
    auto_bid_selected: "auto_bid_placed",
    agreement_requested: "agreement_requested",
    bid_expired: "bid_expired",
    bid_renewal_requested: "bid_renewal_requested",
  };

  const prefKey = keyMap[notificationType] ?? notificationType;
  return prefs[prefKey] !== false;
}

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

// =============================================================================
// MAILGUN HELPER
// =============================================================================

/** Send a single Mailgun email. Accepts optional html body (text is plain-text fallback). */
async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  from: string,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  const basicAuth = btoa(`api:${apiKey}`);
  const formData = new URLSearchParams();
  formData.append("from", from);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", text);
  if (html) formData.append("html", html);

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

// =============================================================================
// SMS HELPER
// =============================================================================

/**
 * Send SMS via the send-sms Edge Function. Returns true on success.
 *
 * gh-1916 / R-134 protective gate: refuse to even attempt a send unless the
 * contractor has a real, stored opt-in (`contractors.sms_opt_in = true`).
 * NULL (never asked — the pre-migration default for every existing row) and
 * false (declined) both refuse. This closes the gap the CEO's 2026-09-14 FYI
 * on #1916 flagged: this function previously gated only on the opt-OUT
 * `notification_preferences` map (shouldNotify()), which defaults every
 * contractor to "send" absent an explicit false — not the opt-IN TCPA
 * consent this issue requires. Single choke point for both SMS-sending
 * handlers that route through this helper (contract_signed, agreement_requested).
 */
async function sendSmsViaEdgeFunction(
  supabaseUrl: string,
  supabaseKey: string,
  to: string,
  message: string,
  contractorId: string,
  smsOptIn: boolean | null | undefined
): Promise<boolean> {
  if (smsOptIn !== true) {
    console.warn(
      `[notify-contractors] SMS refused (gh-1916 R-134 gate) — sms_opt_in is not true for contractor ${contractorId} (value=${String(smsOptIn)}). No Twilio call attempted.`
    );
    return false;
  }
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
// =============================================================================
// =============================================================================
// HANDLER: bid_accepted (gh-1293 criterion 3b)
// =============================================================================
/**
 * Called right after a homeowner's accept_bid RPC call succeeds (bids.html,
 * contractor-about.html). Looks up the winning contractor via
 * claims.selected_contractor_id -- same resolution shape as handleContractSigned
 * below, since both fire off a claim-level state change to a specific
 * contractor, not a payload-supplied contractor_id.
 *
 * This is the email channel. The 'dashboard' channel notifications row for
 * this same event is written unconditionally by the log_bid_accepted() DB
 * trigger (v114, 20260827024432) and is unaffected by this handler or by
 * the contractor's notification_preferences.bid_accepted toggle.
 */
async function handleBidAccepted(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { claim_id } = body;

  if (!claim_id) {
    return new Response(
      JSON.stringify({ error: "bid_accepted requires claim_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("id, selected_contractor_id, selected_bid_amount, property_address")
    .eq("id", claim_id)
    .single();

  if (claimErr || !claim) {
    console.error("bid_accepted: could not find claim", claim_id, claimErr?.message);
    return new Response(
      JSON.stringify({ error: "Claim not found", detail: claimErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!claim.selected_contractor_id) {
    console.warn("bid_accepted: claim has no selected_contractor_id", claim_id);
    return new Response(
      JSON.stringify({ error: "No winning contractor on this claim" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, contact_name, company_name, notification_emails, notification_preferences")
    .eq("id", claim.selected_contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.error("bid_accepted: could not find contractor", claim.selected_contractor_id, contractorErr?.message);
    return new Response(
      JSON.stringify({ error: "Contractor not found", detail: contractorErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!shouldNotify(contractor, "bid_accepted")) {
    console.log("Contractor", contractor.id, "opted out of bid_accepted notifications");
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
    console.warn("bid_accepted: no email recipients for contractor", contractor.id);
    return new Response(
      JSON.stringify({ notified: false, reason: "no_recipients" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const contractorName = contractor.contact_name || contractor.company_name || "Contractor";
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
  const address = claim.property_address || "your project";
  const amountStr = claim.selected_bid_amount
    ? "$" + Number(claim.selected_bid_amount).toLocaleString()
    : null;

  const emailSubject = `You won the bid — sign your contract to get started`;
  const emailText = bidAcceptedEmailText(contractorName, address, amountStr);
  const emailHtml = bidAcceptedEmailHtml(contractorName, address, amountStr);

  let emailSent = false;

  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailText, emailHtml
      );
      if (ok) {
        emailSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "email",
          notification_type: "bid_accepted",
          recipient: recipientEmail,
          message_preview: `Bid accepted — sign your contract for ${address}`,
        });
        console.log("bid_accepted email sent to", recipientEmail, "for claim", claim_id);
      }
    } catch (err) {
      console.error("Error sending bid_accepted email:", err);
    }
  }

  return new Response(
    JSON.stringify({ notified: true, email_sent: emailSent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleContractSigned(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  supabaseUrl: string,
  supabaseKey: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { claim_id } = body;

  if (!claim_id) {
    return new Response(
      JSON.stringify({ error: "contract_signed requires claim_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

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

  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, phone, contact_name, company_name, notification_emails, notification_phones, notification_preferences, sms_opt_in")
    .eq("id", claim.selected_contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.error("contract_signed: could not find contractor", claim.selected_contractor_id, contractorErr?.message);
    return new Response(
      JSON.stringify({ error: "Contractor not found", detail: contractorErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!shouldNotify(contractor, "contract_signed")) {
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
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;

  const emailSubject = `Your contract is signed — project package ready`;
  const emailText = contractSignedEmailText(contractorName);
  const emailHtml = contractSignedEmailHtml(contractorName, claim_id);
  const smsMessage = `Otter Quotes: Your contract is signed. Project package is ready — log in within 48 hrs to contact the homeowner: ${DASHBOARD_URL}`;

  let emailSent = false;
  let smsSent = false;

  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailText, emailHtml
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

  for (const phone of phoneRecipients) {
    try {
      const ok = await sendSmsViaEdgeFunction(supabaseUrl, supabaseKey, phone, smsMessage, contractor.id, contractor.sms_opt_in);
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
// =============================================================================
async function handleBidUpdateConfirmed(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { claim_id, contractor_id } = body;

  if (!claim_id || !contractor_id) {
    return new Response(
      JSON.stringify({ error: "bid_update_confirmed requires claim_id and contractor_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, contact_name, company_name, notification_emails, notification_preferences")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.warn("bid_update_confirmed: contractor not found", contractor_id, contractorErr?.message);
    return new Response(
      JSON.stringify({ notified: false, reason: "contractor_not_found" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!shouldNotify(contractor, "bid_update_confirmed")) {
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
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
  const emailSubject = `Bid update confirmed — homeowner notified`;
  const emailText = bidUpdateEmailText(contractorName);
  const emailHtml = bidUpdateEmailHtml(contractorName);

  let emailSent = false;

  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailText, emailHtml
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
// HANDLER: bid_expired
// =============================================================================
/**
 * Called when a bid expires without auto-renew (from process-bid-expirations or
 * directly from the UI). Sends the contractor an email with a one-click renew CTA.
 *
 * Required body fields: contractor_id, claim_id, quote_id, trade (optional), location (optional)
 */
async function handleBidExpired(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { contractor_id, claim_id, quote_id, trade, location } = body;

  if (!contractor_id || !claim_id || !quote_id) {
    return new Response(
      JSON.stringify({ error: "bid_expired requires contractor_id, claim_id, and quote_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, contact_name, company_name, notification_emails, notification_preferences")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.warn("bid_expired: contractor not found", contractor_id, contractorErr?.message);
    return new Response(
      JSON.stringify({ notified: false, reason: "contractor_not_found" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!shouldNotify(contractor, "bid_expired")) {
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
    console.warn("bid_expired: no email recipients for contractor", contractor_id);
    return new Response(
      JSON.stringify({ notified: false, reason: "no_recipients" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const contractorName = contractor.contact_name || contractor.company_name || "Contractor";
  const tradeCap = (trade || "roofing").charAt(0).toUpperCase() + (trade || "roofing").slice(1);
  const displayLocation = location || "your service area";

  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
  const emailSubject = `Your ${tradeCap} bid has expired — renew to stay in the running`;
  const emailHtml = bidExpiredEmailHtml(contractorName, displayLocation, tradeCap, quote_id, claim_id, mailgunDomain);
  const emailText = bidExpiredEmailText(contractorName, displayLocation, tradeCap, quote_id, claim_id);

  let emailSent = false;

  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailText, emailHtml
      );
      if (ok) {
        emailSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "email",
          notification_type: "bid_expired",
          recipient: recipientEmail,
          message_preview: `Your ${tradeCap} bid has expired — renew to stay in the running`,
        }).then(() => {}).catch(() => {}); // non-fatal
        console.log("bid_expired email sent to", recipientEmail, "quote", quote_id);
      }
    } catch (err) {
      console.error("Error sending bid_expired email:", err);
    }
  }

  return new Response(
    JSON.stringify({ notified: true, email_sent: emailSent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// HANDLER: bid_renewal_requested
// =============================================================================
/**
 * Called when a contractor manually renews a bid from the dashboard or bid form.
 * Sends a confirmation email: "Your bid is active again for another 14 days."
 *
 * Required body fields: contractor_id, claim_id, trade (optional), location (optional)
 */
async function handleBidRenewalRequested(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { contractor_id, claim_id, trade, location } = body;

  if (!contractor_id || !claim_id) {
    return new Response(
      JSON.stringify({ error: "bid_renewal_requested requires contractor_id and claim_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, contact_name, company_name, notification_emails, notification_preferences")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.warn("bid_renewal_requested: contractor not found", contractor_id, contractorErr?.message);
    return new Response(
      JSON.stringify({ notified: false, reason: "contractor_not_found" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!shouldNotify(contractor, "bid_renewal_requested")) {
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
    return new Response(
      JSON.stringify({ notified: false, reason: "no_recipients" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const contractorName = contractor.contact_name || contractor.company_name || "Contractor";
  const tradeCap = (trade || "roofing").charAt(0).toUpperCase() + (trade || "roofing").slice(1);
  const displayLocation = location || "your service area";

  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
  const emailSubject = `Your ${tradeCap} bid has been renewed — active for 14 more days`;
  const emailHtml = bidRenewalRequestedEmailHtml(contractorName, displayLocation, tradeCap);
  const emailText = bidRenewalRequestedEmailText(contractorName, displayLocation, tradeCap);

  let emailSent = false;

  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailText, emailHtml
      );
      if (ok) {
        emailSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "email",
          notification_type: "bid_renewal_requested",
          recipient: recipientEmail,
          message_preview: `Your ${tradeCap} bid has been renewed — active for 14 more days`,
        }).then(() => {}).catch(() => {}); // non-fatal
        console.log("bid_renewal_requested email sent to", recipientEmail, "claim", claim_id);
      }
    } catch (err) {
      console.error("Error sending bid_renewal_requested email:", err);
    }
  }

  return new Response(
    JSON.stringify({ notified: true, email_sent: emailSent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// D-165 HELPER: notify contractors for a single specific trade
// =============================================================================
/**
 * Fires new_opportunity email + SMS to all active contractors whose service
 * trades include `trade` AND whose service area covers the claim county.
 * Capped at 6 contractors per trade per D-030.
 *
 * Returns the per-contractor result array (used by handleNewOpportunity to
 * aggregate results across multiple trades).
 */
async function notifyContractorsForSingleTrade(
  trade: string,
  claim_id: string,
  claim_city: string,
  claim_state: string,
  claim_zip: string,
  claim_county: string | undefined,
  job_type: string,
  claimIsTest: boolean,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  supabaseUrl: string,
  supabaseKey: string
): Promise<Array<{ id: string; email_sent: boolean; sms_sent: boolean; skipped?: boolean; trade: string }>> {
  // Fetch all active contractors (no DB-level limit — we filter and cap below)
  const { data: contractors, error: contractorsError } = await supabase
    .from("contractors")
    .select("id, user_id, email, phone, contact_name, notification_emails, notification_phones, notification_preferences, sms_opt_in, trades, service_counties, is_test")
    .eq("status", "active");

  if (contractorsError) {
    console.error(`notifyContractorsForSingleTrade [${trade}]: DB error`, contractorsError.message);
    return [];
  }
  if (!contractors || contractors.length === 0) return [];

  // Filter 0 — #543/#564 symmetric test-world separation:
  //   real claims → real contractors only (is_test / internal-email rows
  //   excluded — #543 predicate, v69 behavior preserved);
  //   test claims → is_test=true contractors ONLY (walk/E2E traffic stays
  //   inside the test world, mirroring the v96 claims RLS carve-out).
  const eligibleContractors = selectFanOutContractors(contractors as any[], claimIsTest);
  if (eligibleContractors.length < contractors.length) {
    console.log(
      `notify-contractors [${trade}]: ${claimIsTest ? "test claim — " : ""}` +
      `${contractors.length - eligibleContractors.length} contractor(s) outside the claim's test-world filtered out (#564)`
    );
  }
  if (eligibleContractors.length === 0) return [];

  const tradeLower = trade.toLowerCase();

  // Filter 1 — trade match: contractor must list this trade (or have no trades set = conservative include)
  let matched = eligibleContractors.filter((c: any) => {
    if (!c.trades || c.trades.length === 0) return true;
    return c.trades.some((t: string) => t.toLowerCase() === tradeLower);
  });

  // Filter 2 — service county: only when claim_county is provided
  if (claim_county && claim_state) {
    const countyKeyFull = `${claim_state.toUpperCase()}:${claim_county}`.toUpperCase();
    const countyKeyShort = claim_county.toUpperCase();
    matched = matched.filter((c: any) => {
      if (!c.service_counties || c.service_counties.length === 0) return true; // conservative fallback
      return c.service_counties.some((sc: string) => {
        const scUp = (sc || "").trim().toUpperCase();
        return scUp === countyKeyFull || scUp === countyKeyShort;
      });
    });
    console.log(
      `notify-contractors [${trade}]: county filter (${countyKeyFull}), ` +
      `${matched.length} contractor(s) remain`
    );
  }

  // Cap at 6 per trade per D-030
  matched = matched.slice(0, 6);
  if (matched.length === 0) return [];

  const tradeCap = tradeLower.charAt(0).toUpperCase() + tradeLower.slice(1);
  const emailSubject = `New ${tradeCap} Opportunity — ${claim_city}, ${claim_state}`;
  const smsMessage   = `New Otter Quotes ${tradeCap} opportunity in ${claim_city}, ${claim_zip}. Log in to bid: ${OPPORTUNITIES_URL}`;
  const fromAddress  = `Otter Quotes <notifications@${mailgunDomain}>`;

  const results: Array<{ id: string; email_sent: boolean; sms_sent: boolean; skipped?: boolean; trade: string }> = [];

  for (const contractor of matched) {
    let emailSent = false;
    let smsSent   = false;

    if (!shouldNotify(contractor, "new_opportunity")) {
      results.push({ id: contractor.id, email_sent: false, sms_sent: false, skipped: true, trade: tradeLower });
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

    const contractorName = contractor.contact_name || "there";
    const emailText = newOpportunityEmailText(contractorName, claim_city, claim_state, tradeCap, job_type || "");
    const emailHtml = newOpportunityEmailHtml(contractorName, claim_city, claim_state, tradeCap, job_type || "");

    for (const recipientEmail of emailRecipients) {
      try {
        const ok = await sendMailgunEmail(
          mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailText, emailHtml
        );
        if (ok) {
          emailSent = true;
          await supabase.from("notifications").insert({
            user_id: contractor.user_id,
            claim_id,
            channel: "email",
            notification_type: "new_opportunity",
            recipient: recipientEmail,
            message_preview: `New ${tradeCap} opportunity in ${claim_city}, ${claim_state}`,
          });
          console.log(`new_opportunity [${tradeLower}] email sent to contractor ${contractor.id} -> ${recipientEmail}`);
        }
      } catch (err) {
        console.error(`Error sending new_opportunity [${tradeLower}] email to contractor ${contractor.id}:`, err);
      }
    }

    for (const phone of phoneRecipients) {
      try {
        // gh-1916 / R-134 protective gate — see sendSmsViaEdgeFunction's header
        // comment. This handler calls send-sms directly (not via that helper),
        // so the same gate is inlined here rather than routed through it.
        if (contractor.sms_opt_in !== true) {
          console.warn(
            `[notify-contractors] SMS refused (gh-1916 R-134 gate) — sms_opt_in is not true for contractor ${contractor.id} [${tradeLower}] (value=${String(contractor.sms_opt_in)}). No Twilio call attempted.`
          );
          continue;
        }
        const smsResponse = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
          body: JSON.stringify({ to: phone, message: smsMessage }),
        });
        if (smsResponse.status === 429) {
          console.warn(`SMS rate limit exceeded for contractor ${contractor.id} [${tradeLower}]`);
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
        console.log(`new_opportunity [${tradeLower}] SMS sent for contractor ${contractor.id} SID: ${smsData.sid}`);
      } catch (err) {
        console.error(`Error sending SMS [${tradeLower}] to contractor ${contractor.id}:`, err);
      }
    }

    results.push({ id: contractor.id, email_sent: emailSent, sms_sent: smsSent, trade: tradeLower });
  }

  return results;
}

// =============================================================================
// HANDLER: new_opportunity (default)
// =============================================================================
/**
 * D-165 per-trade release behavior:
 *
 *   • trade_types provided (e.g. ["roofing"] or ["siding"]):
 *       Fire per-trade notifications for each trade in the list.
 *       Each trade's notifications go only to contractors whose service
 *       trades include that specific trade (and whose county matches).
 *       Callers should pass one trade at a time — but multiple are
 *       tolerated for backwards-compatibility.
 *
 *   • trade_types absent / empty:
 *       Look up the claim's selected_trades and per-trade release
 *       timestamps from the DB. Only fire for trades where
 *       {trade}_bid_released_at IS NOT NULL. Skip trades that are
 *       still held (e.g. siding on a retail claim awaiting property design).
 */
async function handleNewOpportunity(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  supabaseUrl: string,
  supabaseKey: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { claim_id, claim_county, trade_types, job_type } = body;
  let { claim_zip, claim_city, claim_state } = body;

  if (!claim_id) {
    return new Response(
      JSON.stringify({ error: "Missing required field: claim_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // #564 — the claim's test-world flag drives symmetric fan-out selection:
  // real claims notify real contractors only (#543, v69 behavior); test
  // claims notify is_test=true contractors only. Fetched server-side so
  // callers can't spoof it.
  const { data: testFlagRow, error: testFlagErr } = await supabase
    .from("claims")
    .select("is_test")
    .eq("id", claim_id)
    .single();

  if (testFlagErr || !testFlagRow) {
    console.error("handleNewOpportunity: claim not found for is_test lookup", claim_id, testFlagErr?.message);
    return new Response(
      JSON.stringify({ error: "Claim not found", detail: testFlagErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const claimIsTest = testFlagRow.is_test === true;

  // Fix 2026-07-08 (PFW run pfw-1783551078): dashboard.html submitForBids() sends only
  // { claim_id }, so the strict field check 400'd every dashboard-submitted claim and
  // contractors never received new-opportunity notifications. Derive the location from
  // the claims row server-side; explicit caller-supplied fields keep precedence.
  if (!claim_zip || !claim_city || !claim_state) {
    const { data: locRow, error: locErr } = await supabase
      .from("claims")
      .select("property_address, property_state")
      .eq("id", claim_id)
      .single();

    if (locErr || !locRow) {
      console.error("handleNewOpportunity: claim not found for location derivation", claim_id, locErr?.message);
      return new Response(
        JSON.stringify({ error: "Claim not found", detail: locErr?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const addr: string = locRow.property_address || "";
    if (!claim_zip) {
      const zipMatch = addr.match(/\b(\d{5})(?:-\d{4})?\s*$/) || addr.match(/\b(\d{5})(?:-\d{4})?\b/);
      claim_zip = zipMatch ? zipMatch[1] : null;
    }
    if (!claim_city) {
      const parts = addr.split(",").map((s: string) => s.trim()).filter(Boolean);
      claim_city = parts.length >= 2 ? parts[1] : null;
    }
    if (!claim_state) {
      const stMatch = addr.match(/,\s*([A-Za-z]{2})\s+\d{5}/);
      claim_state = locRow.property_state || (stMatch ? stMatch[1].toUpperCase() : null);
    }

    if (!claim_zip || !claim_city || !claim_state) {
      return new Response(
        JSON.stringify({ error: "Missing location fields and could not derive them from claim.property_address", claim_id }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.log(`handleNewOpportunity: derived location for claim ${claim_id}: ${claim_city}, ${claim_state} ${claim_zip}`);
  }

  // Rate limit check — once per invocation, regardless of trade count
  const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
    p_function_name: FUNCTION_NAME,
    p_user_id: null,
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

  // ── Determine which trades to fire notifications for ─────────────────────
  let tradesToProcess: string[];

  if (trade_types && trade_types.length > 0) {
    // Specific trades provided by caller — use as given (backwards-compat + D-165 per-trade path)
    tradesToProcess = (trade_types as string[]).map((t) => t.toLowerCase());
  } else {
    // No trades provided — look up the claim and fire only for released trades (D-165 gate-aware path)
    const { data: claimData, error: claimErr } = await supabase
      .from("claims")
      .select("trades, roofing_bid_released_at, gutters_bid_released_at, siding_bid_released_at, windows_bid_released_at")
      .eq("id", claim_id)
      .single();

    if (claimErr || !claimData) {
      console.error("handleNewOpportunity: claim not found for release-timestamp lookup", claim_id, claimErr?.message);
      return new Response(
        JSON.stringify({ error: "Claim not found", detail: claimErr?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fix 2026-07-08 (PFW run pfw-1783551078): claims.selected_trades does not exist —
    // selecting it made PostgREST error the whole lookup, 404ing every gate-aware call.
    const allTrades: string[] = claimData.trades || ["roofing"];
    // Only notify for trades that have been released
    tradesToProcess = allTrades
      .map((t: string) => t.toLowerCase())
      .filter((t: string) => {
        const col = `${t}_bid_released_at` as keyof typeof claimData;
        return !!(claimData as any)[col];
      });

    if (tradesToProcess.length === 0) {
      console.log(`handleNewOpportunity: no released trades for claim ${claim_id} — notifications held`);
      return new Response(
        JSON.stringify({ notified_count: 0, message: "No trades released yet — notifications held pending gate clearance" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`handleNewOpportunity: no trade_types provided; firing for released trades [${tradesToProcess.join(", ")}]`);
  }

  // ── Fire per-trade notifications ─────────────────────────────────────────
  const allNotified: Array<{ id: string; email_sent: boolean; sms_sent: boolean; skipped?: boolean; trade: string }> = [];

  for (const trade of tradesToProcess) {
    console.log(`notify-contractors: firing new_opportunity for trade=${trade} claim=${claim_id}`);
    const tradeResults = await notifyContractorsForSingleTrade(
      trade,
      claim_id, claim_city, claim_state, claim_zip,
      claim_county,
      job_type || "",
      claimIsTest,
      supabase, mailgunApiKey, mailgunDomain, supabaseUrl, supabaseKey
    );
    allNotified.push(...tradeResults);
  }

  return new Response(
    JSON.stringify({
      notified_count: allNotified.filter((c) => !c.skipped).length,
      contractors: allNotified,
      trades_processed: tradesToProcess,
      rate_limit_counts: rateLimitResult?.counts,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// HANDLER: agreement_requested (D-134)
// =============================================================================
async function handleAgreementRequested(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  supabaseUrl: string,
  supabaseKey: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { claim_id, contractor_id, quote_id } = body;

  if (!claim_id || !contractor_id || !quote_id) {
    return new Response(
      JSON.stringify({ error: "agreement_requested requires claim_id, contractor_id, and quote_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("id, property_address")
    .eq("id", claim_id)
    .single();

  if (claimErr || !claim) {
    console.error("agreement_requested: could not find claim", claim_id, claimErr?.message);
    return new Response(
      JSON.stringify({ error: "Claim not found", detail: claimErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: contractor, error: contractorErr } = await supabase
    .from("contractors")
    .select("id, user_id, email, phone, contact_name, company_name, notification_emails, notification_phones, notification_preferences, sms_opt_in")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    console.error("agreement_requested: could not find contractor", contractor_id, contractorErr?.message);
    return new Response(
      JSON.stringify({ error: "Contractor not found", detail: contractorErr?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!shouldNotify(contractor, "agreement_requested")) {
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
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;

  // Privacy: strip full address — show only city and state to contractor
  const addrParts = (claim.property_address || "").split(",");
  const displayLocation = addrParts.length >= 2
    ? addrParts.slice(1).join(",").trim()
    : claim.property_address || "your project";

  const signingLink = `https://otterquote.com/contractor-bid-form.html?claim_id=${claim_id}&quote_id=${quote_id}&action=sign`;

  const emailSubject = `A homeowner is waiting — sign your agreement to be selected`;
  const emailText = agreementRequestedEmailText(contractorName, displayLocation, signingLink);
  const emailHtml = agreementRequestedEmailHtml(contractorName, displayLocation, signingLink);
  const smsMessage = `Otter Quotes: A homeowner wants to select you for a project in ${displayLocation}. Sign your agreement now to stay in the running: ${signingLink}`;

  let emailSent = false;
  let smsSent = false;

  for (const recipientEmail of emailRecipients) {
    try {
      const ok = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, recipientEmail, fromAddress, emailSubject, emailText, emailHtml
      );
      if (ok) {
        emailSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "email",
          notification_type: "agreement_requested",
          recipient: recipientEmail,
          message_preview: `A homeowner is waiting — sign your agreement for ${displayLocation}`,
        });
        console.log("agreement_requested email sent to", recipientEmail, "for claim", claim_id);
      }
    } catch (err) {
      console.error("Error sending agreement_requested email:", err);
    }
  }

  for (const phone of phoneRecipients) {
    try {
      const ok = await sendSmsViaEdgeFunction(supabaseUrl, supabaseKey, phone, smsMessage, contractor.id, contractor.sms_opt_in);
      if (ok) {
        smsSent = true;
        await supabase.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id,
          channel: "sms",
          notification_type: "agreement_requested",
          recipient: phone,
          message_preview: smsMessage.substring(0, 100),
        });
      }
    } catch (err) {
      console.error("Error sending agreement_requested SMS:", err);
    }
  }

  // Always insert an in-app dashboard notification
  try {
    await supabase.from("notifications").insert({
      user_id: contractor.user_id,
      claim_id,
      channel: "dashboard",
      notification_type: "agreement_requested",
      message_preview: `A homeowner is interested in your bid for ${displayLocation} — sign your agreement now to be selected`,
      // Fix 2026-07-08 (PFW pfw-1783551078): notifications has no metadata column —
      // the insert PGRST204'd on every call and the in-app notification never landed.
    });
  } catch (err) {
    console.warn("Could not insert dashboard notification for agreement_requested:", err);
  }

  return new Response(
    JSON.stringify({ notified: true, email_sent: emailSent, sms_sent: smsSent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================
serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Health check ping -- returns immediately without doing real work.
  // Called by platform-health-check every 15 minutes.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

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

    if (event_type === "bid_accepted") {
      return await handleBidAccepted(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, corsHeaders);
    }

    if (event_type === "contract_signed") {
      return await handleContractSigned(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, supabaseUrl, supabaseKey, corsHeaders);
    }

    if (event_type === "bid_update_confirmed") {
      return await handleBidUpdateConfirmed(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, corsHeaders);
    }

    if (event_type === "agreement_requested") {
      return await handleAgreementRequested(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, supabaseUrl, supabaseKey, corsHeaders);
    }

    if (event_type === "bid_expired") {
      return await handleBidExpired(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, corsHeaders);
    }

    if (event_type === "bid_renewal_requested") {
      return await handleBidRenewalRequested(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, corsHeaders);
    }

    // Default: new_opportunity
    return await handleNewOpportunity(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, supabaseUrl, supabaseKey, corsHeaders);

  } catch (error) {
    console.error("notify-contractors unhandled error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
