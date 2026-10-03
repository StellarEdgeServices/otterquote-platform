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
 *   { success: true, notification_sent: boolean }
 *   (gh-2462: recipient_email is NEVER returned; the caller is not entitled to it.)
 *
 * Auth (gh-2462): supabase/config.toml sets verify_jwt = false for this function, so the
 *   gate is in this file. Callers are the browser messaging UIs only (dashboard.html,
 *   contractor-dashboard.html, react-app Messaging.tsx, and the homeowner
 *   functions.invoke path); there is NO DB-trigger/pg_net caller in supabase/migrations.
 *   Accepted credentials, checked BEFORE any DB read or Mailgun call:
 *     - a service bearer (runtime SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS.default), or
 *     - a user access token (JWT) whose user is the message's sender_id (else 403).
 *   Anything else is 401. Rate-limited per sender_id to prevent notification spam.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_SECRET_KEYS (optional; .default accepted as a service bearer)
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  acceptedServiceKeys,
  bearerToken,
  deny,
  type GetEnv,
  hasServiceBearer,
  looksLikeJwt,
} from "./caller-gate.ts"; // gh-2462 (local copy; the deploy path does not resolve _shared/)
import {
  contractorBoundSenderLabel,
  messageNotificationHtml,
  messageNotificationText,
  MESSAGE_NOTIFICATION_SUBJECT,
} from "./templates.ts"; // gh-1824: footer moved to templates.ts (testable, no serve() import)

// gh-2462: the service-role client is typed `any`, as process-dunning's and notify-contractors'
// are (gh-2309). The handler is now imported by caller-gate.test.ts, so this file is type-checked
// in CI for the first time; with no generated Database types, supabase-js types the embedded
// joins (claims, quotes.contractors, profiles) as arrays and the row reads fail TS2339.
// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

const FUNCTION_NAME = "send-message-notification";
const DASHBOARD_URL = "https://otterquote.com/dashboard.html"; // gh-2462: same URL docusign-webhook uses
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

