// gh-2154 P-5 — meta-leadgen-webhook request handling, testable with
// injected fakes (same convention as record-lead-details/handler.ts and
// notify-admin-new-partner's PartnerDeps). No network, no real database in
// this file — index.ts wires the real Supabase client, Mailgun-free Graph
// API fetch, and global fetch.
//
// PARTNER PATH ONLY. The homeowner `leads` path (#2123) is explicitly NOT
// built — Dustin excluded it from this task. A form_id not in the allowlist
// (which includes any homeowner form) is always a logged skip + 200, never
// a write, never an error.
//
// Never logs raw lead PII (name/email/phone/company) or any token/secret —
// only leadgen_id and an outcome string.

import { verifyHandshake } from "./handshake.ts";
import { verifyMetaSignature } from "./signature.ts";
import { parseAllowlist, lookupForm, type Allowlist } from "./allowlist.ts";
import { mapFieldData, type LeadFieldDatum } from "./field-mapping.ts";

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

export interface WebhookDeps {
  verifyToken: string | undefined;
  appSecret: string | undefined;
  pageAccessToken: string | undefined;
  allowlistRaw: string | undefined;
  fetchLead: (leadgenId: string, token: string) => Promise<{ data: FetchedLead | null; error: string | null }>;
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
        // Includes any homeowner (#2123) form — that path is not built.
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
