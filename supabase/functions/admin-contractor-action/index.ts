/**
 * OtterQuote Edge Function: admin-contractor-action
 *
 * Handles admin actions on contractor accounts:
 *   - approve: Activate contractor and send welcome email
 *   - reject: Mark as inactive and send rejection email
 *   - send_insurance_verification: Send COI verification request to broker
 *   - mark_license_verified: Mark license as verified
 *   - mark_insurance_verified: Mark insurance as verified
 *   - save_notes: Save admin notes to contractor record
 *
 * All actions require authentication as dustinstohler1@gmail.com.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/** Send a Mailgun email. Returns true on success. */
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

  try {
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
  } catch (err) {
    console.error("Mailgun request failed:", err);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get the JWT from Authorization header
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.substring(7);

    // Initialize Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase credentials not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user is admin
    const { data: user, error: userError } = await supabase.auth.getUser(
      token
    );

    if (userError || !user?.user || user.user.email !== "dustinstohler1@gmail.com") {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const body = await req.json();
    const { action, contractor_id, reason, broker_email, contractor_company_name, notes } = body;

    if (!action || !contractor_id) {
      return new Response(
        JSON.stringify({ error: "Missing action or contractor_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const mailgunKey = Deno.env.get("MAILGUN_API_KEY");
    const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN");

    if (!mailgunKey || !mailgunDomain) {
      throw new Error("Mailgun credentials not configured");
    }

    // ── Action: approve ──
    if (action === "approve") {
      // Update contractor status
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          status: "active",
          approved_at: new Date().toISOString(),
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      // Fetch contractor details
      const { data: contractor } = await supabase
        .from("contractors")
        .select("email, company_name")
        .eq("id", contractor_id)
        .single();

      if (contractor) {
        const approvalEmail = `Hi ${contractor.company_name},

Great news — your OtterQuote contractor account has been approved. You can now browse available opportunities and submit bids.

Log in to get started: https://otterquote.com/contractor-dashboard.html

Before submitting your first bid, make sure you've completed these steps in your dashboard:
- Add a payment method (required to receive projects)
- Upload your contract template
- Select your preferred shingle brand

If you have any questions, we're here: support@otterquote.com or (844) 875-3412.

The OtterQuote Team`;

        await sendMailgunEmail(
          mailgunKey,
          mailgunDomain,
          contractor.email,
          "OtterQuote <notifications@mail.otterquote.com>",
          "Welcome to OtterQuote — You're Approved!",
          approvalEmail
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: reject ──
    if (action === "reject") {
      if (!reason) {
        return new Response(
          JSON.stringify({ error: "Missing rejection reason" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update contractor status
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          status: "inactive",
          rejected_at: new Date().toISOString(),
          rejection_reason: reason,
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      // Fetch contractor details
      const { data: contractor } = await supabase
        .from("contractors")
        .select("email, company_name")
        .eq("id", contractor_id)
        .single();

      if (contractor) {
        const rejectionEmail = `Hi ${contractor.company_name},

Thank you for applying to join the OtterQuote contractor network. After reviewing your application, we weren't able to approve your account at this time.

Reason: ${reason}

If you'd like to address this and reapply, please contact us at support@otterquote.com or call (844) 875-3412. We're happy to work with you to get things squared away.

The OtterQuote Team`;

        await sendMailgunEmail(
          mailgunKey,
          mailgunDomain,
          contractor.email,
          "OtterQuote <notifications@mail.otterquote.com>",
          "OtterQuote Contractor Application — Action Required",
          rejectionEmail
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: send_insurance_verification ──
    if (action === "send_insurance_verification") {
      if (!broker_email || !contractor_company_name) {
        return new Response(
          JSON.stringify({ error: "Missing broker_email or contractor_company_name" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update contractor
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          insurance_verification_sent_at: new Date().toISOString(),
          insurance_verification_email: broker_email,
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      const coiEmail = `Dear Insurance Representative,

We are writing to verify the Certificate of Insurance on file for ${contractor_company_name}, who has applied to join the OtterQuote contractor network.

We are requesting confirmation that the following policies are currently active and in good standing for this insured:
- Commercial General Liability Insurance
- Workers' Compensation Insurance

Please reply to this email confirming policy status, or contact us at info@otterquote.com or (844) 875-3412 with any questions.

Thank you for your time.

OtterQuote
info@otterquote.com
(844) 875-3412
https://otterquote.com`;

      await sendMailgunEmail(
        mailgunKey,
        mailgunDomain,
        broker_email,
        "OtterQuote <info@mail.otterquote.com>",
        "COI Verification Request — OtterQuote",
        coiEmail
      );

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: mark_license_verified ──
    if (action === "mark_license_verified") {
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          license_verified: true,
          license_verified_at: new Date().toISOString(),
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: mark_insurance_verified ──
    if (action === "mark_insurance_verified") {
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          insurance_verified: true,
          insurance_verified_at: new Date().toISOString(),
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: save_notes ──
    if (action === "save_notes") {
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          admin_notes: notes || null,
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Unknown action
    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("admin-contractor-action error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
