/**
 * OtterQuote Edge Function: notify-contractors
 * Notifies matching contractors via email (Mailgun) and SMS (Twilio) when a
 * new claim is submitted for bidding.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Limits: 10/day, 30/month (D-030)
 * Capped at 6 contractors per opportunity.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "notify-contractors";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    // ========== VALIDATE CREDENTIALS ==========
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");
    const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
    const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    const TWILIO_PHONE_NUMBER = Deno.env.get("TWILIO_PHONE_NUMBER");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error(
        "Mailgun credentials not configured. Set MAILGUN_API_KEY and MAILGUN_DOMAIN."
      );
    }

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      throw new Error(
        "Twilio credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER."
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

    // ========== PREPARE EMAIL AND SMS ==========
    const emailSubject = `New Opportunity in ${claim_city}, ${claim_state}`;
    const smsMessage = `New OtterQuote opportunity in ${claim_city}, ${claim_state}! Log in to view details: https://otterquote.com/contractor-opportunities.html`;
    const opportunityLink =
      "https://otterquote.com/contractor-opportunities.html";

    const notifiedContractors = [];
    const basicAuthMailgun = btoa(`api:${MAILGUN_API_KEY}`);
    const basicAuthTwilio = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

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
      const phoneRecipients = (contractor.notification_phones && contractor.notification_phones.length > 0)
        ? contractor.notification_phones
        : (contractor.phone ? [contractor.phone] : []);

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

      // ===== SEND SMS =====
      for (const recipientPhone of phoneRecipients) {
        try {
          const formData = new URLSearchParams();
          formData.append("To", recipientPhone);
          formData.append("From", TWILIO_PHONE_NUMBER);
          formData.append("Body", smsMessage);

          console.log("Sending SMS to contractor:", contractor.id, "phone:", recipientPhone);

          const twilioResponse = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${basicAuthTwilio}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: formData,
            }
          );

          if (twilioResponse.ok) {
            const twilioData = await twilioResponse.json();
            smsSent = true;
            console.log("SMS sent to contractor:", contractor.id, "SID:", twilioData.sid);

            await supabase.from("notifications").insert({
              user_id: contractor.user_id,
              claim_id: claim_id,
              channel: "sms",
              notification_type: "new_opportunity",
              recipient: recipientPhone,
              message_preview: `New opportunity in ${claim_city}, ${claim_state}`,
            });
          } else {
            const errorData = await twilioResponse.text();
            console.error("Twilio SMS send failed for contractor", contractor.id, ":", twilioResponse.status, errorData);
          }
        } catch (error) {
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
