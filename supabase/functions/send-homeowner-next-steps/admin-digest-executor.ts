// gh-1933 review fix (D1) — the digest's injected-dependency executor,
// extracted from index.ts's inline 58-line block the same way ./deliver-stage.ts
// was extracted for the per-claim send decision (see index.ts:597-600's comment
// on that extraction). Before this file existed, the three safety properties
// the PR body rested on — a dry run makes zero Mailgun calls and zero
// notification inserts, only '48h'-stage claims enter the digest, and a
// failed send inserts nothing — had no assertions: they lived entirely in the
// POSITION of one `!dryRun` in one `if` inside the handler. See
// admin-digest-executor.test.ts's MUTANT runs for proof each one now turns
// the suite red.
//
// ROUND 2 (Kevin's re-review of bb317b4d, ahead of Marty's re-review): the
// FIRST version of this file exported `isDigestCandidate` as a pure function
// but still called it at the CALL SITE, in index.ts — `if (isDigestCandidate(stage))
// { stalledForDigest.push(...) }`. index.ts has no tests of its own, so a
// call-site mutant (`if (true)`) bypassed the filter with the full suite
// still green: mutating the PREDICATE's body was tested, mutating the CALL
// was not. The fix is `selectDigestCandidates` below: index.ts now pushes
// EVERY screened claim, unconditionally, with its stage attached
// (ScreenedCandidate), and this file's OWN entry point — runAdminDigest —
// applies the filter itself, before any dryRun/preview/real branch. There is
// no longer a conditional anywhere outside this tested file that decides
// which claims reach the digest.
//
// admin-digest.ts still owns the PURE rendering/masking/day-bucket functions
// (buildAdminDigestEmail, maskEmail, utcDayStartIso, filterNotYetDigestedToday,
// daysStalled) — those needed no extraction, they already took no I/O. This
// file owns the ORDER OF OPERATIONS around them: which claims qualify, which
// branch runs for a real run vs. a dry run vs. a dry-run preview (gh-1933
// D2), and the two actual I/O calls (send the email, write the dedup rows).

import type { NudgeStage } from "./select-stage.ts";
import {
  ADMIN_DIGEST_EMAIL,
  ADMIN_DIGEST_NOTIFICATION_TYPE,
  buildAdminDigestEmail,
  daysStalled,
  filterNotYetDigestedToday,
  maskEmail,
  type StalledCandidate,
  utcDayStartIso,
} from "./admin-digest.ts";

/**
 * gh-1933 D1/D3 — pure predicate for "does this screened claim belong in the
 * admin digest." Today, exactly `stage === '48h'`, because select-stage.ts's
 * '48h' outcome IS the fully-screened stalled condition (documents_needed, no
 * measurements, no hover order, no real activity, claim age >= 48h) — see
 * index.ts's module header for the exact predicate and ./select-stage.ts:74
 * for where '48h' is decided. Extracted to a named, exported, pure function
 * (rather than an inline `if (stage === "48h")` at the call site) so the rule
 * itself is directly testable and provably load-bearing — see
 * admin-digest-executor.test.ts's MUTANT B'', which sets this to always
 * return true and shows a '2h'-stage (NOT stalled) homeowner would then be
 * named to Dustin as stuck for 48+ hours (and MUTANT B', which instead
 * removes the call to this function from selectDigestCandidates below —
 * same observable defect, different line).
 *
 * D3 (Marty/CTO ruling — not changed here on a guess; it is Dustin's product
 * decision to make, not this PR's): '48h' is a TERMINAL stage
 * (select-stage.ts:74 — `if (priorSends.has("48h")) return null`), so a given
 * claim can satisfy this predicate on AT MOST ONE run in its entire lifetime,
 * and never again after that even if it remains stalled for weeks. This
 * predicate does not implement, and cannot be made to implement by itself, a
 * recurring daily alert — that would require changing selectStage's terminal
 * '48h' rule, which is explicitly out of scope here. The `notifications`
 * per-UTC-day dedup read in runAdminDigest below is a BACKSTOP for the
 * narrow case where a claim's digest send this predicate already approved
 * succeeded, but the paired `activity_log` '48h' stamp in the same run's
 * per-claim loop failed (so a same-UTC-day retry could otherwise re-surface
 * it) — it is not, and must not be read as, a daily-recurrence mechanism.
 */
export function isDigestCandidate(stage: NudgeStage | null): boolean {
  return stage === "48h";
}

/** A screened claim as index.ts's per-claim loop produces it, BEFORE the
 * digest filter is applied — every claim that reached the point of having a
 * resolved homeowner email, carrying whichever stage selectStage() picked
 * for it ('2h' or '48h'). Round 2: index.ts pushes ALL of these
 * unconditionally; this file decides which ones become digest candidates. */
