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

const GRAPH_API_VERSION = "v21.0";

async function fetchLeadFromGraph(
  leadgenId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ data: FetchedLead | null; error: string | null }> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(leadgenId)}` +
      `?fields=field_data&access_token=${encodeURIComponent(token)}`;
    const res = await fetchImpl(url);
    if (!res.ok) {
      // Never logs the response body — it can echo back the access_token query param.
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

    const rawBody = await req.text();
    const signatureHeader = req.headers.get("X-Hub-Signature-256");
    const clientIp = getClientIp(req);

    const deps: WebhookDeps = {
      verifyToken,
      appSecret,
      pageAccessToken,
      allowlistRaw,
      fetchLead: (leadgenId, token) => fetchLeadFromGraph(leadgenId, token, fetch),
      isDuplicate: async (leadgenId) => {
        const { data, error } = await supabase
          .from("referral_agents")
          .select("id")
          .eq("meta_lead_id", leadgenId)
          .limit(1);
        if (error) {
          console.error(`${FUNCTION_NAME}: duplicate check failed — treating as duplicate (fail closed, no double-write)`);
          return true;
        }
        return Boolean(data && data.length > 0);
      },
      registerPartner: async (args: RegisterPartnerArgs) => {
        const { error } = await supabase.rpc("register_partner", {
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
        return { error: error ? { message: error.message } : null };
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

    const { response } = await handlePost(rawBody, signatureHeader, clientIp, deps);
    return response;
  });
}
