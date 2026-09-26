/**
 * OtterQuote Edge Function: meta-leadgen-webhook
 *
 * gh-2154 P-5 — Meta Lead Ads webhook. PARTNER PATH ONLY (Kevin's Q comment
 * on #2154). Inert until secrets exist: with no META_LEADGEN_VERIFY_TOKEN
 * the handshake always 403s, and with no META_APP_SECRET every POST 401s
 * before anything is read or written.
 *
 * GET  — Meta's subscribe handshake: hub.mode=subscribe + a matching
 *        hub.verify_token gets hub.challenge echoed back as text/plain 200.
 *        Anything else, or an unset verify token, is 403.
 * POST — the leadgen event notification. The raw body is verified against
 *        X-Hub-Signature-256 (HMAC-SHA256 of the raw body, app secret,
 *        constant-time compare) BEFORE anything else runs — see handler.ts.
 *        Each entry[].changes[].value with a leadgen_id/form_id is: skipped
 *        (not allowlisted / already processed / no page token / fetch
 *        failed / incomplete fields) or written via register_partner(),
 *        the exact same RPC + semantics P-1's short signup uses.
 *
 * verify_jwt = false in config.toml: Meta cannot send a Supabase JWT. The
 * X-Hub-Signature-256 signature verification in handler.ts/signature.ts IS
 * the authentication for this endpoint — see this build's report for the
 * full reasoning (same shape as check-email-exists's own verify_jwt=false
 * precedent, which authenticates a different way in-handler instead).
 *
 * Environment variables (Supabase secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY           (already set)
 *   META_LEADGEN_VERIFY_TOKEN   — GET handshake token
 *   META_APP_SECRET             — HMAC key for X-Hub-Signature-256
 *   META_PAGE_ACCESS_TOKEN      — Graph API GET /{leadgen_id} bearer
 *   META_LEADGEN_FORM_ALLOWLIST — JSON form_id -> {agent_type, funnel_id, is_test?}
 *
 * Never logs raw lead PII or any secret/token — only leadgen_id + outcome.
 *
 * gh-2154 P-5
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  FUNCTION_NAME,
  getClientIp,
  handlePost,
  handleVerification,
  interpretRateLimitResult,
  type FetchedLead,
  type RegisterPartnerArgs,
  type WebhookDeps,
} from "./handler.ts";
import { buildInviteEmail, isInviteEmailEnabled, PARTNER_INVITE_EMAIL_ENABLED_ENV } from "./invite-email.ts";
import { PARTNER_INVITE_SECRET_ENV, signPartnerInviteToken } from "./invite-token.ts";
import { buildPartnerOptOutUrl, canSendWithOptOut, PARTNER_OPTOUT_SECRET_ENV, signPartnerOptOutToken } from "./optout.ts";

const GRAPH_API_VERSION = "v21.0";
const SITE_BASE_URL = "https://otterquote.com";

/**
 * gh-2154 P-5r (LEGAL-READ FAIL 5833717530) — sends the invite email for a
 * newly-created 'pending' Meta-lead partner. Guarded three ways, all OFF by
 * default: PARTNER_INVITE_EMAIL_ENABLED must be exactly "true" (the brief's
 * required send switch, defaulting OFF), PARTNER_INVITE_SECRET must be set
 * (no verifiable accept link can be built without it -- same canSignInvite
 * posture as D-320's canSendWithOptOut), and (gh-2154 P-5 go-live, item 1)
 * PARTNER_ONBOARDING_OPTOUT_SECRET must ALSO be set -- "the sender refuses
 * to send without it" (this task's own brief): no verifiable unsubscribe
 * link, no send at all, same CAN-SPAM posture P-4's own sender already has.
 * Best-effort: any failure here is caught by the caller in handler.ts and
 * only logged, never turned into a webhook retry.
 */
