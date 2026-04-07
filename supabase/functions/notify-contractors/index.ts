/**
 * OtterQuote Edge Function: notify-contractors
 * Notifies matching contractors via email (Mailgun) and SMS (via send-sms Edge Function)
 * when a new claim is submitted for bidding.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Limits: 10/day, 30/month (D-030)
 * Capped at 6 contractors per opportunity.
 *
 * SMS is fire-and-forget per contractor: if the send-sms rate limit is exceeded
 * for a given contractor (HTTP 429), SMS is skipped silently — email always fires.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   (Twilio credentials are consumed by the send-sms Edge Function, not here)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "notify-contractors";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX for US numbers).
 * Returns null if the number cannot be normalized to 10 digits.
 */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Build a human-readable trade label from an array of trade strings.
 * e.g. ['roofing'] → 'roofing'
 *      ['roofing', 'gutters'] → 'roofing & gutters'
 *      ['roofing', 'gutters', 'siding'] → 'multiple trades'
 */
function buildTradeLabel(trades: string[]): string {
  if (!trades || trades.length === 0) return "general";
  if (trades.length === 1) return trades[0].toLowerCase();
  if (trades.length === 2) return trades.map((t) => t.toLowerCase()).join(" & ");
  return "multiple trades";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const {
      claim_id,
      claim_zip,
      claim_city,
      claim_state,
      trade_types,
      job_type,
      urgency,
    } = await req.json();

    // Validate required fields
    if (!claim_id || !claim_zip || !claim_city || !claim_state) {
      return new Response(
        JSON.stringify({
          error:
            "Missing required fields: claim_id, claim_zip, claim_city, claim_state",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc(
      "check_rate_limit",
      {
        p_function_name: FUNCTION_NAME,
        p_caller_id: claim_id,
      }
    );

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({
          error:
            "Rate limit check failed. Refusing to notify contractors for safety.",
          detail: rlError.message,
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!rateLimitResult?.allowed) {
      console.warn(
        `RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`
      );
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          reason: rateLimitResult?.reason,
          counts: rateLimitResult?.counts,
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== VALIDATE EMAIL CREDENTIALS ==========
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error(
        "Mailgun credentials not configured. Set MAILGUN_API_KEY and MAILGUN_DOMAIN."
      );
    }

    // ========== FIND MATCHING CONTRACTORS ==========
    // For now, select all active contractors. Will refine later with service area matching.
    const { data: contractors, error: contractorsError } = await supabase
      .from("contractors")
      .select("id, user_id, email, phone, contact_name, notification_emails, notification_phones, notification_preferences, trades")
      .eq("status", "active")
      .limit(6); // Cap at 6 contractors per opportunity (D-030)

    if (contractorsError) {
      console.error("Failed to query contractors:", contractorsError);
      throw new Error(`Database query failed: ${contractorsError.message}`);
    }

    if (!contractors || contractors.length === 0) {
      console.log(
        "No active contractors found for claim:",
        claim_id
      );
      return new Response(
        JSON.stringify({
          notified_count: 0,
          contractors: [],
          message: "No active contractors found",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== PREPARE NOTIFICATION CONTENT ==========
    const tradeLabel = buildTradeLabel(trade_types || []);
    const emailSubject = `New Opportunity in ${claim_city}, ${claim_state}`;
    const opportunityLink = "https://otterquote.com/contractor-opportunities.html";

    // SMS message format per task spec:
    // "New OtterQuote opportunity in [city, zip] — [trade type]. Log in to bid: <url>"
    const smsMessage = `New OtterQuote opportunity in ${claim_city}, ${claim_zip} — ${tradeLabel}. Log in to bid: ${opportunityLink}`;

    const notifiedContractors = [];
    const basicAuthMailgun = btoa(`api:${MAILGUN_API_KEY}`);

    // ========== FILTER BY TRADE (if trade_types provided) ==========
    let matchedContractors = contractors;
    if (trade_types && trade_types.length > 0) {
      const requestedTrades = trade_types.map((t: string) => t.toLowerCase());
      matchedContractors = contractors.filter((c: any) => {
        if (!c.trades || c.trades.length === 0) return true; // No trades set = show all
        return c.trades.some((t: string) => requestedTrades.includes(t.toLowerCase()));
      });
    }

    // ========== NOTIFY EACH CONTRACTOR ==========
    for (const contractor of matchedContractors) {
      let emailSent = false;
      let smsSent = false;

      // Check notification preferences — skip if they opted out of new_opportunity
      const prefs = contractor.notification_preferences || {};
      if (prefs.new_opportunity === false) {
        console.log("Contractor", contractor.id, "opted out of new_opportunity notifications");
        notifiedContractors.push({ id: contractor.id, email_sent: false, sms_sent: false, skipped: true });
        continue;
      }

      // Determine email recipients: use notification_emails if set, otherwise fall back to primary email
      const emailRecipients = (contractor.notification_emails && contractor.notification_emails.length > 0)
        ? contractor.notification_emails
        : (contractor.email ? [contractor.email] : []);

      // Determine SMS recipients: use notification_phones if set, otherwise fall back to primary phone
      const rawPhones = (contractor.notification_phones && contractor.notification_phones.length > 0)
        ? contractor.notification_phones
        : (contractor.phone ? [contractor.phone] : []);

      // Normalize phone numbers to E.164; skip any that can't be normalized
      const phoneRecipients = rawPhones
        .map((p: string) => normalizePhone(p))
        .filter((p: string | null): p is string => p !== null);

      // ===== SEND EMAILS =====
      for (const recipientEmail of emailRecipients) {
        try {
          const emailBody = `Hi ${contractor.contact_name || "Contractor"},

A new opportunity is available in ${claim_city}, ${claim_state} for ${job_type || "a new job"}.

Log in to OtterQuote to view details and submit your bid:
${opportunityLink}

Best regards,
OtterQuote Team`;

          const fromAddress = `OtterQuote <notifications@${MAILGUN_DOMAIN}>`;

          const formData = new URLSearchParams();
          formData.append("from", fromAddress);
          formData.append("to", recipientEmail);
          formData.append("subject", emailSubject);
          formData.append("text", emailBody);

          console.log("Sending email to contractor:", contractor.id, "email:", recipientEmail);

          const mailgunResponse = await fetch(
            `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
            {
              method: "POST",
              headers: { Authorization: `Basic ${basicAuthMailgun}` },
              body: formData,
            }
          );

          if (mailgunResponse.ok) {
            const mailgunData = await mailgunResponse.json();
            emailSent = true;
            console.log("Email sent to contractor:", contractor.id, "Mailgun ID:", mailgunData.id);

            await supabase.from("notifications").insert({
              user_id: contractor.user_id,
              claim_id: claim_id,
              channel: "email",
              notification_type: "new_opportunity",
              recipient: recipientEmail,
              message_preview: `New opportunity in ${claim_city}, ${claim_state}`,
            });
          } else {
            const errorData = await mailgunResponse.text();
            console.error("Mailgun email send failed for contractor", contractor.id, ":", mailgunResponse.status, errorData);
          }
        } catch (error) {
          console.error("Error sending email to contractor", contractor.id, ":", error);
        }
      }

      // ===== SEND SMS VIA send-sms EDGE FUNCTION =====
      // Each phone fires through the send-sms function so its per-function rate limits
      // (20/day, 100/month) are enforced. A 429 response means the limit is exceeded
      // for this contractor — skip silently and let the email flow continue.
      for (const recipientPhone of phoneRecipients) {
        try {
          console.log("Requesting SMS for contractor:", contractor.id, "phone:", recipientPhone);

          const smsResponse = await fetch(
            `${supabaseUrl}/functions/v1/send-sms`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({
                to: recipientPhone,
                message: smsMessage,
              }),
            }
          );

          if (smsResponse.status === 429) {
            // Rate limit exceeded — skip silently, email is unaffected
            console.warn("SMS rate limit exceeded for contractor", contractor.id, "— skipping SMS silently");
            continue;
          }

          if (!smsResponse.ok) {
            const errText = await smsResponse.text();
            console.error("send-sms returned error for contractor", contractor.id, ":", smsResponse.status, errText);
            continue;
          }

          const smsData = await smsResponse.json();
          smsSent = true;
          console.log("SMS dispatched for contractor:", contractor.id, "SID:", smsData.sid);

          await supabase.from("notifications").insert({
            user_id: contractor.user_id,
            claim_id: claim_id,
            channel: "sms",
            notification_type: "new_opportunity",
            recipient: recipientPhone,
            message_preview: smsMessage.substring(0, 100),
          });
        } catch (error) {
          // Non-blocking — log the error but do not fail the contractor loop
          console.error("Error sending SMS to contractor", contractor.id, ":", error);
        }
      }

      notifiedContractors.push({
        id: contractor.id,
        email_sent: emailSent,
        sms_sent: smsSent,
      });
    }

    console.log(
      "Notification complete for claim:",
      claim_id,
      "notified:",
      notifiedContractors.length
    );

    return new Response(
      JSON.stringify({
        notified_count: notifiedContractors.length,
        contractors: notifiedContractors,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("notify-contractors error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
