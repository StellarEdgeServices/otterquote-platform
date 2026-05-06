/**
 * Otter Quotes Edge Function: send-message-notification
 *
 * Sends an email notification when a new message is posted in a claim thread.
 *
 * Called when:
 *   - A homeowner or contractor posts a message via the messaging UI
 *   - Recipient is the other party (contractor if sender is homeowner, vice versa)
 *
 * Input:
 *   POST { message_id: string }
 *
 * Returns:
 *   { success: true, notification_sent: boolean, recipient_email: string }
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "send-message-notification";
const DASHBOARD_URL = "https://otterquote.com/dashboard";
const CONTRACTOR_DASHBOARD_URL = "https://otterquote.com/contractor-dashboard.html";

// CORS allowlist
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

function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #333; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: #001D3D; color: #fff; padding: 24px 32px; }
    .content { padding: 32px; }
    .footer { background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 20px 32px; text-align: center; font-size: 13px; color: #64748B; }
    a { color: #0EA5E9; text-decoration: none; }
    .button { display: inline-block; background: #14B8A6; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">Otter Quotes</h2>
    </div>
    <div class="content">
      ${bodyHtml}
    </div>
    <div class="footer">
      <p style="margin: 0 0 12px 0;">Need help? Contact <a href="mailto:support@otterquote.com">support@otterquote.com</a> or call (844) 875-3412</p>
    </div>
  </div>
</body>
</html>`;
}

async function sendMailgunEmail(
  recipientEmail: string,
  senderName: string,
  subject: string,
  htmlBody: string
): Promise<boolean> {
  const apiKey = Deno.env.get("MAILGUN_API_KEY");
  const domain = Deno.env.get("MAILGUN_DOMAIN");

  if (!apiKey || !domain) {
    console.error("Missing Mailgun credentials");
    return false;
  }

  const formData = new FormData();
  formData.append("from", `Otter Quotes <no-reply@${domain}>`);
  formData.append("to", recipientEmail);
  formData.append("subject", subject);
  formData.append("html", htmlBody);

  try {
    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Mailgun error (${response.status}): ${error}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Mailgun request failed: ${error.message}`);
    return false;
  }
}

async function handleRequest(req: Request): Promise<Response> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders(req),
    });
  }

  // Only POST allowed
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: {
          ...buildCorsHeaders(req),
          "Content-Type": "application/json",
        },
      }
    );
  }

  try {
    const body = await req.json();
    const messageId = body.message_id;

    if (!messageId) {
      return new Response(
        JSON.stringify({ error: "message_id is required" }),
        {
          status: 400,
          headers: {
            ...buildCorsHeaders(req),
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase credentials");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch the message and related data
    const { data: message, error: messageError } = await supabase
      .from("messages")
      .select(
        `
        id,
        claim_id,
        sender_id,
        sender_role,
        body,
        created_at,
        claims:claim_id (
          id,
          user_id,
          selected_trades
        ),
        profiles:sender_id (
          id,
          full_name,
          email
        )
      `
      )
      .eq("id", messageId)
      .single();

    if (messageError || !message) {
      console.error("Message not found:", messageError);
      return new Response(
        JSON.stringify({ error: "Message not found" }),
        {
          status: 404,
          headers: {
            ...buildCorsHeaders(req),
            "Content-Type": "application/json",
          },
        }
      );
    }

    const claim = message.claims;
    const senderProfile = message.profiles;

    // Determine recipient based on sender role
    let recipientId: string;
    let recipientRole: string;
    let dashboardUrl: string;

    if (message.sender_role === "homeowner") {
      // Sender is homeowner, find the contractor
      const { data: quote, error: quoteError } = await supabase
        .from("quotes")
        .select("contractor_id, contractors:contractor_id(user_id, profiles:profiles(email, full_name))")
        .eq("claim_id", claim.id)
        .eq("status", "awarded")
        .single();

      if (quoteError || !quote) {
        console.log("No awarded contractor found for this claim");
        return new Response(
          JSON.stringify({ success: true, notification_sent: false, reason: "no_awarded_contractor" }),
          {
            status: 200,
            headers: {
              ...buildCorsHeaders(req),
              "Content-Type": "application/json",
            },
          }
        );
      }

      recipientId = quote.contractors.user_id;
      recipientRole = "contractor";
      dashboardUrl = CONTRACTOR_DASHBOARD_URL;

      // Get contractor profile for email
      const { data: contractorProfile, error: contractorError } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("id", recipientId)
        .single();

      if (contractorError || !contractorProfile) {
        console.error("Contractor profile not found");
        return new Response(
          JSON.stringify({ error: "Recipient not found" }),
          {
            status: 404,
            headers: {
              ...buildCorsHeaders(req),
              "Content-Type": "application/json",
            },
          }
        );
      }

      // Send email to contractor
      const subject = "You have a new message on your Otter Quotes project";
      const htmlBody = buildEmail(`
        <p>Hi ${contractorProfile.full_name},</p>
        <p>You have a new message from <strong>${senderProfile.full_name}</strong> regarding your project.</p>
        <p><strong>Message preview:</strong></p>
        <blockquote style="border-left: 4px solid #14B8A6; padding-left: 16px; margin: 16px 0; color: #666;">
          ${escapeHtml(message.body.substring(0, 200))}${message.body.length > 200 ? "..." : ""}
        </blockquote>
        <p>
          <a href="${dashboardUrl}" class="button">View Message</a>
        </p>
        <p>Log in to Otter Quotes to read and reply to the full message.</p>
      `);

      const emailSent = await sendMailgunEmail(
        contractorProfile.email,
        senderProfile.full_name,
        subject,
        htmlBody
      );

      return new Response(
        JSON.stringify({
          success: true,
          notification_sent: emailSent,
          recipient_email: contractorProfile.email,
        }),
        {
          status: 200,
          headers: {
            ...buildCorsHeaders(req),
            "Content-Type": "application/json",
          },
        }
      );
    } else {
      // Sender is contractor, find the homeowner
      const { data: homeownerProfile, error: homeownerError } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("id", claim.user_id)
        .single();

      if (homeownerError || !homeownerProfile) {
        console.error("Homeowner profile not found");
        return new Response(
          JSON.stringify({ error: "Recipient not found" }),
          {
            status: 404,
            headers: {
              ...buildCorsHeaders(req),
              "Content-Type": "application/json",
            },
          }
        );
      }

      // Send email to homeowner
      const subject = "You have a new message on your Otter Quotes project";
      const htmlBody = buildEmail(`
        <p>Hi ${homeownerProfile.full_name},</p>
        <p>You have a new message from <strong>${senderProfile.full_name}</strong> regarding your project.</p>
        <p><strong>Message preview:</strong></p>
        <blockquote style="border-left: 4px solid #14B8A6; padding-left: 16px; margin: 16px 0; color: #666;">
          ${escapeHtml(message.body.substring(0, 200))}${message.body.length > 200 ? "..." : ""}
        </blockquote>
        <p>
          <a href="${dashboardUrl}" class="button">View Message</a>
        </p>
        <p>Log in to Otter Quotes to read and reply to the full message.</p>
      `);

      const emailSent = await sendMailgunEmail(
        homeownerProfile.email,
        senderProfile.full_name,
        subject,
        htmlBody
      );

      return new Response(
        JSON.stringify({
          success: true,
          notification_sent: emailSent,
          recipient_email: homeownerProfile.email,
        }),
        {
          status: 200,
          headers: {
            ...buildCorsHeaders(req),
            "Content-Type": "application/json",
          },
        }
      );
    }
  } catch (error) {
    console.error(`${FUNCTION_NAME} error:`, error);
    return new Response(
      JSON.stringify({ error: `Internal server error: ${error.message}` }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}

// Helper function to escape HTML
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

serve(handleRequest);
