/**
 * Otter Quotes Edge Function: admin-contractor-action
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";
import {
  approvalEmailText,
  approvalEmailHtml,
  rejectionEmailText,
  rejectionEmailHtml,
  coiEmailText,
  coiEmailHtml,
} from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

// gh-1534: kept in sync with supabase/functions/_shared/admin.ts PRIMARY_ADMIN_EMAIL —
// do not edit without updating that file too (deploy path does not resolve imports).
// This function has only ever gated on the single primary email, not the full
// ADMIN_EMAILS allow-list — do not widen without an explicit decision (see gh-1534).
const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): admin-only
// function (requires dustinstohler1@gmail.com auth) — origin allowlisted.
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
// EMAIL HELPERS
// =============================================================================

/** Send a Mailgun email. Returns true on success. Accepts optional html (text is plain-text fallback). */
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
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Health check ping -- returns immediately without doing real work.
  // The platform-health-check function uses a service-role bearer token,
  // so we check for health_check before the admin JWT gate.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

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

    if (userError || !user?.user || user.user.email !== PRIMARY_ADMIN_EMAIL) {
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
      // gh-755: Dustin-ruled default (2026-08-18) — newly-approved
      // contractors are opted into the public directory by default, with
      // notice given at signup (contractor-pre-approval.html). They can
      // still opt out afterward via the settings toggle (PR #194/#293).
      const { error: updateError, data: updatedRows } = await supabase
        .from("contractors")
        .update({
          status: "active",
          approved_at: new Date().toISOString(),
          public_directory_optin: true,
        })
        .eq("id", contractor_id)
        .select("id");

      if (updateError) {
        throw updateError;
      }
      // gh-2105: log-only (admin-facing; the existing 500 path has no zero-row text and
      // none is added) -- a zero-row match means no contractor row was written.
      if (!checkRowsWritten(updatedRows).wroteRows) {
        console.error(zeroRowWriteMessage("admin-contractor-action", `contractors.status=active for contractor ${contractor_id} (approve)`));
      }

      // Fetch contractor details (include contact_name for personal greeting)
      const { data: contractor } = await supabase
        .from("contractors")
        .select("email, company_name, contact_name")
        .eq("id", contractor_id)
        .single();

      if (contractor) {
        const greeting = contractor.contact_name || contractor.company_name || "there";

        await sendMailgunEmail(
          mailgunKey,
          mailgunDomain,
          contractor.email,
          "Otter Quotes <notifications@mail.otterquote.com>",
          "Welcome to Otter Quotes — You're Approved!",
          approvalEmailText(greeting),
          approvalEmailHtml(greeting)
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
      const { error: updateError, data: updatedRows } = await supabase
        .from("contractors")
        .update({
          status: "inactive",
          rejected_at: new Date().toISOString(),
          rejection_reason: reason,
        })
        .eq("id", contractor_id)
        .select("id");

      if (updateError) {
        throw updateError;
      }
      // gh-2105: log-only (admin-facing; the existing 500 path has no zero-row text and
      // none is added) -- a zero-row match means no contractor row was written.
      if (!checkRowsWritten(updatedRows).wroteRows) {
        console.error(zeroRowWriteMessage("admin-contractor-action", `contractors.status=inactive for contractor ${contractor_id} (reject)`));
      }

      // Fetch contractor details
      const { data: contractor } = await supabase
        .from("contractors")
        .select("email, company_name, contact_name")
        .eq("id", contractor_id)
        .single();

      if (contractor) {
        const greeting = contractor.contact_name || contractor.company_name || "there";

        await sendMailgunEmail(
          mailgunKey,
          mailgunDomain,
          contractor.email,
          "Otter Quotes <notifications@mail.otterquote.com>",
          "Otter Quotes Application — Update on Your Account",
          rejectionEmailText(greeting, reason),
          rejectionEmailHtml(greeting, reason)
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
      const { error: updateError, data: updatedRows } = await supabase
        .from("contractors")
        .update({
          insurance_verification_sent_at: new Date().toISOString(),
          insurance_verification_email: broker_email,
        })
        .eq("id", contractor_id)
        .select("id");

      if (updateError) {
        throw updateError;
      }
      // gh-2105: log-only (admin-facing; the existing 500 path has no zero-row text and
      // none is added) -- a zero-row match means no contractor row was written.
      if (!checkRowsWritten(updatedRows).wroteRows) {
        console.error(zeroRowWriteMessage("admin-contractor-action", `contractors.insurance_verification_sent_at for contractor ${contractor_id} (send_insurance_verification)`));
      }

      await sendMailgunEmail(
        mailgunKey,
        mailgunDomain,
        broker_email,
        "Otter Quotes <info@mail.otterquote.com>",
        "COI Verification Request — Otter Quotes",
        coiEmailText(contractor_company_name),
        coiEmailHtml(contractor_company_name)
      );

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: mark_license_verified ──
    if (action === "mark_license_verified") {
      const { error: updateError, data: updatedRows } = await supabase
        .from("contractors")
        .update({
          license_verified: true,
          license_verified_at: new Date().toISOString(),
        })
        .eq("id", contractor_id)
        .select("id");

      if (updateError) {
        throw updateError;
      }
      // gh-2105: log-only (admin-facing; the existing 500 path has no zero-row text and
      // none is added) -- a zero-row match means no contractor row was written.
      if (!checkRowsWritten(updatedRows).wroteRows) {
        console.error(zeroRowWriteMessage("admin-contractor-action", `contractors.license_verified for contractor ${contractor_id} (mark_license_verified)`));
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: mark_insurance_verified ──
    if (action === "mark_insurance_verified") {
      const { error: updateError, data: updatedRows } = await supabase
        .from("contractors")
        .update({
          insurance_verified: true,
          insurance_verified_at: new Date().toISOString(),
        })
        .eq("id", contractor_id)
        .select("id");

      if (updateError) {
        throw updateError;
      }
      // gh-2105: log-only (admin-facing; the existing 500 path has no zero-row text and
      // none is added) -- a zero-row match means no contractor row was written.
      if (!checkRowsWritten(updatedRows).wroteRows) {
        console.error(zeroRowWriteMessage("admin-contractor-action", `contractors.insurance_verified for contractor ${contractor_id} (mark_insurance_verified)`));
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: save_notes ──
    if (action === "save_notes") {
      const { error: updateError, data: updatedRows } = await supabase
        .from("contractors")
        .update({
          admin_notes: notes || null,
        })
        .eq("id", contractor_id)
        .select("id");

      if (updateError) {
        throw updateError;
      }
      // gh-2105: log-only (admin-facing; the existing 500 path has no zero-row text and
      // none is added) -- a zero-row match means no contractor row was written.
      if (!checkRowsWritten(updatedRows).wroteRows) {
        console.error(zeroRowWriteMessage("admin-contractor-action", `contractors.admin_notes for contractor ${contractor_id} (save_notes)`));
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
