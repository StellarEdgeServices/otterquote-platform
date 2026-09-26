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
 *   META_LEADGEN_FORM_ALLOWLIST — JSON form_id -> {agent_type, funnel_id, is_test?} (PARTNER forms)
 *   META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST — JSON form_id -> {funnel_id,
 *     is_test?, consent_key, consent_text, privacy_url} (#2123 HO-2 — a
 *     SEPARATE allowlist for homeowner `leads` forms). consent_key/
 *     consent_text/privacy_url are REQUIRED per entry (REVIEW FAIL
 *     5849223003 defects 4/5, D-299/D-332) -- an entry missing any of them
 *     is dropped and logged as a config error, see homeowner-allowlist.ts.
 *     A form_id checked against the partner allowlist first, then this one;
 *     a form_id in neither is always a logged skip, no write. See
 *     handler.ts's routing comment and homeowner-allowlist.ts's header for
 *     why this is a distinct secret rather than a widened shared one.
 *
 * #2123 HO-2 fix round (REVIEW: FAIL + LEGAL-READ: FAIL, issue comment
 * 5849223003) — summary of what changed in this revision, see each site's
 * own comment for the full reasoning:
 *   1. Homeowner registration now REQUIRES email (live leads.email is NOT
 *      NULL) -- see handler.ts's incomplete_fields check.
 *   2. sql/schema-snapshot.json and sql/schema-pending.json were corrected
 *      (is_synthetic is live; meta_lead_id is declared pending against its
 *      own migration).
 *   3. The old set_lead_role() RPC call is gone from the homeowner path,
 *      replaced by a service-role conditional UPDATE with no time window
 *      -- see finalizeHomeownerLead below.
 *   4. D-299 consent evidence (a `lead_consents` row, written the same way
 *      Arm F's record_lead_details() does) is captured before role is ever
 *      set -- see fetchHomeownerLeadFromGraph and finalizeHomeownerLead.
 *   5. D-332: privacy_url is now a required allowlist field; see this PR's
 *      body for the required Meta form config and the privacy.html read.
 *   6. change.value.ad_id/adgroup_id (the signed webhook payload) become
 *      utm_content/utm_term on the `leads` row.
 *   7. isSynthetic also covers a founder/internal/QA email, parity with
 *      Arm F's own exclusion -- see founder-filter.ts.
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
  isDataRejectionError,
  type FetchedLead,
  type HomeownerDuplicateResult,
  type RegisterHomeownerLeadArgs,
  type RegisterPartnerArgs,
  type WebhookDeps,
} from "./handler.ts";
import type { FetchedHomeownerLead, HomeownerConsentArgs } from "./homeowner-consent.ts";
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

/**
 * #2123 HO-2 fix round (REVIEW FAIL 5849223003 defect 4(a)) — a SEPARATE
 * Graph fetch from the partner path's fetchLeadFromGraph above, requesting
 * the extra fields D-299 consent evidence and attribution need. The partner
 * fetch above is left byte-identical.
 */
