// gh-2154 P-5 — meta-leadgen-webhook request handling, testable with
// injected fakes (same convention as record-lead-details/handler.ts and
// notify-admin-new-partner's PartnerDeps). No network, no real database in
// this file — index.ts wires the real Supabase client, Mailgun-free Graph
// API fetch, and global fetch.
//
// TWO PATHS: partner (original P-5 build, UNCHANGED below) and homeowner
// (#2123 HO-2, added by this file's gh-2154/gh-2123 revision). A form_id is
// checked against the PARTNER allowlist first (lookupForm, unchanged), then
// the HOMEOWNER allowlist (lookupHomeownerForm, new); a form_id in neither
// is always a logged skip + 200, never a write, never an error — this is
// the fallback every unknown or future form_id still gets, exactly as
// before this revision.
//
// Never logs raw lead PII (name/email/phone/company) or any token/secret —
// only leadgen_id and an outcome string.

import { verifyHandshake } from "./handshake.ts";
import { verifyMetaSignature } from "./signature.ts";
import { parseAllowlist, lookupForm, type Allowlist } from "./allowlist.ts";
import {
  parseHomeownerAllowlist,
  lookupHomeownerForm,
  type HomeownerAllowlist,
} from "./homeowner-allowlist.ts";
import { mapFieldData, type LeadFieldDatum } from "./field-mapping.ts";
import {
  buildHomeownerConsentArgs,
  type FetchedHomeownerLead,
  type HomeownerConsentArgs,
} from "./homeowner-consent.ts";
import { isFounderOrTestEmail } from "./founder-filter.ts";

export const FUNCTION_NAME = "meta-leadgen-webhook";

/** Same construction as record-lead-details's ipToUuid, namespaced to this function. */
export async function ipToUuid(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same cf-connecting-ip-first convention as record-lead-details's getClientIp. */
export function getClientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return null;
}

export interface FetchedLead {
  field_data?: LeadFieldDatum[];
}

/**
 * REVIEW FAIL 5849684429 fix 1 -- normalises a homeowner lead's phone the
 * SAME WAY Arm F does (js/router-variant-f.js's own `normalizePhone`): strip
 * every non-digit, drop a leading '1' when 11 digits remain, and keep the
 * result only if it is then exactly 10 digits. Anything else (too short, too
 * long, an international format, an extension) becomes `null` rather than
 * being inserted as-is -- live `leads_phone_length_check` caps at 20 chars
 * and Meta's `phone_number` field can exceed that or simply not be a US
 * number. Nothing is lost: the raw, as-typed value still lands in
 * `lead_consents.phone_as_typed`/`form_payload` untouched (see
 * homeowner-consent.ts's buildHomeownerConsentArgs, which reads from the
 * Graph fetch independently of this normalised value).
 */
export function normalizeHomeownerPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

/**
 * REVIEW FAIL 5849684429 fix 2 -- caps a homeowner lead's name at 200
 * characters (live `leads_name_length_check` is `char_length(name) <= 200`),
 * without splitting a UTF-16 surrogate pair at the cut point (same hazard
 * record-lead-details/handler.ts's `safeSlice` guards against: a dangling
 * high surrogate serialises to JSON as an escape Postgres rejects, which
 * would turn one long name into a request failure instead of a clean cap).
 */