export interface ScreenedCandidate extends StalledCandidate {
  stage: NudgeStage;
}

/**
 * gh-1933 round 2 — THE call site for isDigestCandidate, moved inside this
 * tested executor instead of living in untested index.ts. Filters a full,
 * unconditional list of screened claims down to digest candidates, and
 * strips the `stage` field the digest itself never needed (StalledCandidate
 * has no `stage` — ./admin-digest.ts's buildAdminDigestEmail /
 * filterNotYetDigestedToday / daysStalled never look at it).
 *
 * Called FIRST thing inside runAdminDigest, before the dryRun/preview/real
 * branch — see admin-digest-executor.test.ts's MUTANT B' (delete this call,
 * pass `input.candidates` straight through) and MUTANT B'' (make
 * isDigestCandidate return true) for proof both ways of defeating this
 * filter turn the suite red.
 */
export function selectDigestCandidates(screened: ScreenedCandidate[]): StalledCandidate[] {
  return screened
    .filter((c) => isDigestCandidate(c.stage))
    .map((c) => ({
      claimId: c.claimId,
      userId: c.userId,
      email: c.email,
      createdAtIso: c.createdAtIso,
    }));
}

/** gh-1933 D2 — the opt-in preview flag. Same strict-literal-`true`-only
 * convention as ./dry-run.ts's parseDryRun (a truthy non-boolean is
 * deliberately NOT accepted, since this flag decides whether a real email
 * goes out under what is otherwise the safe, no-op dry-run path). Honoured
 * ONLY when `dry_run: true` is also present — see runAdminDigest and
 * index.ts's call site; this function only parses the flag, it does not
 * enforce that pairing. */
export function parseAdminDigestPreview(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as Record<string, unknown>).admin_digest_preview === true;
}

/** One row of the dry-run-without-preview `would_digest` array (gh-1933 D2)
 * — mirrors ./deliver-stage.ts's PreviewRow convention of never carrying a
 * real recipient address; a claim id, an age and a masked email only. */
export interface WouldDigestRow {
  claim_id: string;
  days_stalled: number;
  masked_email: string;
}

export interface AdminDigestDeps {
  /** Reads which of `claimIds` already have an ADMIN_DIGEST_NOTIFICATION_TYPE
   * row with `sent_at >= todayStartIso`. Returns the DB error message on
   * failure rather than throwing, matching this file's other Supabase reads. */
  fetchAlreadyDigestedToday: (
    claimIds: string[],
    todayStartIso: string,
  ) => Promise<{ claimIds: ReadonlySet<string>; error?: string }>;
  sendAdminDigestMail: (
    subject: string,
    textBody: string,
    htmlBody: string,
  ) => Promise<{ ok: boolean; mailgunId?: string; error?: string }>;
  insertNotificationRows: (
    rows: Record<string, unknown>[],
  ) => Promise<{ error: string | null }>;
  mailgunConfigured: boolean;
  /** Epoch ms, injected rather than read from Date.now() so tests are
   * deterministic — same convention as deliver-stage.ts taking its
   * dependencies as arguments instead of reaching for ambient state. */
  now: number;
}

export interface AdminDigestInput {
  dryRun: boolean;
  /** gh-1933 D2 — true only when the caller has already confirmed both
   * dryRun is true AND the caller sent `admin_digest_preview: true`. This
   * function does NOT itself gate on dryRun to decide whether preview
   * behaviour applies to a real run — see PROPERTY "preview flag on a real
   * run changes nothing" in admin-digest-executor.test.ts, which is what
   * proves index.ts's `dryRun && adminDigestPreviewRequested` gate at the
   * call site is the only place that matters. */
  previewSend: boolean;
  /** Round 2: EVERY screened claim, unconditionally — filtering to '48h'
   * candidates happens inside runAdminDigest via selectDigestCandidates,
   * not at the call site. */
  candidates: ScreenedCandidate[];
  siteUrl: string;
}

export interface AdminDigestResult {
  /** Count of claims actually included in a sent digest (real run or
   * preview). Zero is the expected, correct value for a dry run without
   * preview, and for any run with nothing new to report. */
  sent: number;
  error?: string;
  /** Present only for a dry run without the preview flag. */
  wouldDigest?: WouldDigestRow[];
}

function buildWouldDigest(candidates: StalledCandidate[], nowMs: number): WouldDigestRow[] {
  return candidates.map((c) => ({
    claim_id: c.claimId,
    days_stalled: daysStalled(c.createdAtIso, nowMs),
    masked_email: maskEmail(c.email),
  }));
}

