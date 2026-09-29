// gh-2069 — CLAIM-SCOPED TEST SEND (path (a), CTO ruling 5869465122).
//
// WHY THIS EXISTS
// ---------------
// #2069's closing artifact is one REAL `homeowner_next_steps_*` notifications
// row with a real Mailgun id. The cron cannot produce it safely: normal runs
// scan is_test=false (every eligible REAL homeowner would be emailed), and the
// dry run scans is_test=true but sends and writes nothing by design (see
// ./dry-run.ts). This module is the third option: send through the EXACT
// production screen/deliver path, but only to the claims a caller names, and
// only when every one of them is provably a test claim owned by a test
// profile whose email is one of Dustin's own plus-aliases.
//
// WHAT IT DOES NOT DO
//   * It is inert unless the request body carries the literal key
//     `test_send_claim_ids`. A normal cron body (empty, {}, dry_run, ...)
//     parses to "absent" and index.ts behaves exactly as before.
//   * It does not fork delivery. `deliver` is injected, and index.ts wires it
//     to the SAME deliverStage dependency object the production loop uses
//     (sendMailgunEmail, the notifications insert, the activity_log stamp).
//     The screen is the SAME screenClaim()/reduceActivityRows(); the candidate
//     scan is the SAME buildCandidateQuery() with one extra `.in("id", ids)`.
//   * It does not run the welcome hook, the checklist-complete stage or the
//     admin digest. One requested claim -> at most one nudge email.
//
// FAIL CLOSED
// -----------
// Every check that can reject the request happens BEFORE the first side
// effect, and every one of them is a read. Any rejection is HTTP 400 with no
// email sent and nothing written (no notifications row, no activity_log
// stamp, no digest). The only writes in this module are inside `deliver`, and
// `deliver` is only reachable after every claim, every owner profile and every
// recipient address has been validated.

import type { DeliverOutcome } from "./deliver-stage.ts";
import {
  type ActivityLogRow,
  type NudgeStage,
  reduceActivityRows,
  screenClaim,
} from "./select-stage.ts";
import { dryRunAuthorized } from "./dry-run.ts";

export const TEST_SEND_BODY_KEY = "test_send_claim_ids";
export const TEST_SEND_MAX_CLAIMS = 5;
/** The only recipients a test send may ever reach. Case-sensitive on purpose:
 * fail closed rather than normalise. */
export const TEST_SEND_ALIAS_RE = /^dustinstohler1\+[a-z0-9-]+@gmail\.com$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every top-level body key this function reads. Enumerated from the code and
 * every real caller: the v113 pg_cron job sends `{}`; `health_check` is the
 * probe bypass in index.ts; `dry_run` / `admin_digest_preview` are the
 * dry-run.ts / admin-digest-executor.ts flags; `test_send_claim_ids` is the
 * gh-2069 test send. Anything else is a typo or a stale caller. */
export const ALLOWED_BODY_KEYS: readonly string[] = [
  "dry_run",
  "admin_digest_preview",
  "health_check",
  TEST_SEND_BODY_KEY,
];

export type BodyValidation = { ok: true; body: unknown } | { ok: false; error: string };

/** gh-2069 hardening (REVIEW 5883264904): a mistyped key such as
 * `test_send_claim_id` used to parse to "absent" and fall through to a NORMAL
 * cron run that emails real homeowners. Reject before any side effect: an
 * empty / whitespace body is the normal cron run ({}); anything else must be a
 * JSON object whose keys are all in ALLOWED_BODY_KEYS. Malformed JSON or a
 * non-object (array, string, number) is refused too, for the same reason. */