export function capHomeownerName(name: string): string {
  const max = 200;
  if (name.length <= max) return name;
  let out = name.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * REVIEW FAIL 5849684429 fix 3 -- true for a Postgres data-rejection error on
 * an insert (a value the row itself will NEVER pass, no matter how many times
 * it is retried): SQLSTATE class 22 (data exception, e.g. a value that fails
 * a CHECK's implicit cast) or class 23 EXCEPT 23505 (unique_violation, which
 * is handled separately as a terminal duplicate, not a data problem) --
 * 23502 not_null_violation and 23514 check_violation are the two this task
 * targets, but any other 22xxx/23xxx (excluding 23505) is the same kind of
 * permanently-bad-data failure. A connection error, a timeout, or any other
 * SQLSTATE is NOT covered here and stays a transient 503 retry.
 */
export function isDataRejectionError(code: string | null | undefined): boolean {
  if (typeof code !== "string") return false;
  if (code.startsWith("22")) return true;
  if (code.startsWith("23") && code !== "23505") return true;
  return false;
}

export interface RegisterPartnerArgs {
  agentType: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  company: string | null;
  funnelId: string;
  isTest: boolean;
  metaLeadId: string;
}

/**
 * #2123 HO-2: the fields a homeowner `leads` row needs from a Meta lead.
 * `email` is now REQUIRED (REVIEW FAIL 5849223003 defect 1 -- live
 * `leads.email` is NOT NULL; a phone-only lead can never be inserted, see
 * handler.ts's `!mapped.email` check below). registerHomeownerLead does ONLY
 * the insert now -- consent evidence + the role update are a separate
 * finalizeHomeownerLead step (defect 3/4) shared with the recovery path.
 */
export interface RegisterHomeownerLeadArgs {
  name: string;
  email: string;
  phone: string | null;
  funnelId: string;
  isSynthetic: boolean;
  metaLeadId: string;
  /** REVIEW FAIL defect 6: change.value.ad_id from the signed webhook payload. */
  utmContent: string | null;
  /** REVIEW FAIL defect 6: change.value.adgroup_id from the signed webhook payload. */
  utmTerm: string | null;
}

/** #2123 HO-2: result of the meta_lead_id dedupe read on `leads`. */
export interface HomeownerDuplicateResult {
  /** id of the existing row, or null if none exists yet. */
  existingId: string | null;
  /** true once that existing row's role is already set (alert already fired). */
  roleSet: boolean;
  errored: boolean;
}

export interface WebhookDeps {
  verifyToken: string | undefined;
  appSecret: string | undefined;
  pageAccessToken: string | undefined;
  allowlistRaw: string | undefined;
  /** #2123 HO-2: META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST, separate from the partner allowlist above. */
  homeownerAllowlistRaw: string | undefined;
  fetchLead: (leadgenId: string, token: string) => Promise<{ data: FetchedLead | null; error: string | null }>;
  /**
   * #2123 HO-2 fix round (defect 4(a)): a SEPARATE Graph fetch from the
   * partner path's fetchLead above, so the partner fetch stays byte-
   * identical. Requests the extra fields D-299 consent evidence and
   * attribution need: custom_disclaimer_responses, created_time, form_id,
   * ad_id, campaign_id, platform -- see homeowner-consent.ts.
   */
  fetchHomeownerLead: (
    leadgenId: string,
    token: string,
  ) => Promise<{ data: FetchedHomeownerLead | null; error: string | null }>;
  /**
   * gh-2154 P-5r (LEGAL-READ FAIL 5833717530): fires (best-effort, never
   * blocks or fails the webhook response) after a successful registration
   * that created a 'pending' row, i.e. a Meta-sourced partner who now needs
   * to accept v3-2026-09 through their invite link before they are
   * activated. Optional -- when absent (e.g. index.ts's PARTNER_INVITE_
   * EMAIL_ENABLED switch is not "true"), no invite is sent and the row
   * simply waits as 'pending' for some other outreach. See
   * supabase/functions/meta-leadgen-webhook/invite-email.ts (OFF by
   * default; Dustin-approved copy, see that file's header for what is/
   * isn't wired yet).
   */
  sendInvite?: (args: { referralAgentId: string; email: string; firstName: string; agentType: string }) => Promise<void>;
  /**
   * gh-2154 P-5r (REVIEW FAIL 5833742114 must-fix 1): distinguishes a real
   * "yes, already have this leadgen_id" answer from a dedupe-READ failure.
   * Collapsing a DB error into `duplicate: true` (the pre-fix behaviour)
   * silently and PERMANENTLY drops the lead -- a transient read failure must
   * never look like a terminal skip. `errored: true` short-circuits straight
   * to a transient outcome below, never reads `duplicate`.
   */
  isDuplicate: (leadgenId: string) => Promise<{ duplicate: boolean; errored: boolean }>;
  registerPartner: (
    args: RegisterPartnerArgs,
  ) => Promise<{ data: { id?: string } | null; error: { message?: string } | null }>;
  /**
   * #2123 HO-2: dedupe read on `leads.meta_lead_id`, keyed the same way
   * isDuplicate() above keys on `referral_agents.meta_lead_id`. Also
   * reports whether the existing row's role is already set, so a lead
   * whose insert previously succeeded but whose set_lead_role() call
   * failed transiently (network blip, rate limit) can be recovered on
   * Meta's redelivery instead of being silently skipped forever once the
   * meta_lead_id UNIQUE constraint makes a second insert impossible.
   */
  isDuplicateHomeownerLead: (metaLeadId: string) => Promise<HomeownerDuplicateResult>;
  /**
   * #2123 HO-2: inserts a NEW `leads` row ONLY (role is forced NULL by the
   * table's existing BEFORE INSERT guard, trg_leads_force_safe_insert_
   * defaults, regardless of caller — see this build's report). REVIEW FAIL
   * 5849223003 fix round: no longer also sets role here -- consent evidence
   * must be written BEFORE the role update (defect 4), and the same
   * finalize step is shared with the recovery path below, so it is a
   * separate `finalizeHomeownerLead` call. Returns the new row's id on
   * success. A unique_violation on meta_lead_id (a race with another
   * delivery of the same leadgen_id) surfaces as error.message ===
   * "duplicate_meta_lead", mirroring registerPartner's own
   * terminal-duplicate convention above.
   */
  registerHomeownerLead: (
    args: RegisterHomeownerLeadArgs,
  ) => Promise<{ data: { id?: string } | null; error: { message?: string } | null }>;
  /**
   * #2123 HO-2 fix round (REVIEW FAIL 5849223003 defects 3 + 4): the shared
   * "finish the job" step for BOTH a freshly-inserted row and a recovered
   * existing one (isDuplicateHomeownerLead found it with roleSet:false).
   * Does, in order:
   *   1. writes the D-299 `lead_consents` evidence row (idempotent -- a
   *      unique_violation on (lead_id, consent_key), e.g. from a retry of
   *      this same step, is treated as already-written, never an error);
   *   2. a SERVICE-ROLE CONDITIONAL UPDATE -- `UPDATE leads SET role =
   *      'homeowner' WHERE id = :leadId AND meta_lead_id = :metaLeadId AND
   *      role IS NULL` -- replacing the old set_lead_role() RPC call
   *      entirely. That RPC's own 30-minute / prefill_used_at window (meant
   *      for an anon caller) made a Meta redelivery arriving more than 30
   *      minutes after the first insert permanently un-recoverable (defect
   *      3); a service-role update keyed on id + meta_lead_id has no such
   *      window and cannot be steered by anything anon-reachable.
   * `updated: false` (zero rows touched) means role was already set by a
   * concurrent delivery -- a TERMINAL race, not a transient failure: the
   * other delivery's own update is what fired (or will fire) the alert, and
   * the same AFTER UPDATE NULL -> non-NULL trigger still fires exactly once
   * across both.
   */
  finalizeHomeownerLead: (
    leadId: string,
    metaLeadId: string,
    consent: HomeownerConsentArgs,
  ) => Promise<{ updated: boolean; error: { message?: string } | null }>;
  checkRateLimit: (bucket: string) => Promise<{ allowed: boolean; errored: boolean }>;
  log: (level: "log" | "warn" | "error", message: string) => void;
}

export interface LeadOutcome {
  leadgenId: string;
  formId: string;
  outcome: string;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Interprets a check_rate_limit() RPC result. Fails CLOSED (errored: true)
 * on an RPC error OR an unexpected/malformed response shape (null data, or
 * a missing/non-boolean `allowed`) -- unlike this codebase's usual fail-OPEN
 * posture for rate-limit RPC errors elsewhere (check-email-exists,
 * record-lead-details), this webhook fails closed on both cases. That is
 * safe here specifically because Meta retries webhook deliveries on any
 * non-2xx response: a transient rate-limit RPC blip just delays the lead,
 * and the meta_lead_id UNIQUE constraint plus isDuplicate() make the
 * eventual retry a no-op rather than a duplicate partner. See gh-2154 P-5
 * R-097 risk brief, issue #2154 comment 5825166960.
 *
 * Extracted as a pure function (no supabase-js import) so the malformed-
 * shape case is unit-testable without a real client or network access.
 */
export function interpretRateLimitResult(
  data: unknown,
  error: { message?: string } | null,
): { allowed: boolean; errored: boolean } {
  if (error) return { allowed: false, errored: true };
  const allowed = (data as { allowed?: unknown } | null)?.allowed;
  if (typeof allowed !== "boolean") return { allowed: false, errored: true };
  return { allowed, errored: false };
}

/** GET — the subscribe handshake. Unset secret -> always 403 (never echoes a challenge). */
export function handleVerification(url: URL, deps: Pick<WebhookDeps, "verifyToken" | "log">): Response {
  const result = verifyHandshake(url.searchParams, deps.verifyToken);
  if (result.ok && result.challenge !== null) {
    deps.log("log", `${FUNCTION_NAME}: handshake ok`);
    return textResponse(result.challenge, 200);
  }
  deps.log("warn", `${FUNCTION_NAME}: handshake rejected`);
  return textResponse("Forbidden", 403);
}

/**
 * POST — the event notification. THE invariant: if `verifyMetaSignature`
 * returns false, this function returns 401 immediately, before the rate
 * limit check, before JSON.parse, before any allowlist/dedupe/fetch/write —
 * a forged or tampered payload causes zero reads, zero fetches, and zero
 * writes.
 */
export async function handlePost(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  clientIp: string | null,
  deps: WebhookDeps,
): Promise<{ response: Response; outcomes: LeadOutcome[] }> {
  // gh-2154 P-5r (REVIEW SHOULD-FIX, taken): verify the HMAC over the raw
  // request BYTES when the caller has them (index.ts passes
  // new Uint8Array(await req.arrayBuffer())), not a decode-then-reencode of
  // req.text() -- byte-exact against what Meta actually signed. A plain
  // string is still accepted (tests, and any future caller that only has
  // text) -- see signature.ts.
  const verified = await verifyMetaSignature(rawBody, signatureHeader, deps.appSecret);
  if (!verified) {
    deps.log("warn", `${FUNCTION_NAME}: signature verification failed`);
    return { response: jsonResponse({ ok: false, error: "invalid signature" }, 401), outcomes: [] };
  }

  // Rate limit AFTER signature verification only — never gates/short-circuits
  // a forged request into doing extra work. Fails CLOSED on its own error or
  // an unexpected RPC shape (see interpretRateLimitResult above): no dedupe
  // read, no Graph API fetch, no register_partner() write happens. This is
  // safe because Meta retries webhook deliveries on any non-2xx response --
  // the lead is simply re-delivered later, and the meta_lead_id UNIQUE
  // constraint plus isDuplicate() keep that retry idempotent, never a
  // duplicate partner. gh-2154 P-5 R-097 risk brief, issue #2154 comment
  // 5825166960.
  const bucket = await ipToUuid(clientIp ?? "unknown");
  const rl = await deps.checkRateLimit(bucket);
  if (rl.errored) {
    deps.log("error", `${FUNCTION_NAME}: rate limit check failed or malformed, failing CLOSED`);
    return { response: jsonResponse({ ok: false, error: "rate_limit_check_failed" }, 503), outcomes: [] };
  }
  if (!rl.allowed) {
    return { response: jsonResponse({ ok: false, error: "rate_limited" }, 429), outcomes: [] };
  }

  const bodyText = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Verified-but-unparseable is not expected from Meta; ack with 200 so it
    // is never retried forever, but nothing is processed.
    return { response: jsonResponse({ ok: true, processed: 0 }, 200), outcomes: [] };
  }

  const allowlist: Allowlist = parseAllowlist(deps.allowlistRaw);
  // #2123 HO-2: parsed unconditionally, alongside the partner allowlist,
  // whether or not any homeowner form is configured yet — an unset/empty
  // META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST parses to {} (parseHomeownerAllowlist
  // never throws), so this is a no-op for every delivery until a homeowner
  // form_id is actually added to it.
  const homeownerAllowlist: HomeownerAllowlist = parseHomeownerAllowlist(
    deps.homeownerAllowlistRaw,
    (m) => deps.log("error", m),
  );
  const outcomes: LeadOutcome[] = [];
  // gh-2154 P-5r (REVIEW FAIL 5833742114 must-fix 1): a Graph fetch error, a
  // register_partner() error other than a terminal duplicate, or a dedupe
  // READ error must never ack 200 -- Meta only retries on non-2xx, so a 200
  // here permanently drops the lead. Terminal skips (not allowlisted,
  // malformed, duplicate, already-registered, incomplete fields) still ack
  // 200: redelivering those can never change the outcome.
  let hasTransientFailure = false;

  // deno-lint-ignore no-explicit-any
  const entries: any[] = Array.isArray((parsed as any)?.entry) ? (parsed as any).entry : [];

  for (const entry of entries) {
    // deno-lint-ignore no-explicit-any
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = (change && typeof change === "object" ? change.value : null) ?? {};
      const leadgenId = typeof value.leadgen_id === "string" ? value.leadgen_id : null;
      const formId = typeof value.form_id === "string" ? value.form_id : null;

      if (!leadgenId || !formId) {
        deps.log("warn", `${FUNCTION_NAME}: malformed change entry (missing leadgen_id/form_id)`);
        outcomes.push({ leadgenId: leadgenId ?? "(unknown)", formId: formId ?? "(unknown)", outcome: "skipped_malformed" });
        continue;
      }

      const config = lookupForm(allowlist, formId);
      if (!config) {
        // #2123 HO-2: a form_id absent from the PARTNER allowlist is now
        // checked against the HOMEOWNER allowlist before falling back to
        // skipped_not_allowlisted — entirely self-contained below (its own
        // dedupe/fetch/validate/write and its own `continue`s), so nothing
        // in the partner branch below this `if` block is reachable or
        // altered for a homeowner form_id, and nothing here runs for a
        // partner form_id (config would be non-null and this whole `if`
        // body is skipped).
        const homeownerConfig = lookupHomeownerForm(homeownerAllowlist, formId);
        if (homeownerConfig) {
          const dup = await deps.isDuplicateHomeownerLead(leadgenId);
          if (dup.errored) {
            deps.log("error", `${FUNCTION_NAME}: homeowner dedupe check failed leadgen_id=${leadgenId}`);
            outcomes.push({ leadgenId, formId, outcome: "error_dedupe_check_failed" });
            hasTransientFailure = true;
            continue;
          }

          if (dup.existingId) {
            if (dup.roleSet) {
              // Terminal: this leadgen_id already produced a homeowner lead
              // with its role set (alert already fired) — redelivery can
              // never change that.
              deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=already_registered`);
              outcomes.push({ leadgenId, formId, outcome: "skipped_already_registered" });
              continue;
            }

            // Recovery: a PRIOR delivery already inserted this row (its
            // meta_lead_id UNIQUE constraint means a second insert is
            // impossible) but the finalize step (consent write + role
            // update) never landed — a transient failure on that earlier
            // attempt, not a terminal one. REVIEW FAIL 5849223003 defect 4:
            // the D-299 consent evidence must exist before role is set even
            // on this recovery path, and that evidence can only come from a
            // fresh Graph fetch (this delivery does not carry the prior
            // delivery's fetched data) — so, unlike before this fix round,
            // a recovery DOES re-fetch. That fetch is safe to repeat: it is
            // read-only against Meta and the lead's own answers/consent do
            // not change between deliveries of the same leadgen_id.
            if (!deps.pageAccessToken) {
              deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=page_token_unset`);
              outcomes.push({ leadgenId, formId, outcome: "skipped_page_token_unset" });
              continue;
            }
            const recoveryFetch = await deps.fetchHomeownerLead(leadgenId, deps.pageAccessToken);
            if (recoveryFetch.error || !recoveryFetch.data) {
              deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=fetch_failed`);
              outcomes.push({ leadgenId, formId, outcome: "skipped_fetch_failed" });
              hasTransientFailure = true;
              continue;
            }
            const recoveryConsent = buildHomeownerConsentArgs(recoveryFetch.data, homeownerConfig, formId);
            const fin = await deps.finalizeHomeownerLead(dup.existingId, leadgenId, recoveryConsent);
            if (fin.error) {
              const finMsg = fin.error.message ?? "";
              if (finMsg.includes("rejected_invalid_data")) {
                // REVIEW FAIL 5849684429 fix 3: same permanent-data-rejection
                // handling as the fresh-insert path below, for the
                // lead_consents insert on the recovery path.
                deps.log("error", `${FUNCTION_NAME}: homeowner finalize recovery rejected invalid data leadgen_id=${leadgenId}`);
                outcomes.push({ leadgenId, formId, outcome: "skipped_invalid_data" });
              } else {
                deps.log("error", `${FUNCTION_NAME}: homeowner finalize recovery failed leadgen_id=${leadgenId}`);
                outcomes.push({ leadgenId, formId, outcome: "error_register_failed" });
                hasTransientFailure = true;
              }
              continue;
            }
            if (!fin.updated) {
              // Terminal (fix defect 3): a concurrent delivery's own
              // finalize already flipped role NULL -> non-NULL first; that
              // delivery's update is what fired (or will fire) the alert.
              deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=already_registered`);
              outcomes.push({ leadgenId, formId, outcome: "skipped_already_registered" });
              continue;
            }
            deps.log("log", `${FUNCTION_NAME}: registered (role recovered) leadgen_id=${leadgenId}`);
            outcomes.push({ leadgenId, formId, outcome: "registered" });
            continue;
          }

          if (!deps.pageAccessToken) {
            deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=page_token_unset`);
            outcomes.push({ leadgenId, formId, outcome: "skipped_page_token_unset" });
            continue;
          }

          const fetched = await deps.fetchHomeownerLead(leadgenId, deps.pageAccessToken);
          if (fetched.error || !fetched.data) {
            deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=fetch_failed`);
            outcomes.push({ leadgenId, formId, outcome: "skipped_fetch_failed" });
            hasTransientFailure = true;
            continue;
          }

          const mapped = mapFieldData(fetched.data.field_data);
          const rawName = mapped.fullName ?? mapped.firstName;
          // REVIEW FAIL 5849684429 fix 2: cap at 200 chars (live
          // leads_name_length_check) BEFORE the incomplete-fields check, so a
          // name that is only whitespace-after-cut is still handled the same
          // as any other empty name.
          const name = rawName ? capHomeownerName(rawName) : rawName;
          // REVIEW FAIL 5849223003 defect 1 (BLOCKER): live leads.email is
          // NOT NULL. A phone-only lead can never be inserted -- email is
          // now REQUIRED on this path too (the plan §2 "email OR phone"
          // reading is superseded; email must also become a required
          // question on the HO-2 Meta form itself, see this PR's body).
          if (!name || !mapped.email) {
            deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=incomplete_fields`);
            outcomes.push({ leadgenId, formId, outcome: "skipped_incomplete_fields" });
            continue;
          }

          const consentArgs = buildHomeownerConsentArgs(fetched.data, homeownerConfig, formId);
          // REVIEW FAIL item 7 (optional/cheap, taken): parity with Arm F --
          // a founder/internal/QA address is ALSO marked synthetic even
          // outside Meta's own Testing Tool flag. CORRECTED per REVIEW FAIL
          // 5849684429 item 7: is_synthetic does NOT suppress the admin
          // alert (neither trg_notify_admin_new_router_lead nor
          // handleRouterLead reads it) -- a founder/internal/QA lead still
          // pages the admin as a real lead, exactly matching Arm F's own
          // parity. is_synthetic exists only to exclude the row from
          // measurement/reporting.
          const isSynthetic = homeownerConfig.isTest || isFounderOrTestEmail(mapped.email);
          // REVIEW FAIL item 6 (SHOULD-FIX): the webhook's own signed
          // change.value carries ad_id/adgroup_id -- stored as utm_content/
          // utm_term so HO-2 leads can be attributed by ad, matching S14's
          // utm_campaign=<line>-<funnel> convention already in place.
          const utmContent = typeof value.ad_id === "string" ? value.ad_id : null;
          const utmTerm = typeof value.adgroup_id === "string" ? value.adgroup_id : null;

          const reg = await deps.registerHomeownerLead({
            name,
            email: mapped.email,
            // REVIEW FAIL 5849684429 fix 1: normalised 10-digit form, same as
            // Arm F -- the raw, as-typed value is captured separately in
            // consentArgs.phoneAsTyped/formPayload, never lost.
            phone: normalizeHomeownerPhone(mapped.phone),
            funnelId: homeownerConfig.funnelId,
            isSynthetic,
            metaLeadId: leadgenId,
            utmContent,
            utmTerm,
          });

          if (reg.error) {
            const msg = reg.error.message ?? "";
            if (msg.includes("duplicate_meta_lead")) {
              // Terminal: a race with another delivery of the same
              // leadgen_id already inserted the row; that delivery's own
              // finalize call (or, if that failed too, its own future
              // redelivery via the recovery path above) owns it.
              deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=already_registered`);
              outcomes.push({ leadgenId, formId, outcome: "skipped_already_registered" });
            } else if (msg.includes("rejected_invalid_data")) {
              // REVIEW FAIL 5849684429 fix 3: a permanent data-rejection
              // error (23502/23514/other 22xxx-23xxx) is terminal -- no
              // amount of Meta redelivery ever fixes bad data, so this must
              // never be a 503 retry loop.
              deps.log("error", `${FUNCTION_NAME}: registerHomeownerLead rejected invalid data leadgen_id=${leadgenId}`);
              outcomes.push({ leadgenId, formId, outcome: "skipped_invalid_data" });
            } else {
              deps.log("error", `${FUNCTION_NAME}: registerHomeownerLead failed leadgen_id=${leadgenId}`);
              outcomes.push({ leadgenId, formId, outcome: "error_register_failed" });
              hasTransientFailure = true;
            }
            continue;
          }

          const newId = reg.data?.id;
          if (!newId) {
            deps.log("error", `${FUNCTION_NAME}: registerHomeownerLead returned no id leadgen_id=${leadgenId}`);
            outcomes.push({ leadgenId, formId, outcome: "error_register_failed" });
            hasTransientFailure = true;
            continue;
          }

          // REVIEW FAIL defect 4: the consent evidence row is written, and
          // only THEN is role set -- see finalizeHomeownerLead's doc comment.
          const fin = await deps.finalizeHomeownerLead(newId, leadgenId, consentArgs);
          if (fin.error) {
            const finMsg = fin.error.message ?? "";
            if (finMsg.includes("rejected_invalid_data")) {
              // REVIEW FAIL 5849684429 fix 3: the lead_consents insert hit a
              // permanent data-rejection error -- terminal, never a retry.
              deps.log("error", `${FUNCTION_NAME}: homeowner finalize rejected invalid data leadgen_id=${leadgenId}`);
              outcomes.push({ leadgenId, formId, outcome: "skipped_invalid_data" });
            } else {
              deps.log("error", `${FUNCTION_NAME}: homeowner finalize failed leadgen_id=${leadgenId}`);
              outcomes.push({ leadgenId, formId, outcome: "error_register_failed" });
              hasTransientFailure = true;
            }
            continue;
          }
          if (!fin.updated) {
            // Terminal: an exceedingly unlikely race right after this same
            // insert (another delivery's finalize won first) -- the alert
            // still fires exactly once, via whichever finalize matched.
            deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=already_registered`);
            outcomes.push({ leadgenId, formId, outcome: "skipped_already_registered" });
            continue;
          }

          deps.log("log", `${FUNCTION_NAME}: registered leadgen_id=${leadgenId}`);
          outcomes.push({ leadgenId, formId, outcome: "registered" });
          continue;
        }

        deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=not_allowlisted`);
        outcomes.push({ leadgenId, formId, outcome: "skipped_not_allowlisted" });
        continue;
      }

      const dupResult = await deps.isDuplicate(leadgenId);
      if (dupResult.errored) {
        deps.log("error", `${FUNCTION_NAME}: dedupe check failed leadgen_id=${leadgenId}`);
        outcomes.push({ leadgenId, formId, outcome: "error_dedupe_check_failed" });
        hasTransientFailure = true;
        continue;
      }
      if (dupResult.duplicate) {
        deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=duplicate`);
        outcomes.push({ leadgenId, formId, outcome: "skipped_duplicate" });
        continue;
      }

      if (!deps.pageAccessToken) {
        deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=page_token_unset`);
        outcomes.push({ leadgenId, formId, outcome: "skipped_page_token_unset" });
        continue;
      }

      const fetched = await deps.fetchLead(leadgenId, deps.pageAccessToken);
      if (fetched.error || !fetched.data) {
        // Transient: a Graph API blip (rate limit, 5xx, network error) is
        // not this lead's fault -- ack non-2xx so Meta retries the delivery.
        deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=fetch_failed`);
        outcomes.push({ leadgenId, formId, outcome: "skipped_fetch_failed" });
        hasTransientFailure = true;
        continue;
      }

      const mapped = mapFieldData(fetched.data.field_data);
      // gh-2154 P-5r (REVIEW SHOULD-FIX, taken): a single-name lead (whole
      // name in "full name", no separate last-name question on the form) no
      // longer drops the lead. field-mapping.ts's fullName-split already
      // puts everything after the first space into lastName when a
      // full-name field is used; the remaining case this covers is a form
      // with distinct first/last-name questions where the visitor left last
      // name blank -- register_partner() REQUIRES a non-empty last name
      // (missing_required_fields), so a single safe placeholder is supplied
      // here rather than dropping the lead, and the outcome says so.
      let lastName = mapped.lastName;
      let suppliedLastNamePlaceholder = false;
      if (!lastName && (mapped.firstName || mapped.fullName)) {
        lastName = "(not provided)";
        suppliedLastNamePlaceholder = true;
      }
      if (!mapped.email || (!mapped.firstName && !mapped.fullName) || !lastName) {
        deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=incomplete_fields`);
        outcomes.push({ leadgenId, formId, outcome: "skipped_incomplete_fields" });
        continue;
      }

      const reg = await deps.registerPartner({
        agentType: config.agentType,
        firstName: mapped.firstName ?? mapped.fullName ?? "",
        lastName,
        email: mapped.email,
        phone: mapped.phone,
        company: mapped.company,
        funnelId: config.funnelId,
        isTest: config.isTest,
        metaLeadId: leadgenId,
      });

      if (reg.error) {
        const msg = reg.error.message ?? "";
        if (msg.includes("partner_exists") || msg.includes("duplicate_meta_lead")) {
          // Terminal: redelivery can never turn "already registered" into a
          // new outcome.
          deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=already_registered`);
          outcomes.push({ leadgenId, formId, outcome: "skipped_already_registered" });
        } else {
          // Transient (REVIEW FAIL 5833742114 must-fix 1's explicit fix):
          // every other register_partner() error -- including
          // rate_limited, which is exactly the failure mode the
          // shared-NULL-bucket bug produced -- gets a non-2xx so Meta
          // retries rather than a silent 200 that permanently loses the
          // lead.
          deps.log("error", `${FUNCTION_NAME}: register_partner failed leadgen_id=${leadgenId}`);
          outcomes.push({ leadgenId, formId, outcome: "error_register_failed" });
          hasTransientFailure = true;
        }
        continue;
      }

      deps.log(
        "log",
        `${FUNCTION_NAME}: registered leadgen_id=${leadgenId}${suppliedLastNamePlaceholder ? " last_name=placeholder" : ""}`,
      );
      outcomes.push({ leadgenId, formId, outcome: "registered" });

      // Best-effort only: never lets an invite-send problem turn a
      // successful registration into a transient-failure retry (the row is
      // already safely written; invite delivery is a separate concern).
      const newId = reg.data?.id;
      if (deps.sendInvite && newId) {
        try {
          await deps.sendInvite({
            referralAgentId: newId,
            email: mapped.email,
            firstName: mapped.firstName ?? mapped.fullName ?? "",
            agentType: config.agentType,
          });
        } catch (err) {
          deps.log("warn", `${FUNCTION_NAME}: sendInvite failed for leadgen_id=${leadgenId}: ${String(err)}`);
        }
      }
    }
  }

  if (hasTransientFailure) {
    // Non-2xx for the WHOLE delivery: Meta redelivers the entire batch.
    // Already-registered / already-duplicate leads in this same batch will
    // just re-hit their terminal skip on retry (meta_lead_id UNIQUE +
    // isDuplicate() keep that idempotent) -- see handler.ts module header.
    return {
      response: jsonResponse({ ok: false, error: "transient_failure", processed: outcomes.length }, 503),
      outcomes,
    };
  }

  return { response: jsonResponse({ ok: true, processed: outcomes.length }, 200), outcomes };
}
