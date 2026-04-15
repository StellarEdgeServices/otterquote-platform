/**
 * OtterQuote Edge Function: notify-contractors
 *
 * Handles four event types:
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
 *   4. agreement_requested (D-134) — called from bids.html when a homeowner clicks
 *      "Request Agreement" on an unsigned auto-bid. Sends email + SMS + dashboard
 *      notification to the contractor: "A homeowner is interested — sign your agreement now."
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
const OPPORTUNITIES_URL = "https://otterquote.com/contractor-opportunities.html";
const SETTINGS_URL = "https://otterquote.com/contractor-settings.html";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// =============================================================================
// EMAIL HELPERS
// =============================================================================

/** Translate a job_type slug to a human-readable label. */
function jobTypeLabel(jobType: string): string {
  const map: Record<string, string> = {
    insurance_rcv: "Insurance Restoration (RCV)",
    insurance_acv: "Insurance Restoration (ACV)",
    retail_cash: "Retail / Cash",
    repair: "Repair",
  };
  return map[(jobType || "").toLowerCase()] || "Insurance Restoration";
}

/** Shared HTML footer used in all contractor emails. */
function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
      <br><br>
      <a href="${SETTINGS_URL}" style="color:#94A3B8;font-size:12px;text-decoration:none;">Manage notification preferences</a>
    </td>
  </tr>
</table>`.trim();
}

/** Render a teal CTA button. */
function ctaButton(text: string, url: string, color = "#14B8A6"): string {
  return `
<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${color}" style="border-radius:8px;">
      <a href="${url}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">${text}</a>
    </td>
  </tr>
</table>`.trim();
}

/** Wrap any body HTML in the shared OtterQuote email shell. */
function buildEmail(bodyHtml: string): string {
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
        <!-- Header -->
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">OtterQuote</span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td>${emailFooter()}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

// =============================================================================
// EMAIL BODY BUILDERS
// =============================================================================

/**
 * Email 1 — New Opportunity
 * Leads with trade + location, shows value prop, prominent CTA, auto-bid tip.
 */
function newOpportunityEmailHtml(
  contractorName: string,
  city: string,
  state: string,
  tradeLabel: string,
  jobType: string
): string {
  const jLabel = jobTypeLabel(jobType);
  const tradeCap = tradeLabel.charAt(0).toUpperCase() + tradeLabel.slice(1);

  const body = `
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">New Opportunity</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">${tradeCap} Project &mdash; ${city}, ${state}</h2>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0F9FF;border-radius:8px;margin-bottom:20px;">
      <tr>
        <td style="padding:12px 16px;border-right:1px solid #BAE6FD;width:33%;">
          <p style="margin:0;color:#64748B;font-size:12px;">Trade</p>
          <p style="margin:4px 0 0;color:#0F172A;font-size:14px;font-weight:600;">${tradeCap}</p>
        </td>
        <td style="padding:12px 16px;border-right:1px solid #BAE6FD;width:33%;">
          <p style="margin:0;color:#64748B;font-size:12px;">Type</p>
          <p style="margin:4px 0 0;color:#0F172A;font-size:14px;font-weight:600;">${jLabel}</p>
        </td>
        <td style="padding:12px 16px;width:34%;">
          <p style="margin:0;color:#64748B;font-size:12px;">Location</p>
          <p style="margin:4px 0 0;color:#0F172A;font-size:14px;font-weight:600;">${city}, ${state}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">A contract-ready project is available in your service area. The winning contractor receives a fully executed contract, Hover aerial measurements, and the homeowner&rsquo;s contact information &mdash; everything you need to schedule and start work.</p>

    ${ctaButton("View Opportunity &rarr;", OPPORTUNITIES_URL)}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;margin-top:8px;">
      <tr>
        <td style="padding:14px 16px;">
          <p style="margin:0 0 4px;color:#92400E;font-size:14px;font-weight:600;">&#9889; Save time with Auto-Bid</p>
          <p style="margin:0;color:#78350F;font-size:13px;line-height:1.5;">Enable Auto-Bid in Settings and you&rsquo;ll automatically compete for every matching project &mdash; no manual action needed between jobs.</p>
        </td>
      </tr>
    </table>
  `;

  return buildEmail(body);
}

/**
 * Plain-text fallback for Email 1 (new_opportunity).
 */
function newOpportunityEmailText(
  contractorName: string,
  city: string,
  state: string,
  tradeLabel: string,
  jobType: string
): string {
  const jLabel = jobTypeLabel(jobType);
  return `Hi ${contractorName},