async function sendPartnerInvite(
  supabaseUrl: string,
  serviceRoleKey: string,
  args: { referralAgentId: string; email: string; firstName: string; agentType: string },
): Promise<void> {
  if (!isInviteEmailEnabled(Deno.env.get(PARTNER_INVITE_EMAIL_ENABLED_ENV))) {
    return;
  }
  const secret = Deno.env.get(PARTNER_INVITE_SECRET_ENV) || "";
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY") || "";
  const optOutSecret = Deno.env.get(PARTNER_OPTOUT_SECRET_ENV) || "";
  if (!secret || !mailgunApiKey || !canSendWithOptOut(optOutSecret)) {
    console.warn(`${FUNCTION_NAME}: PARTNER_INVITE_EMAIL_ENABLED=true but a required secret or Mailgun key is unset — no invite sent`);
    return;
  }
  const token = await signPartnerInviteToken(args.referralAgentId, secret);
  const optOutToken = await signPartnerOptOutToken(args.referralAgentId, optOutSecret);
  const functionsBaseUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1`;
  const optOutUrl = buildPartnerOptOutUrl(functionsBaseUrl, optOutToken);
  const email = buildInviteEmail(args.firstName, args.agentType, SITE_BASE_URL, token, optOutUrl);

  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", args.email);
  formData.append("subject", email.subject);
  formData.append("text", email.text);
  formData.append("html", email.html);
  // gh-2154 P-5 go-live item 1: RFC 8058 mailbox-provider one-click surface,
  // same pattern send-partner-onboarding/index.ts's own sendMailgunEmail
  // already uses.
  formData.append("h:List-Unsubscribe", `<${optOutUrl}>`);
  formData.append("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  const res = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${mailgunApiKey}`)}` },
    body: formData,
  });
  if (!res.ok) {
    console.error(`${FUNCTION_NAME}: invite email send failed, Mailgun status ${res.status}`);
  }
}

async function fetchLeadFromGraph(
  leadgenId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ data: FetchedLead | null; error: string | null }> {
  try {
    // gh-2154 P-5r (REVIEW SHOULD-FIX, taken): the page access token now
    // rides in the Authorization header, not the query string. The query
    // string is the one part of a URL that routinely ends up in access
    // logs, proxy logs, and (per the prior header's note) any future
    // `fetched.error`-adjacent log line that includes the request URL --
    // moving the token out of it removes that class of leak outright rather
    // than relying on "nothing logs it today" staying true forever.
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(leadgenId)}?fields=field_data`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      // Never logs the response body — Graph error bodies can echo request context back.
      return { data: null, error: `graph_api_${res.status}` };
    }
    const data = (await res.json()) as FetchedLead;
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

if (import.meta.main) {
  serve(async (req: Request) => {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const verifyToken = Deno.env.get("META_LEADGEN_VERIFY_TOKEN") || undefined;
    const appSecret = Deno.env.get("META_APP_SECRET") || undefined;
    const pageAccessToken = Deno.env.get("META_PAGE_ACCESS_TOKEN") || undefined;
    const allowlistRaw = Deno.env.get("META_LEADGEN_FORM_ALLOWLIST") || undefined;

    if (!supabaseUrl || !serviceRoleKey) {
      console.error(`${FUNCTION_NAME}: missing required Supabase environment variables`);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (req.method === "GET") {
      const url = new URL(req.url);
      return handleVerification(url, {
        verifyToken,
        log: (level, message) => console[level](message),
      });
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // gh-2154 P-5r (REVIEW SHOULD-FIX, taken): raw bytes, not req.text(), go
    // into signature verification (handler.ts/signature.ts now accept
    // either) -- byte-exact against what Meta signed. The decoded text is
    // still what gets JSON.parse'd downstream (handler.ts decodes it once,
    // internally).
    const rawBytes = new Uint8Array(await req.arrayBuffer());
    const signatureHeader = req.headers.get("X-Hub-Signature-256");
    const clientIp = getClientIp(req);

    const deps: WebhookDeps = {
      verifyToken,
      appSecret,
      pageAccessToken,
      allowlistRaw,
      fetchLead: (leadgenId, token) => fetchLeadFromGraph(leadgenId, token, fetch),
      // gh-2154 P-5r (REVIEW FAIL 5833742114 must-fix 1): a dedupe-read DB
      // error is no longer collapsed into "yes, duplicate" -- that silently
      // and permanently dropped the lead. `errored: true` tells handler.ts
      // to fail this delivery non-2xx so Meta retries instead.
      isDuplicate: async (leadgenId) => {
        const { data, error } = await supabase
          .from("referral_agents")
          .select("id")
          .eq("meta_lead_id", leadgenId)
          .limit(1);
        if (error) {
          console.error(`${FUNCTION_NAME}: duplicate check failed`);
          return { duplicate: false, errored: true };
        }
        return { duplicate: Boolean(data && data.length > 0), errored: false };
      },
      registerPartner: async (args: RegisterPartnerArgs) => {
        const { data, error } = await supabase.rpc("register_partner", {
          p_agent_type: args.agentType,
          p_first_name: args.firstName,
          p_last_name: args.lastName,
          p_email: args.email,
          p_phone: args.phone,
          p_company: args.company,
          p_is_test: args.isTest,
          p_funnel_id: args.funnelId,
          p_meta_lead_id: args.metaLeadId,
        });
        return {
          data: data && typeof data === "object" ? (data as { id?: string }) : null,
          error: error ? { message: error.message } : null,
        };
      },
      sendInvite: async ({ referralAgentId, email, firstName, agentType }) => {
        await sendPartnerInvite(supabaseUrl, serviceRoleKey, { referralAgentId, email, firstName, agentType });
      },
      checkRateLimit: async (bucket) => {
        const { data, error } = await supabase.rpc("check_rate_limit", {
          p_function_name: FUNCTION_NAME,
          p_user_id: bucket,
        });
        // Fails CLOSED on an RPC error or an unexpected response shape — see
        // interpretRateLimitResult's doc comment in handler.ts for why this
        // is safe for a Meta webhook specifically (non-2xx -> Meta retries;
        // meta_lead_id UNIQUE + isDuplicate() keep the retry idempotent).
        return interpretRateLimitResult(data, error ? { message: error.message } : null);
      },
      log: (level, message) => console[level](message),
    };

    const { response } = await handlePost(rawBytes, signatureHeader, clientIp, deps);
    return response;
  });
}