export function validateRequestBody(rawText: string): BodyValidation {
  if (rawText.trim() === "") return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    return { ok: false, error: "request body is not valid JSON" };
  }
  if (parsed === null) return { ok: true, body: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const unknown = Object.keys(parsed as Record<string, unknown>).filter((k) => !ALLOWED_BODY_KEYS.includes(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown request body key(s): ${unknown.sort().join(", ")}; allowed: ${ALLOWED_BODY_KEYS.join(", ")}` };
  }
  return { ok: true, body: parsed };
}

export type ParsedTestSend =
  | { kind: "absent" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; claimIds: string[] };

/** Reads ONLY the literal `test_send_claim_ids` key. Absent key -> "absent"
 * (normal cron behaviour). Present but empty / non-array / non-uuid /
 * duplicated / over the cap -> "invalid" (400). */
export function parseTestSend(body: unknown): ParsedTestSend {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "absent" };
  const rec = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, TEST_SEND_BODY_KEY)) return { kind: "absent" };
  const raw = rec[TEST_SEND_BODY_KEY];
  if (!Array.isArray(raw)) return { kind: "invalid", error: `${TEST_SEND_BODY_KEY} must be an array of claim uuids` };
  if (raw.length === 0) return { kind: "invalid", error: `${TEST_SEND_BODY_KEY} must not be empty` };
  if (raw.length > TEST_SEND_MAX_CLAIMS) {
    return { kind: "invalid", error: `${TEST_SEND_BODY_KEY} accepts at most ${TEST_SEND_MAX_CLAIMS} claim ids` };
  }
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !UUID_RE.test(v)) {
      return { kind: "invalid", error: `${TEST_SEND_BODY_KEY} contains a value that is not a uuid` };
    }
    ids.push(v.toLowerCase());
  }
  if (new Set(ids).size !== ids.length) {
    return { kind: "invalid", error: `${TEST_SEND_BODY_KEY} contains duplicate claim ids` };
  }
  return { kind: "ok", claimIds: ids };
}

/** A test send requires POSITIVE proof of authorization (matching X-Cron-Secret
 * or the service-role bearer) — it does NOT inherit the batch gate's permissive
 * "no CRON_SECRET configured" branch, for the same reason a dry run does not
 * (see dryRunAuthorized). It is the existing cron auth check, reused. */
export const testSendAuthorized = dryRunAuthorized;

export function isTestAliasEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && TEST_SEND_ALIAS_RE.test(email);
}

export interface TestSendClaim {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  is_test: boolean | null;
}

export interface TestSendProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  is_test: boolean | null;
}

type Read<T> = Promise<{ rows: T[]; error: string | null }>;

export interface TestSendDeps {
  mailgunConfigured: boolean;
  now: number;
  /** Raw claims by id, NO predicates — used only to validate the request. */
  fetchClaimsByIds(ids: string[]): Read<TestSendClaim>;
  fetchProfilesByIds(userIds: string[]): Read<TestSendProfile>;
  /** Production's own fallback when the profile row has no email. */
  fetchAuthContact(userId: string): Promise<{ email: string | null; name: string | null }>;
  /** The production candidate scan (buildCandidateQuery, scanIsTest=true)
   * narrowed to the requested ids. */
  fetchCandidateClaims(ids: string[]): Read<TestSendClaim>;
  fetchHoverClaimIds(claimIds: string[]): Promise<{ ids: string[]; error: string | null }>;
  fetchActivity(userIds: string[]): Read<ActivityLogRow>;
  fetchOptedOut(
    userIds: string[],
    claimIds: string[],
  ): Promise<{ optedOut: Set<string>; error: { message: string } | null }>;
  /** index.ts wires this to deliverStage() with the production deps. */
  deliver(args: {
    claim: TestSendClaim;
    stage: NudgeStage;
    homeownerEmail: string;
    homeownerName: string;
  }): Promise<DeliverOutcome>;
  nudgeEventType: string;
  optOutEventType: string;
}

export interface TestSendResponse {
  status: number;
  body: Record<string, unknown>;
}

function reject(status: number, error: string, reasons: string[] = []): TestSendResponse {
  return { status, body: { ok: false, error, ...(reasons.length ? { reasons } : {}), sent: 0 } };
}

export async function runTestSend(deps: TestSendDeps, claimIds: string[]): Promise<TestSendResponse> {
  // ── 0. Preconditions that are cheaper than a read ───────────────────────
  if (!deps.mailgunConfigured) {
    // deliverStage's no-Mailgun branch would WRITE a "sent" notification for an
    // email that never left. A test send exists to prove a real send.
    return reject(409, "MAILGUN_API_KEY is not configured; a test send requires a real send");
  }

  // ── 1. Validate: every claim, every owner, every recipient. Reads only. ──
  const claimsRes = await deps.fetchClaimsByIds(claimIds);
  if (claimsRes.error) return reject(500, "claim read failed");
  const byId = new Map(claimsRes.rows.map((c) => [c.id.toLowerCase(), c]));

  const reasons: string[] = [];
  for (const id of claimIds) {
    const c = byId.get(id);
    if (!c) reasons.push(`${id}: claim_not_found`);
    else if (c.is_test !== true) reasons.push(`${id}: claim_not_is_test`);
  }
  // Owner + recipient checks need the claim rows, so they only run for the
  // claims that exist; a missing claim has already condemned the request.
  const found = claimIds.map((id) => byId.get(id)).filter((c): c is TestSendClaim => Boolean(c));
  const ownerIds = [...new Set(found.map((c) => c.user_id))];
  const profRes = ownerIds.length ? await deps.fetchProfilesByIds(ownerIds) : { rows: [], error: null };
  if (profRes.error) return reject(500, "profile read failed");
  const profById = new Map(profRes.rows.map((p) => [p.id, p]));

  const contactByClaim = new Map<string, { email: string; name: string }>();
  for (const c of found) {
    const p = profById.get(c.user_id);
    if (!p) {
      reasons.push(`${c.id}: owner_profile_not_found`);
      continue;
    }
    if (p.is_test !== true) {
      reasons.push(`${c.id}: owner_profile_not_is_test`);
      continue;
    }
    let email = p.email;
    let name = p.full_name || "there";
    if (!email) {
      const auth = await deps.fetchAuthContact(c.user_id);
      email = auth.email;
      name = auth.name || "there";
    }
    if (!isTestAliasEmail(email)) {
      reasons.push(`${c.id}: recipient_not_test_alias`);
      continue;
    }
    contactByClaim.set(c.id.toLowerCase(), { email: email as string, name });
  }
  if (reasons.length > 0) {
    return reject(400, "test send refused: every claim and owner must be is_test=true with a dustinstohler1+<tag>@gmail.com recipient", reasons);
  }

  // ── 2. Production candidate scan + screen inputs. Still reads only. ─────
  const candRes = await deps.fetchCandidateClaims(claimIds);
  if (candRes.error) return reject(500, "candidate scan failed");
  const candidates = candRes.rows;
  const results: Record<string, unknown>[] = [];
  const candidateIds = new Set(candidates.map((c) => c.id.toLowerCase()));
  for (const id of claimIds) {
    if (!candidateIds.has(id)) results.push({ claim_id: id, stages_sent: [], skipped_reason: "not_a_candidate" });
  }

  let sent = 0;
  if (candidates.length > 0) {
    const cIds = candidates.map((c) => c.id);
    const uIds = [...new Set(candidates.map((c) => c.user_id))];
    const hover = await deps.fetchHoverClaimIds(cIds);
    if (hover.error) return reject(500, "hover_orders read failed");
    const activity = await deps.fetchActivity(uIds);
    if (activity.error) return reject(500, "activity_log read failed");
    const opt = await deps.fetchOptedOut(uIds, cIds);
    if (opt.error) return reject(500, "opt-out read failed");

    const reduced = reduceActivityRows(activity.rows, deps.nudgeEventType, deps.optOutEventType);
    const hoverSet = new Set(hover.ids);

    // ── 3. Screen + deliver. First side effect happens here, never earlier. ─
    for (const claim of candidates) {
      const decision = screenClaim(claim, {
        optedOutClaimIds: opt.optedOut,
        claimIdsWithHoverOrder: hoverSet,
        reduced,
        now: deps.now,
      });
      if (decision.skipped_reason) {
        results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: decision.skipped_reason });
        continue;
      }
      if (decision.stage === null) {
        results.push({ claim_id: claim.id, stages_sent: [] });
        continue;
      }
      const contact = contactByClaim.get(claim.id.toLowerCase());
      // Defence in depth: re-assert the alias on the value actually handed to
      // Mailgun, not just on the value validated above.
      if (!contact || !isTestAliasEmail(contact.email) || claim.is_test !== true) {
        results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: "recipient_guard" });
        continue;
      }
      const outcome = await deps.deliver({
        claim,
        stage: decision.stage,
        homeownerEmail: contact.email,
        homeownerName: contact.name,
      });
      if (outcome.kind === "sent") {
        sent++;
        results.push({ claim_id: claim.id, stages_sent: [decision.stage] });
      } else if (outcome.kind === "already_sent") {
        results.push({ claim_id: claim.id, stages_sent: [], stages_skipped_already_sent: [decision.stage] });
      } else if (outcome.kind === "previewed") {
        results.push({ claim_id: claim.id, stages_sent: [], stages_previewed: [decision.stage] });
      } else {
        results.push({ claim_id: claim.id, stages_sent: [], failed_stage: decision.stage, error: outcome.error });
      }
    }
  }

  return {
    status: 200,
    body: { ok: true, test_send: true, scanned_is_test: true, requested: claimIds.length, processed: sent, results },
  };
}