New ${tradeLabel} project in ${city}, ${state} (${jLabel}).

The winning contractor receives a fully executed contract, Hover aerial measurements, and the homeowner's contact information — ready to schedule and start work.

View opportunity:
${OPPORTUNITIES_URL}

Tip: Enable Auto-Bid in Settings to automatically compete for every matching project without manual action.
${SETTINGS_URL}

---
support@otterquote.com | (844) 875-3412
Manage preferences: ${SETTINGS_URL}`;
}

/**
 * Email 2 — Contract Signed / Project Package Ready
 */
function contractSignedEmailHtml(contractorName: string, claimId: string): string {
  const body = `
    <p style="margin:0 0 6px;color:#14B8A6;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Contract Signed</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your Project Package Is Ready</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">The homeowner has countersigned the contract. Your complete project package is waiting in your dashboard.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 10px;color:#166534;font-size:14px;font-weight:700;">What&rsquo;s included:</p>
        <table cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Fully executed contract</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Insurance loss sheet with AI-parsed summary</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Trade-specific Hover aerial measurements</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Material and color selections</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Homeowner contact information (released now)</td></tr>
        </table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FEF9C3;border:1px solid #FDE68A;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:12px 16px;">
        <p style="margin:0;color:#92400E;font-size:14px;font-weight:600;">&#9201; 48-hour window</p>
        <p style="margin:4px 0 0;color:#78350F;font-size:13px;">You have 48 hours to make initial contact with the homeowner. Log in now to view their information.</p>
      </td></tr>
    </table>

    ${ctaButton("Go to My Dashboard &rarr;", DASHBOARD_URL)}
  `;

  return buildEmail(body);
}

function contractSignedEmailText(contractorName: string): string {
  return `Hi ${contractorName},

The homeowner has countersigned your contract. Your complete project package is ready in your OtterQuote dashboard.

What's included:
- Fully executed contract
- Insurance loss sheet with AI-parsed summary
- Trade-specific Hover aerial measurements
- Material and color selections
- Homeowner contact information (released now)

You have 48 hours to make initial contact with the homeowner.

Log in to view your project package:
${DASHBOARD_URL}

---
support@otterquote.com | (844) 875-3412`;
}

/**
 * Email 3 — Bid Update Confirmed
 */
function bidUpdateEmailHtml(contractorName: string): string {
  const body = `
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Bid Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Bid Update Confirmed</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your updated bid has been saved. The homeowner has been notified and will see your revised figures when they review their options.</p>

    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">You can update your bid any time before the homeowner makes a selection.</p>

    ${ctaButton("View My Dashboard &rarr;", DASHBOARD_URL, "#0369A1")}
  `;

  return buildEmail(body);
}

function bidUpdateEmailText(contractorName: string): string {
  return `Hi ${contractorName},

Your updated bid has been saved. The homeowner has been notified and will see your revised figures when they review their options.

You can update your bid any time before the homeowner makes a selection.

Log in to your dashboard:
${DASHBOARD_URL}

---
support@otterquote.com | (844) 875-3412`;
}

/**
 * Email 4 — Agreement Requested
 * Urgency-driven: homeowner is ready to select, contractor just needs to sign.
 */
function agreementRequestedEmailHtml(
  contractorName: string,
  displayLocation: string,
  signingLink: string
): string {
  const body = `
    <p style="margin:0 0 6px;color:#DC2626;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Action Required</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">A Homeowner Is Ready to Select You</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">A homeowner reviewing bids for a project in <strong>${displayLocation}</strong> wants to work with you &mdash; but they can&rsquo;t select you until you sign your contractor agreement.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0;color:#991B1B;font-size:14px;font-weight:600;">Contractors who sign promptly get selected first.</p>
        <p style="margin:6px 0 0;color:#7F1D1D;font-size:13px;">Slower contractors lose to competitors who are ready. This takes about 2 minutes.</p>
      </td></tr>
    </table>

    ${ctaButton("Sign My Agreement Now &rarr;", signingLink, "#DC2626")}

    <p style="margin:16px 0 0;color:#6B7280;font-size:13px;">This link takes you directly to your agreement signing page and keeps your bid active.</p>
  `;

  return buildEmail(body);
}

function agreementRequestedEmailText(
  contractorName: string,
  displayLocation: string,
  signingLink: string
): string {
  return `Hi ${contractorName},

