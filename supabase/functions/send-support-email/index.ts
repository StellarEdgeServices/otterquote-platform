/**
 * Otter Quotes Edge Function: send-support-email
 * v2 — D-195: inserts support_tickets record on inbound support form submissions.
 *
 * Receives contractor support form submissions and forwards them to the
 * Otter Quotes support inbox via Mailgun.
 *
 * The destination address (dustinstohler1@gmail.com) is hardcoded here —
 * callers cannot override the recipient for security reasons.
 *
 * gh-2462 Q2: callers must present the anon/publishable key (apikey header or Bearer) or a
 * service key (platform-health-check); fields are whitelisted and length-capped; requests are
 * rate-limited per IP via check_rate_limit (rate_limit_config row 'send-support-email').
 * See caller-gate.ts.
 *
 * Environment variables required (already set in Supabase secrets):
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   SUPABASE_URL             (auto-injected by Supabase runtime)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase runtime)
 *   SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEYS (auto-injected; accepted caller keys)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { supportEmailBody } from "./templates.ts"; // gh-1824: email body moved to templates.ts (testable, no serve() import)
import {
  acceptedKeys,
  FUNCTION_NAME,
  getClientIp,
  hasAcceptedKey,
  ipToUuid,
  validatePayload,
} from "./caller-gate.ts"; // gh-2462 Q2: key gate, field whitelist, rate-limit bucket (local file: deploy path does not resolve _shared/)

const SUPPORT_DESTINATION = "dustinstohler1@gmail.com";
const MAILGUN_TIMEOUT_MS  = 10_000; // 10s — defensive; Mailgun can be slow on cold calls

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

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// gh-2462 Q2: `getEnv` / `makeClient` are injectable so caller-gate.test.ts drives the real
// handler (precedent: process-dunning/index.ts). serve() is guarded by import.meta.main.
export async function handler(
  req: Request,
  getEnv: (name: string) => string | undefined = (n) => Deno.env.get(n),
  makeClient: typeof createClient = createClient,
): Promise<Response> {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // gh-2462 Q2: the caller must present the project's anon/publishable key (or a service key)
  // in `apikey` or as the Bearer. Checked before any body read, client, Mailgun or DB I/O.
  // Fails closed when no key env is set.
  if (!hasAcceptedKey(req, acceptedKeys(getEnv))) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }

  // Health check ping — returns immediately without doing real work.
  // Called by platform-health-check every 15 minutes.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  try {
    // gh-2462 Q2: whitelist exactly the form's fields (from_name, from_email, subject,
    // message, optional user_id) with length caps; unknown/oversize -> 400 before any I/O.
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, corsHeaders);
    }
    const checked = validatePayload(rawBody);
    if (!checked.ok) return json({ error: checked.error }, 400, corsHeaders);
    const { from_name, from_email, subject, message, user_id } = checked.value;

    const supabase = makeClient(
      getEnv("SUPABASE_URL") || "",
      getEnv("SUPABASE_SERVICE_ROLE_KEY") || ""
    );

    // gh-2462 Q2: per-IP rate limit BEFORE Mailgun and the support_tickets insert. Synthetic
    // per-IP bucket, as check-email-exists. RPC error -> fail OPEN (same posture as
    // check-email-exists: a limiter hiccup must not drop a real support request);
    // explicit { allowed: false } -> 429.
    const clientIp = getClientIp(req);
    const { data: rl, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: await ipToUuid(clientIp),
    });
    if (rlError) {
      console.error(`[${FUNCTION_NAME}] rate limit check failed, failing open:`, rlError);
    } else if (!rl?.allowed) {
      console.warn(`[${FUNCTION_NAME}] RATE LIMITED ip=${clientIp}: ${rl?.reason}`);
      return json({ error: "Too many requests. Please try again later." }, 429, corsHeaders);
    }

    const MAILGUN_API_KEY = getEnv("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN  = getEnv("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured.");
    }

    // This function ONLY forwards support-form submissions to the admin inbox
    // (SUPPORT_DESTINATION) and inserts a support_ticket. The former "direct send"
    // branch (arbitrary to_email + arbitrary html) was an unauthenticated open
    // relay and has been removed (D-220 Phase 16 Unit 1b). The contractor welcome
    // email now lives in the verify_jwt'd send-welcome-email Edge Function.
    const recipient = SUPPORT_DESTINATION;

    const emailSubject = subject
      ? `[Otter Quotes Support] ${subject}`
      : `[Otter Quotes Support] Message from ${from_name}`;

    const emailBody = supportEmailBody(from_name, from_email, subject, message); // gh-1824

    const from = `Otter Quotes Support <noreply@${MAILGUN_DOMAIN}>`;

    // Strip CR/LF from caller-supplied fields before they enter the h:Reply-To
    // header, to prevent SMTP header injection.
    const replyToName  = (from_name  || "").replace(/[\r\n]+/g, " ").trim();
    const replyToEmail = (from_email || "").replace(/[\r\n]+/g, "").trim();

    const formData = new URLSearchParams();
    formData.append("from",    from);
    formData.append("to",      recipient);
    formData.append("subject", emailSubject);
    formData.append("text",    emailBody);
    formData.append("h:Reply-To", `${replyToName} <${replyToEmail}>`);

    // ── Mailgun call with 10-second AbortController timeout ──────────────────
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), MAILGUN_TIMEOUT_MS);

    let mailgunResult: { id: string };
    try {
      const mailgunResponse = await fetch(
        `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
          },
          body: formData,
          signal: controller.signal,
        }
      );
      clearTimeout(timeoutId);

      if (!mailgunResponse.ok) {
        const errorData = await mailgunResponse.text();
        console.error("Mailgun error:", mailgunResponse.status, errorData);
        throw new Error(`Mailgun API error (HTTP ${mailgunResponse.status}): ${errorData}`);
      }
      mailgunResult = await mailgunResponse.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === "AbortError") {
        throw new Error("Mailgun request timed out after 10 seconds.");
      }
      throw err;
    }

    console.log("Email sent. Mailgun ID:", mailgunResult.id, "To:", recipient);

    // ── D-195: Insert support_ticket record for inbound support form submissions ──
    // Non-blocking: email was already sent; a DB failure here must not fail the response.
    try {
      const { error: insertError } = await supabase
        .from("support_tickets")
        .insert({
          source:     "form",
          from_name,
          from_email,
          subject:    subject || null,
          body:       message,
          user_id:    user_id || null,
          status:     "open",
          priority:   "normal",
        });
      if (insertError) {
        console.error("D-195: Failed to insert support_ticket:", insertError.message);
      } else {
        console.log("D-195: support_ticket inserted for", from_email);
      }
    } catch (dbErr) {
      console.error("D-195: support_ticket insert exception:", dbErr);
    }

    return new Response(
      JSON.stringify({ status: "sent", id: mailgunResult.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("send-support-email error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

if (import.meta.main) {
  serve((req) => handler(req));
}