/**
 * gh-1933 — the digest executor. Mirrors ./deliver-stage.ts's shape: deps are
 * injected functions the caller wires to Supabase/Mailgun, input is plain
 * data, and every branch is reachable from a test without either.
 *
 * Three paths, matching the three states of (dryRun, previewSend):
 *   - dryRun=true,  previewSend=false -> unchanged pre-D2 behaviour: sends
 *     and writes NOTHING; additionally reports what a real run would include
 *     (`wouldDigest`), itself sending nothing.
 *   - dryRun=true,  previewSend=true  -> gh-1933 D2's new reachable path:
 *     sends exactly ONE digest (admin-only, `[DRY RUN PREVIEW] `-prefixed
 *     subject) built from `candidates` as given (the caller is responsible
 *     for having scanned is_test=true candidates under a dry run — see
 *     index.ts / dry-run.ts's candidateIsTestFlag), and writes NOTHING (no
 *     notifications row — a preview must never suppress a future real
 *     digest for the same claim by looking like it already fired).
 *   - dryRun=false (previewSend is irrelevant and ignored)              ->
 *     the real path: per-UTC-day dedup read, send if anything new, write one
 *     notifications row per newly-digested claim.
 * Zero candidates sends nothing and performs no I/O in every path — the
 * negative control this file's tests assert directly.
 */
export async function runAdminDigest(
  deps: AdminDigestDeps,
  input: AdminDigestInput,
): Promise<AdminDigestResult> {
  const dashboardUrl = `${input.siteUrl}/admin-homeowners.html`;

  // gh-1933 round 2 — filter FIRST, before any dryRun/preview/real branch,
  // so every branch below only ever sees claims that already passed
  // isDigestCandidate. This is what makes a call-site mutant (index.ts
  // pushing an unfiltered list, or any future caller doing the same)
  // unable to bypass the filter: the filter is not the caller's job.
  const candidates = selectDigestCandidates(input.candidates);

  if (input.dryRun) {
    if (!input.previewSend) {
      return { sent: 0, wouldDigest: buildWouldDigest(candidates, deps.now) };
    }

    // gh-1933 D2 — the preview send. NEGATIVE CONTROL: zero candidates sends
    // nothing (this is #1933's own closing artifact's paired negative
    // control, not just a robustness nicety).
    if (candidates.length === 0) {
      return { sent: 0 };
    }
    if (!deps.mailgunConfigured) {
      return { sent: 0, error: "mailgun_not_configured" };
    }
    const built = buildAdminDigestEmail(candidates, dashboardUrl, deps.now);
    const previewSubject = `[DRY RUN PREVIEW] ${built.subject}`;
    const result = await deps.sendAdminDigestMail(previewSubject, built.textBody, built.htmlBody);
    if (!result.ok) {
      return { sent: 0, error: result.error };
    }
    // No notifications row: see the function doc above for why a preview
    // must not be able to suppress tomorrow's — or even today's real, later
    // — digest for the same claim.
    return { sent: candidates.length };
  }

  // ── Real run ───────────────────────────────────────────────────────────
  if (candidates.length === 0) {
    // NEGATIVE CONTROL: nothing stalled this run -> no dedup read, no send,
    // no write. Mirrors the pre-extraction `stalledForDigest.length > 0`
    // guard in index.ts.
    return { sent: 0 };
  }

  const todayStartIso = utcDayStartIso(deps.now);
  const digestClaimIds = candidates.map((c) => c.claimId);
  const already = await deps.fetchAlreadyDigestedToday(digestClaimIds, todayStartIso);
  if (already.error) {
    return { sent: 0, error: "idempotency_check_failed" };
  }
  const newForDigest = filterNotYetDigestedToday(candidates, already.claimIds);
  if (newForDigest.length === 0) {
    return { sent: 0 };
  }
  if (!deps.mailgunConfigured) {
    return { sent: 0, error: "mailgun_not_configured" };
  }

  const { subject, textBody, htmlBody } = buildAdminDigestEmail(newForDigest, dashboardUrl, deps.now);
  const digestResult = await deps.sendAdminDigestMail(subject, textBody, htmlBody);
  if (!digestResult.ok) {
    return { sent: 0, error: digestResult.error };
  }

  // Dedup rows are written only after a CONFIRMED send — a failed Mailgun
  // call must not dedup away tomorrow's (or this run's retry's) attempt.
  const markRows = newForDigest.map((s) => ({
    user_id: s.userId,
    claim_id: s.claimId,
    channel: "email",
    notification_type: ADMIN_DIGEST_NOTIFICATION_TYPE,
    recipient: ADMIN_DIGEST_EMAIL,
    message_preview: "Included in stalled-homeowner digest",
    sent_at: new Date(deps.now).toISOString(),
    delivered: true,
    mailgun_id: digestResult.mailgunId,
  }));
  const { error: markErr } = await deps.insertNotificationRows(markRows);
  if (markErr) {
    return { sent: newForDigest.length, error: `notifications_insert_failed: ${markErr}` };
  }
  return { sent: newForDigest.length };
}
