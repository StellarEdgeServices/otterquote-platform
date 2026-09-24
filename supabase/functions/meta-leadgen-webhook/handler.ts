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
  isDuplicate: (leadgenId: string) => Promise<boolean>;
  registerPartner: (args: RegisterPartnerArgs) => Promise<{ error: { message?: string } | null }>;
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
  rawBody: string,
  signatureHeader: string | null,
  clientIp: string | null,
  deps: WebhookDeps,
): Promise<{ response: Response; outcomes: LeadOutcome[] }> {
  const verified = await verifyMetaSignature(rawBody, signatureHeader, deps.appSecret);
  if (!verified) {
    deps.log("warn", `${FUNCTION_NAME}: signature verification failed`);
    return { response: jsonResponse({ ok: false, error: "invalid signature" }, 401), outcomes: [] };
  }

  // Rate limit AFTER signature verification only — never gates/short-circuits
  // a forged request into doing extra work, and fails OPEN on its own error
  // (an infra hiccup on our side must not let Meta silently stop delivering:
  // it will just retry later on a non-2xx, which check_rate_limit's own 429
  // already produces intentionally).
  const bucket = await ipToUuid(clientIp ?? "unknown");
  const rl = await deps.checkRateLimit(bucket);
  if (!rl.errored && !rl.allowed) {
    return { response: jsonResponse({ ok: false, error: "rate_limited" }, 429), outcomes: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Verified-but-unparseable is not expected from Meta; ack with 200 so it
    // is never retried forever, but nothing is processed.
    return { response: jsonResponse({ ok: true, processed: 0 }, 200), outcomes: [] };
  }

  const allowlist: Allowlist = parseAllowlist(deps.allowlistRaw);
  const outcomes: LeadOutcome[] = [];

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

      const dup = await deps.isDuplicate(leadgenId);
      if (dup) {
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
        deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=fetch_failed`);
        outcomes.push({ leadgenId, formId, outcome: "skipped_fetch_failed" });
        continue;
      }

      const mapped = mapFieldData(fetched.data.field_data);
      if (!mapped.email || (!mapped.firstName && !mapped.fullName) || !mapped.lastName) {
        deps.log("warn", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=incomplete_fields`);
        outcomes.push({ leadgenId, formId, outcome: "skipped_incomplete_fields" });
        continue;
      }

      const reg = await deps.registerPartner({
        agentType: config.agentType,
        firstName: mapped.firstName ?? mapped.fullName ?? "",
        lastName: mapped.lastName ?? "",
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
          deps.log("log", `${FUNCTION_NAME}: skip leadgen_id=${leadgenId} reason=already_registered`);
          outcomes.push({ leadgenId, formId, outcome: "skipped_already_registered" });
        } else {
          deps.log("error", `${FUNCTION_NAME}: register_partner failed leadgen_id=${leadgenId}`);
          outcomes.push({ leadgenId, formId, outcome: "error_register_failed" });
        }
        continue;
      }

      deps.log("log", `${FUNCTION_NAME}: registered leadgen_id=${leadgenId}`);
      outcomes.push({ leadgenId, formId, outcome: "registered" });
    }
  }

  return { response: jsonResponse({ ok: true, processed: outcomes.length }, 200), outcomes };
}