async function sendMailgunEmail(
  getEnv: GetEnv,
  recipientEmail: string,
  _senderName: string, // unused (lint); kept for call-site stability
  subject: string,
  htmlBody: string,
  textBody: string
): Promise<boolean> {
  const apiKey = getEnv("MAILGUN_API_KEY");
  const domain = getEnv("MAILGUN_DOMAIN");

  if (!apiKey || !domain) {
    console.error("Missing Mailgun credentials");
    return false;
  }

  const formData = new FormData();
  formData.append("from", `Otter Quotes <no-reply@${domain}>`);
  formData.append("to", recipientEmail);
  formData.append("subject", subject);
  formData.append("html", htmlBody);
  formData.append("text", textBody);

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
    console.error(`Mailgun request failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// gh-2462: exported so caller-gate.test.ts drives the REAL handler (serve() is guarded by
// import.meta.main). `getEnv` defaults to Deno.env.get; `makeClient` to createClient.
export async function handler(
  req: Request,
  getEnv: GetEnv = (n) => Deno.env.get(n),
  makeClient: typeof createClient = createClient,
): Promise<Response> {
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
    // gh-2462 caller gate -- BEFORE the body is parsed, the client is built, or anything is
    // read or sent. A service bearer passes; otherwise the bearer must be a user JWT, which
    // is resolved to a user below (and must be the message's sender after the load).
    const isService = hasServiceBearer(req, acceptedServiceKeys(getEnv));
    const userToken = bearerToken(req);
    if (!isService && !looksLikeJwt(userToken)) {
      console.warn(`[${FUNCTION_NAME}] 401: no service bearer or user JWT`);
      return deny(401, buildCorsHeaders(req));
    }

    // Initialize Supabase client
    const supabaseUrl = getEnv("SUPABASE_URL");
    const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase credentials");
    }

    const supabase: SupabaseLike = makeClient(supabaseUrl, supabaseKey);

    let callerUserId: string | null = null;
    if (!isService) {
      const { data: userData, error: userError } = await supabase.auth.getUser(userToken);
      callerUserId = userData?.user?.id ?? null;
      if (userError || !callerUserId) {
        console.warn(`[${FUNCTION_NAME}] 401: user token rejected by auth`);
        return deny(401, buildCorsHeaders(req));
      }
    }

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
          property_address
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

    // gh-2462: a signed-in user may only notify for a message they sent.
    if (!isService && callerUserId !== message.sender_id) {
      console.warn(`[${FUNCTION_NAME}] 403: caller is not the message sender`);
      return deny(403, buildCorsHeaders(req));
    }

    const claim = message.claims;
    const senderProfile = message.profiles;

    // Rate limit per sender — prevent notification spam
    const { data: rlData, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: message.sender_id,
    });
    if (rlError) {
      console.error(`[${FUNCTION_NAME}] Rate limit check error:`, rlError.message);
    } else if (rlData?.allowed === false) {
      return new Response(
        JSON.stringify({ success: false, notification_sent: false, reason: "rate_limited" }),
        {
          status: 429,
          headers: { ...buildCorsHeaders(req), "Content-Type": "application/json" },
        }
      );
    }

    // Determine recipient based on sender role
    let recipientId: string;
    let _recipientRole: string;
    let dashboardUrl: string;

    if (message.sender_role === "homeowner") {
      // Sender is homeowner, find the contractor
      const { data: quote, error: quoteError } = await supabase
        .from("quotes")
        // gh-2478: no contractors -> profiles foreign key exists (PGRST200); the
        // contractor profile is loaded by user_id in the query below.
        .select("contractor_id, contractors:contractor_id(user_id)")
        .eq("claim_id", claim.id)
        .eq("status", "selected")
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
      _recipientRole = "contractor";
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

      // Send email to contractor.
      // gh-2478 / Contractor Agreement 6.2 / D-277: the contractor receives no personally
      // identifiable information about the homeowner until the platform fee is collected, and
      // this runs at quote status "selected" (before the fee). Ben's ruling (exec #2304,
      // 5972464230): label the sender "the homeowner" plus the property address the contractor
      // already has, as notify-contractors does -- never profiles.full_name, never a first name
      // or initial. Every contractor-bound string below (subject, body, text, and the Mailgun
      // sender argument) is built from `senderLabel`, not senderProfile.
      const senderLabel = contractorBoundSenderLabel(claim.property_address);
      const subject = MESSAGE_NOTIFICATION_SUBJECT;
      const messagePreview = message.body.substring(0, 200);
      const messageTruncated = message.body.length > 200;
      const htmlBody = messageNotificationHtml(
        contractorProfile.full_name || "",
        senderLabel,
        messagePreview,
        messageTruncated,
        dashboardUrl
      );
      const textBody = messageNotificationText(
        contractorProfile.full_name || "",
        senderLabel,
        messagePreview,
        messageTruncated,
        dashboardUrl
      );

      const emailSent = await sendMailgunEmail(
        getEnv,
        contractorProfile.email,
        senderLabel,
        subject,
        htmlBody,
        textBody
      );

      return new Response(
        JSON.stringify({
          success: true,
          notification_sent: emailSent,
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
      dashboardUrl = DASHBOARD_URL; // was never assigned on this branch (deno check TS2454); DASHBOARD_URL was unused
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
      const subject = MESSAGE_NOTIFICATION_SUBJECT;
      const messagePreview = message.body.substring(0, 200);
      const messageTruncated = message.body.length > 200;
      const htmlBody = messageNotificationHtml(
        homeownerProfile.full_name || "",
        senderProfile.full_name || "",
        messagePreview,
        messageTruncated,
        dashboardUrl
      );
      const textBody = messageNotificationText(
        homeownerProfile.full_name || "",
        senderProfile.full_name || "",
        messagePreview,
        messageTruncated,
        dashboardUrl
      );

      const emailSent = await sendMailgunEmail(
        getEnv,
        homeownerProfile.email,
        senderProfile.full_name,
        subject,
        htmlBody,
        textBody
      );

      return new Response(
        JSON.stringify({
          success: true,
          notification_sent: emailSent,
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
      JSON.stringify({ error: `Internal server error: ${error instanceof Error ? error.message : String(error)}` }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}

if (import.meta.main) serve((req) => handler(req));