A homeowner reviewing bids for a project in ${displayLocation} is interested in working with you.

To be selected, you need to sign your contractor agreement. Contractors who sign promptly get selected first — slower contractors lose to competitors who are ready.

Sign your agreement now:
${signingLink}

This takes about 2 minutes and keeps your bid active.

---
support@otterquote.com | (844) 875-3412`;
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
    contract_signed: "contract_signed",
    bid_update_confirmed: "bid_update_confirmed",
    auto_bid_selected: "auto_bid_placed",
    agreement_requested: "agreement_requested",
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
  const fromAddress = `OtterQuote <notifications@${mailgunDomain}>`;

  const emailSubject = `Your contract is signed — project package ready`;
  const emailText = contractSignedEmailText(contractorName);
  const emailHtml = contractSignedEmailHtml(contractorName, claim_id);
  const smsMessage = `OtterQuote: Your contract is signed. Project package is ready — log in within 48 hrs to contact the homeowner: ${DASHBOARD_URL}`;

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
  const fromAddress = `OtterQuote <notifications@${mailgunDomain}>`;
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
// HANDLER: new_opportunity (default)
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
  const fromAddress = `OtterQuote <notifications@${mailgunDomain}>`;

  // Email subject — use trade + city for scannability in inbox
  const tradeCap = tradeLabel.charAt(0).toUpperCase() + tradeLabel.slice(1);
  const emailSubject = `New ${tradeCap} Opportunity — ${claim_city}, ${claim_state}`;
  const smsMessage = `New OtterQuote opportunity in ${claim_city}, ${claim_zip} — ${tradeLabel}. Log in to bid: ${OPPORTUNITIES_URL}`;

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

    if (!shouldNotify(contractor, "new_opportunity")) {
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

    const contractorName = contractor.contact_name || "there";
    const emailText = newOpportunityEmailText(contractorName, claim_city, claim_state, tradeLabel, job_type || "");
    const emailHtml = newOpportunityEmailHtml(contractorName, claim_city, claim_state, tradeLabel, job_type || "");

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
// HANDLER: agreement_requested (D-134)
// =============================================================================
async function handleAgreementRequested(
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  supabaseUrl: string,
  supabaseKey: string
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
    .select("id, user_id, email, phone, contact_name, company_name, notification_emails, notification_phones, notification_preferences")
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
  const fromAddress = `OtterQuote <notifications@${mailgunDomain}>`;

  // Privacy: strip full address — show only city and state to contractor
  const addrParts = (claim.property_address || "").split(",");
  const displayLocation = addrParts.length >= 2
    ? addrParts.slice(1).join(",").trim()
    : claim.property_address || "your project";

  const signingLink = `https://otterquote.com/contractor-bid-form.html?claim_id=${claim_id}&quote_id=${quote_id}&action=sign`;

  const emailSubject = `A homeowner is waiting — sign your agreement to be selected`;
  const emailText = agreementRequestedEmailText(contractorName, displayLocation, signingLink);
  const emailHtml = agreementRequestedEmailHtml(contractorName, displayLocation, signingLink);
  const smsMessage = `OtterQuote: A homeowner wants to select you for a project in ${displayLocation}. Sign your agreement now to stay in the running: ${signingLink}`;

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
      const ok = await sendSmsViaEdgeFunction(supabaseUrl, supabaseKey, phone, smsMessage, contractor.id);
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
      metadata: { quote_id, signing_link: signingLink },
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

    if (event_type === "agreement_requested") {
      return await handleAgreementRequested(body, supabase, MAILGUN_API_KEY, MAILGUN_DOMAIN, supabaseUrl, supabaseKey);
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