async function fetchHomeownerLeadFromGraph(
  leadgenId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ data: FetchedHomeownerLead | null; error: string | null }> {
  try {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(leadgenId)}` +
      `?fields=field_data,custom_disclaimer_responses,created_time,form_id,ad_id,campaign_id,platform`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      return { data: null, error: `graph_api_${res.status}` };
    }
    const data = (await res.json()) as FetchedHomeownerLead;
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * #2123 HO-2 fix round (REVIEW FAIL 5849223003 defects 3 + 4) — the shared
 * "finish the job" step for a freshly-inserted `leads` row or a recovered
 * existing one. Writes the D-299 `lead_consents` evidence row BEFORE the
 * role update (Ben's ruling on #2122 comment 5803979399 applies here too: a
 * consent record lost between the two writes is a compliance failure, so
 * consent goes first and role is never set if it fails), then does a
 * SERVICE-ROLE CONDITIONAL UPDATE in place of the old set_lead_role() RPC
 * call -- see finalizeHomeownerLead's doc comment on WebhookDeps in
 * handler.ts for why the RPC's 30-minute window made this unrecoverable.
 */
// Typed loosely (not a bound SupabaseClient parameter) — mirrors record-
// lead-details/index.ts's own `rpc: (name, args) => sb.rpc(name, args) as
// unknown as Promise<...>` convention (that file's header comment explains
// why: passing the concrete client through an extra function boundary loses
// supabase-js's per-call-site generic inference and does not type-check).
async function finalizeHomeownerLead(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  leadId: string,
  metaLeadId: string,
  consent: HomeownerConsentArgs,
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const { error: consentErr } = await supabase.from("lead_consents").insert({
    lead_id: leadId,
    consent_key: consent.consentKey,
    consent_given: consent.consentGiven,
    consent_text: consent.consentText,
    page_url: `meta-lead-form:${consent.formId}`,
    user_agent: null,
    ip: null,
    payload: {
      source: "meta_leadgen",
      leadgen_id: metaLeadId,
      form_id: consent.formId,
      ad_id: consent.adId,
      campaign_id: consent.campaignId,
      created_time: consent.createdTime,
    },
    phone_as_typed: consent.phoneAsTyped,
    form_payload: consent.formPayload,
  });
  if (consentErr) {
    // lead_consents_lead_key_uniq (lead_id, consent_key) -- a retry of this
    // same finalize step (e.g. a prior attempt wrote consent but then
    // failed on the role update below) hits 23505 here; that means the
    // evidence is ALREADY written, not an error -- same idempotent-retry
    // posture record_lead_details()'s own ON CONFLICT DO NOTHING gives Arm F.
    const consentErrCode = (consentErr as { code?: string }).code;
    if (consentErrCode !== "23505") {
      // REVIEW FAIL 5849684429 fix 3: a permanent data-rejection error
      // (23502/23514/any other 22xxx-23xxx except 23505) on the
      // lead_consents insert is terminal, not transient -- see
      // isDataRejectionError's doc comment in handler.ts.
      if (isDataRejectionError(consentErrCode)) {
        return { updated: false, error: { message: "rejected_invalid_data" } };
      }
      return { updated: false, error: { message: consentErr.message } };
    }
  }

  const { data, error } = await supabase
    .from("leads")
    .update({ role: "homeowner" })
    .eq("id", leadId)
    .eq("meta_lead_id", metaLeadId)
    .is("role", null)
    .select("id");
  if (error) {
    return { updated: false, error: { message: error.message } };
  }
  return { updated: Array.isArray(data) && data.length > 0, error: null };
}

if (import.meta.main) {
  serve(async (req: Request) => {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const verifyToken = Deno.env.get("META_LEADGEN_VERIFY_TOKEN") || undefined;
    const appSecret = Deno.env.get("META_APP_SECRET") || undefined;
    const pageAccessToken = Deno.env.get("META_PAGE_ACCESS_TOKEN") || undefined;
    const allowlistRaw = Deno.env.get("META_LEADGEN_FORM_ALLOWLIST") || undefined;
    // #2123 HO-2: separate secret from the partner allowlist above — see
    // homeowner-allowlist.ts's header for why this is a distinct env var
    // rather than a widened shared one.
    const homeownerAllowlistRaw = Deno.env.get("META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST") || undefined;

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
      homeownerAllowlistRaw,
      fetchLead: (leadgenId, token) => fetchLeadFromGraph(leadgenId, token, fetch),
      fetchHomeownerLead: (leadgenId, token) => fetchHomeownerLeadFromGraph(leadgenId, token, fetch),
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
      // #2123 HO-2 — dedupe read on public.leads.meta_lead_id (new column,
      // this build's migration — see the migration file's header for why
      // it's additive-only). Also reports whether `role` is already set on
      // an existing row, so handler.ts can recover a lead whose insert
      // succeeded on a prior delivery but whose set_lead_role() call did
      // not (see RegisterHomeownerLeadArgs's doc comment in handler.ts).
      isDuplicateHomeownerLead: async (metaLeadId): Promise<HomeownerDuplicateResult> => {
        const { data, error } = await supabase
          .from("leads")
          .select("id, role")
          .eq("meta_lead_id", metaLeadId)
          .limit(1);
        if (error) {
          console.error(`${FUNCTION_NAME}: homeowner duplicate check failed`);
          return { existingId: null, roleSet: false, errored: true };
        }
        const row = data && data.length > 0 ? (data[0] as { id: string; role: string | null }) : null;
        return { existingId: row?.id ?? null, roleSet: row?.role != null, errored: false };
      },
      // #2123 HO-2 — INSERT into `leads` then set_lead_role(id, 'homeowner'),
      // the exact same RPC and the exact same role-set-fires-the-alert
      // mechanism js/router-variant-f.js's own Step 2 already relies on
      // (gh-1994's trg_notify_admin_new_router_lead, AFTER UPDATE ON leads
      // WHEN role transitions NULL -> non-NULL). The INSERT alone is never
      // enough: public.leads_force_safe_insert_defaults() (an existing,
      // unconditional BEFORE INSERT guard — see gh-1994's and gh-1994's
      // router-lead-alert migrations) forces role back to NULL on every
      // insert regardless of caller, service_role included, specifically so
      // no insert path (anon or otherwise) can set role directly and either
      // bypass validation or suppress its own alert.
      //
      // `source` is set to 'meta_leadgen' and `variant` to the funnel id
      // (e.g. 'ho-2') — `variant` already carries the Arm-F-style funnel/arm
      // id for router leads (gh-2011) and has no CHECK constraint (a
      // deliberate choice on that column, see gh2011_leads_variant.sql: a
      // measurement column must never be able to reject a revenue record),
      // so it is reused here rather than adding a new funnel_id column to
      // `leads`. utm_campaign is also set to the funnel id per this task's
      // S14 naming convention (utm_campaign=<line>-<funnel>); utm_source/
      // utm_medium are set to fixed 'meta'/'lead_form' values because a
      // native Meta lead form's webhook payload carries no UTM parameters
      // of its own for those two, but utm_content/utm_term ARE forwarded
      // from the signed webhook payload's ad_id/adgroup_id (REVIEW FAIL
      // 5849223003 item 6). REVIEW FAIL defect 3: this call is INSERT ONLY
      // now -- role is set by the separate finalizeHomeownerLead() step
      // (handler.ts calls it right after a successful insert), so consent
      // evidence can be written before role is ever touched.
      registerHomeownerLead: async (args: RegisterHomeownerLeadArgs) => {
        const { data: inserted, error: insErr } = await supabase
          .from("leads")
          .insert({
            name: args.name,
            email: args.email,
            phone: args.phone,
            source: "meta_leadgen",
            variant: args.funnelId,
            utm_source: "meta",
            utm_medium: "lead_form",
            utm_campaign: args.funnelId,
            utm_content: args.utmContent,
            utm_term: args.utmTerm,
            is_synthetic: args.isSynthetic,
            meta_lead_id: args.metaLeadId,
          })
          .select("id")
          .single();
        if (insErr) {
          // Postgres unique_violation (leads.meta_lead_id UNIQUE, this
          // build's migration) — mirrors register_partner()'s own
          // duplicate_meta_lead convention above so handler.ts's string
          // match handles both paths identically.
          const insErrCode = (insErr as { code?: string }).code;
          if (insErrCode === "23505") {
            return { data: null, error: { message: "duplicate_meta_lead" } };
          }
          // REVIEW FAIL 5849684429 fix 3: a permanent data-rejection error
          // (23502 not_null_violation, 23514 check_violation, or any other
          // 22xxx/23xxx except 23505) on the leads insert is terminal --
          // never a 503 retry -- see isDataRejectionError's doc comment in
          // handler.ts.
          if (isDataRejectionError(insErrCode)) {
            return { data: null, error: { message: "rejected_invalid_data" } };
          }
          return { data: null, error: { message: insErr.message } };
        }
        const newId = (inserted as { id?: string } | null)?.id;
        if (!newId) {
          return { data: null, error: { message: "insert_returned_no_id" } };
        }
        return { data: { id: newId }, error: null };
      },
      // #2123 HO-2 fix round — see finalizeHomeownerLead's own doc comment
      // above (defects 3 + 4): shared by both the fresh-insert path and the
      // recovery path in handler.ts.
      finalizeHomeownerLead: (leadId, metaLeadId, consent) =>
        finalizeHomeownerLead(supabase, leadId, metaLeadId, consent),
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
