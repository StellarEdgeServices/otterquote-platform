/**
 * gh-2442 -- process-dunning "retry pass": turns a contractor's recorded retry request
 * (payment_failures.retry_requested_at, written only by public.request_dunning_retry()) into at most ONE
 * charge attempt per request.
 *
 * Decisions this encodes (read #2442 before changing any of it):
 *   D-379            a contractor may ask for up to 3 retries per failed payment (per QUOTE: the SQL function
 *                    sums retry_request_count over the quote's rows), only until the homeowner notice.
 *   Ben, #2442       a request is refused from the moment homeowner_notify_at <= now().
 *   6255496641       per-attempt idempotency key (the TRIGGER-mode key `dunning-<quote>-<pm>` replays a decline
 *                    for ~24h), one attempt per request, per-job cap, no retry of a hard decline.
 *
 * Shape: PURE decision logic + an injected `RetryPassDeps` so every branch is testable without Deno, Stripe or a
 * database (tests/gh2442-dunning-retry-pass.mjs runs this file under node type-stripping). The real wiring is in
 * retry-pass-supabase.ts. This file uses erasable TypeScript only (no enums, no parameter properties).
 *
 * AT-MOST-ONCE, WRITE-AHEAD. `retry_handled_at` is written BEFORE any Stripe call, and so is the in-doubt marker:
 * before EVERY Stripe POST the pass compare-and-sets `retry_unknown_at` + `retry_unknown_attempt` (the exact request,
 * idempotency key included) onto the quote's rows. If that write does not land, Stripe is not called. After a
 * definite result the marker is cleared or settled. So a worker that dies mid-POST, a hung POST, or a failed
 * post-call write all leave the marker set: the RPC refuses new requests, the hold applies, and the next pass
 * replays the SAME request with the SAME key (Stripe returns the original result for 24h). (REVIEW 6276858298 D1/D2.)
 *
 * NOT DONE HERE: the card-surcharge formula is copied from TRIGGER mode (index.ts "MULTI-METHOD RETRY") rather than
 * extracted from it, so the live TRIGGER path is untouched by this change. tests/gh2442-dunning-retry-pass.mjs pins
 * the two formulas together.
 */

export const MAX_REQUESTS_PER_QUOTE = 3; // D-379
export const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1000; // a request older than this is never charged
export const MAX_QUOTES_PER_RUN = 10; // blast-radius cap per cron tick
export const OPEN_STATUSES = ["active", "warning_sent"];
/** quotes.payment_status values that mean the fee is paid or money is in motion: no charge, no reminders. */
export const PAYMENT_HOLD_STATUSES = ["succeeded", "pending", "processing"];
/**
 * An in-doubt attempt is resolved ONLY by replaying the identical PaymentIntent create with the SAME stored
 * idempotency key (Stripe returns the original result for 24h). Past 23h we stop replaying (a replay could create a
 * brand-new charge once Stripe forgets the key) and a person verifies in Stripe. No search, ever: search is
 * eventually consistent and one request can create several intents (REVIEW 6276208597 C1).
 */
export const UNKNOWN_REPLAY_MAX_MS = 23 * 60 * 60 * 1000;

/** Bank says do not try this method again. Never retried with the same method; logged. */
export const HARD_DECLINE_CODES = [
  "lost_card",
  "stolen_card",
  "pickup_card",
  "fraudulent",
  "restricted_card",
  "invalid_account",
  "account_closed",
  "no_account",
  "card_not_supported",
  "stop_payment_order",
  "revocation_of_authorization",
  "debit_not_authorized",
];

export interface FailureRow {
  id: string;
  quote_id: string | null;
  contractor_id: string;
  claim_id: string | null;
  amount_cents: number;
  dunning_status: string | null;
  resolved_at: string | null;
  homeowner_notify_at: string | null;
  retry_requested_at: string | null;
  retry_request_count: number | null;
  retry_handled_at: string | null;
  retry_unknown_at?: string | null;
  retry_unknown_attempt?: UnknownAttempt | null;
}

/** The exact request that was in doubt, stored with the marker so the next pass replays it byte for byte. */
export interface UnknownAttempt {
  req: ChargeRequest;
  attemptedAt: string;
  /** Set (once) when the "past 23h, verify in Stripe" alert has been sent, so it fires exactly once. */
  stuckAlertedAt?: string;
}

export interface ChargeMethod {
  stripe_pm_id: string;
  payment_type: string; // 'card' | 'us_bank_account'
  cpm_id: string | null;
}

export interface ChargeRequest {
  quoteId: string;
  contractorId: string;
  claimId: string;
  customerId: string;
  method: ChargeMethod;
  feeCents: number;
  chargeAmountCents: number;
  idempotencyKey: string;
  requestedAtMs: number;
}

export interface ChargeResult {
  /**
   * succeeded / processing: money moved or is moving.
   * failed:  a DEFINITE decline (Stripe answered 402 card_error, or the intent is requires_payment_method): no money moved.
   * unknown: anything else (timeout, reset, non-JSON, 5xx, 409, 429, unexpected status). The charge may or may not exist.
   *          The pass STOPS for this quote and never tries another method.
   */
  status: "succeeded" | "processing" | "failed" | "unknown";
  paymentIntentId: string | null;
  declineCode: string | null;
  message: string | null;
}

export interface RetryPassDeps {
  now: () => Date;
  listCandidateRows: (sinceIso: string) => Promise<FailureRow[]>;
  /**
   * Compare-and-set: stamp retry_handled_at on these rows only where it is NULL or older than the request.
   * Returns the number of rows actually written (0 = someone else already consumed the request).
   */
  markHandled: (rowIds: string[], nowIso: string, requestedAtIso: string) => Promise<number>;
  /** Give back one request on the row that carries it (a refusal must not use up the cap of 3). */
  refundRequest: (rowId: string, currentCount: number) => Promise<boolean>;
  /**
   * Record the unknown-outcome marker WITH the exact in-doubt request (retry_unknown_at + retry_unknown_attempt).
   * Write-once: only rows whose marker is NULL are written, so a later request can never move the stored key.
   */
  markUnknown: (rowIds: string[], attempt: UnknownAttempt) => Promise<number>;
  /**
   * Compare-and-set clear: only rows whose stored attempt still carries THIS idempotency key. Returns rows written.
   * Never keyed on a timestamp, never unconditional: an overlapping tick may already have moved the marker on to the
   * next attempt, and wiping that one would bring back the double charge (REVIEW 6277096279 E1).
   */
  clearUnknown: (rowIds: string[], idempotencyKey: string) => Promise<number>;
  /** Run lease: one pass at a time. Returns a token, or null when another pass holds it (or the lease cannot be read). */
  acquireLease: () => Promise<string | null>;
  releaseLease: (token: string) => Promise<void>;
  /** Flag the stored attempt as alerted (adds stuckAlertedAt, key untouched); compare-and-set unset -> set. Returns rows written. */
  markStuckAlerted: (rowIds: string[], attempt: UnknownAttempt, nowIso: string) => Promise<number>;
  /** The intent's CURRENT state (a replay returns the cached original response, which can be stale for ACH). */
  retrieveIntent: (paymentIntentId: string) => Promise<{ status: string } | { error: string }>;
  /** How many of these rows are still open (active / warning_sent, not resolved). */
  countOpenRows: (rowIds: string[]) => Promise<number>;
  getQuotePaymentStatus: (quoteId: string) => Promise<string | null>;
  /** Live-charge guard (#1467): fails closed. */
  chargeGuard: (claimId: string | null) => Promise<{ allow: boolean; message: string }>;
  getChargeMethods: (contractorId: string) => Promise<{ customerId: string; methods: ChargeMethod[] } | null>;
  charge: (req: ChargeRequest) => Promise<ChargeResult>;
  recordQuoteResult: (
    quoteId: string,
    update: Record<string, unknown>,
  ) => Promise<boolean>;
  /** Stop the reminder sequence for a quote whose fee has now been collected. Returns rows written. */
  closeDunningRows: (rowIds: string[], nowIso: string) => Promise<number>;
  alert: (alertType: string, message: string) => Promise<void>;
}

export type GroupOutcome =
  | { quoteKey: string; outcome: "charged"; paymentIntentId: string; methodType: string }
  | { quoteKey: string; outcome: "processing"; paymentIntentId: string; methodType: string }
  | { quoteKey: string; outcome: "all_methods_failed"; hardDeclines: number }
  | { quoteKey: string; outcome: "unknown"; methodType: string }
  | { quoteKey: string; outcome: "reconciled"; result: string }
  | { quoteKey: string; outcome: "refused"; reason: string }
  | { quoteKey: string; outcome: "skipped"; reason: string };

/**
 * Which Stripe key the pass may use. TEST MODE IS THE DEFAULT: setting DUNNING_RETRY_PASS_ENABLED=true alone can
 * only ever touch STRIPE_SECRET_KEY_TEST. Live charging needs the separate explicit DUNNING_RETRY_PASS_LIVE=true,
 * and the key prefix must match the mode (a test key never runs live; a live key never runs as test).
 */
export function selectRetryStripeKey(
  getEnv: (name: string) => string | undefined,
): { ok: true; key: string; mode: "test" | "live" } | { ok: false; reason: string } {
  const live = getEnv("DUNNING_RETRY_PASS_LIVE") === "true";
  const key = live ? getEnv("STRIPE_SECRET_KEY") : getEnv("STRIPE_SECRET_KEY_TEST");
  if (!key) return { ok: false, reason: live ? "live mode: STRIPE_SECRET_KEY not set" : "test mode: STRIPE_SECRET_KEY_TEST not set" };
  const isTestKey = key.startsWith("sk_test_") || key.startsWith("rk_test_");
  if (!live && !isTestKey) return { ok: false, reason: "test mode refuses a key that is not a Stripe test key" };
  if (live && isTestKey) return { ok: false, reason: "live mode refuses a Stripe test key" };
  return { ok: true, key, mode: live ? "live" : "test" };
}

/** Same arithmetic as process-dunning/index.ts TRIGGER mode (card = fee + 30c grossed up for 2.9%). */
export function cardChargeAmount(feeCents: number): number {
  return Math.ceil((feeCents + 30) / (1 - 0.029));
}

export function attemptIdempotencyKey(quoteId: string, stripePmId: string, requestedAtIso: string): string {
  return `dunning-retry-${quoteId}-${stripePmId}-${Date.parse(requestedAtIso)}`;
}

export function isHardDecline(code: string | null): boolean {
  return code != null && HARD_DECLINE_CODES.includes(code);
}

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : NaN);

export interface Group {
  key: string;
  quoteId: string | null;
  rows: FailureRow[];
  requestedAt: string; // latest retry_requested_at in the group
}

/** Rows of one quote form one failed payment (the webhook row and the scheduled row). No quote = group of one. */
export function groupRows(rows: FailureRow[]): Group[] {
  const by = new Map<string, FailureRow[]>();
  for (const r of rows) {
    const k = r.quote_id ? `q:${r.quote_id}:${r.contractor_id}` : `r:${r.id}`;
    const list = by.get(k);
    if (list) list.push(r); else by.set(k, [r]);
  }
  const groups: Group[] = [];
  for (const [key, list] of by) {
    let latest = NaN;
    let latestIso = "";
    for (const r of list) {
      const t = ms(r.retry_requested_at);
      if (!Number.isNaN(t) && (Number.isNaN(latest) || t > latest)) { latest = t; latestIso = r.retry_requested_at as string; }
    }
    if (Number.isNaN(latest)) continue;
    groups.push({ key, quoteId: list[0].quote_id, rows: list, requestedAt: latestIso });
  }
  return groups;
}

/** A group is pending when its newest request is newer than its newest handled stamp. */
export function isPending(g: Group): boolean {
  let handled = NaN;
  for (const r of g.rows) {
    const t = ms(r.retry_handled_at);
    if (!Number.isNaN(t) && (Number.isNaN(handled) || t > handled)) handled = t;
  }
  return Number.isNaN(handled) || ms(g.requestedAt) > handled;
}

/** null = eligible to be charged; otherwise the refusal reason. Pure. */
export function refusalReason(g: Group, now: Date): string | null {
  const age = now.getTime() - ms(g.requestedAt);
  if (age > MAX_REQUEST_AGE_MS) return "request_expired";
  let sum = 0;
  let scheduled = false;
  for (const r of g.rows) {
    if (!OPEN_STATUSES.includes(r.dunning_status ?? "") || r.resolved_at) return "dunning_closed";
    // Ben (#2442): refused from the time the homeowner notice is DUE, not only once it has been sent.
    if (r.homeowner_notify_at) {
      scheduled = true;
      if (ms(r.homeowner_notify_at) <= now.getTime()) return "homeowner_notice_due";
    }
    sum += r.retry_request_count ?? 0;
  }
  if (!scheduled) return "no_dunning_schedule";
  if (sum > MAX_REQUESTS_PER_QUOTE) return "over_cap"; // the SQL function never lets this happen; belt and braces
  return null;
}

function openIds(g: Group): string[] {
  return g.rows.filter((r) => OPEN_STATUSES.includes(r.dunning_status ?? "") && !r.resolved_at).map((r) => r.id);
}

/** The row that carries the newest request (the one the SQL function incremented). */
function requestRow(g: Group): FailureRow | null {
  let best: FailureRow | null = null;
  for (const r of g.rows) {
    if (!r.retry_requested_at || !(r.retry_request_count && r.retry_request_count > 0)) continue;
    if (!best || ms(r.retry_requested_at) > ms(best.retry_requested_at)) best = r;
  }
  return best;
}

async function closeGroup(deps: RetryPassDeps, g: Group, quoteId: string): Promise<void> {
  const want = openIds(g);
  const wrote = want.length ? await deps.closeDunningRows(want, deps.now().toISOString()) : 0;
  if (wrote < want.length) {
    // A compare-and-set miss because an overlapping tick already closed them is benign; only alert if rows are STILL open.
    const stillOpen = await deps.countOpenRows(want);
    if (stillOpen > 0) {
      await deps.alert("gh2105_zero_row_update", `Retry pass for quote ${quoteId}: fee collected but closing the dunning rows wrote ${wrote} of ${want.length} and ${stillOpen} are still open; reminders may continue.`);
    }
  }
}

async function recordResult(deps: RetryPassDeps, quoteId: string, update: Record<string, unknown>, how: string): Promise<boolean> {
  const recorded = await deps.recordQuoteResult(quoteId, update);
  if (!recorded) await deps.alert("gh2105_zero_row_update", `Retry pass for quote ${quoteId}: ${how} but the quotes write matched zero rows; the in-doubt marker is kept so the next pass records it.`);
  return recorded;
}

/** A group carrying an unknown-outcome marker is only ever resolved by replaying the stored request; never charged anew. */
async function reconcile(deps: RetryPassDeps, g: Group, quoteId: string): Promise<GroupOutcome> {
  const ids = g.rows.map((r) => r.id);
  const marked = g.rows.find((r) => r.retry_unknown_at && r.retry_unknown_attempt?.req?.idempotencyKey);
  const att = marked?.retry_unknown_attempt;
  if (!att) {
    await deps.alert("dunning_retry_unknown_stuck", `Retry pass: quote ${quoteId} has an unknown-outcome marker but no stored attempt, so nothing can be replayed. Verify in Stripe by metadata quote_id=${quoteId} before clearing retry_unknown_at; do not clear it without checking.`);
    return { quoteKey: g.key, outcome: "skipped", reason: "unknown_attempt_not_stored" };
  }
  const req = att.req;
  const age = deps.now().getTime() - ms(att.attemptedAt);
  if (!(age < UNKNOWN_REPLAY_MAX_MS)) {
    // At 23h or more Stripe's 24h idempotency window is nearly shut and a replay could mint a NEW charge. Stop. Alert
    // exactly once (stored flag), even if a cron hour was missed.
    if (!att.stuckAlertedAt) {
      const flagged = await deps.markStuckAlerted(ids, att, deps.now().toISOString());
      if (flagged > 0) {
        await deps.alert("dunning_retry_unknown_stuck", `Retry pass: quote ${quoteId} in-doubt attempt (idempotency key ${req.idempotencyKey}, metadata quote_id=${req.quoteId} retry_requested_ms=${req.requestedAtMs}, ${req.method.payment_type} ****${req.method.stripe_pm_id.slice(-4)}) is 23h or older and can no longer be replayed. Verify in Stripe by idempotency key/metadata before clearing retry_unknown_at; do not clear it without checking.`);
      }
    }
    return { quoteKey: g.key, outcome: "skipped", reason: "unknown_replay_window_closed" };
  }
  const guard = await deps.chargeGuard(req.claimId);
  if (!guard.allow) {
    await deps.alert("platform_fee_refused_unauthorized_test", `${guard.message} Replay of in-doubt attempt refused for quote ${quoteId}; marker kept.`);
    return { quoteKey: g.key, outcome: "skipped", reason: "unknown_replay_guard_refused" };
  }
  let res = await deps.charge(req); // IDENTICAL request, SAME idempotency key: Stripe returns the original result
  if (res.status === "unknown") return { quoteKey: g.key, outcome: "skipped", reason: "unknown_still_unknown" };
  if ((res.status === "succeeded" || res.status === "processing") && res.paymentIntentId) {
    // The replay returns the CACHED original response. For a bank payment that may be stale: read the intent now.
    const fresh = await deps.retrieveIntent(res.paymentIntentId);
    // If the current state cannot be read, record nothing and KEEP the marker: the next pass replays and reads again.
    if ("error" in fresh) return { quoteKey: g.key, outcome: "skipped", reason: "reconcile_fresh_state_unavailable" };
    if (fresh.status === "succeeded") res = { ...res, status: "succeeded" };
    else if (fresh.status === "processing") res = { ...res, status: "processing" };
    else if (["requires_payment_method", "canceled", "requires_action"].includes(fresh.status)) {
      res = { status: "failed", paymentIntentId: res.paymentIntentId, declineCode: fresh.status, message: "intent no longer holds funds" };
    } else {
      return { quoteKey: g.key, outcome: "skipped", reason: "reconcile_fresh_state_unexpected" };
    }
  }
  if (res.status === "failed") {
    // CAS on the key: if another tick has moved the marker on to its next attempt, leave it alone and do nothing more.
    if ((await deps.clearUnknown(ids, req.idempotencyKey)) < 1) return { quoteKey: g.key, outcome: "skipped", reason: "marker_moved_on" };
    await deps.alert("dunning_retry_unknown_resolved", `Retry pass: in-doubt attempt for quote ${quoteId} (key ${req.idempotencyKey}) resolved as a definite decline (${res.declineCode ?? "no code"}); no money moved. Marker cleared; the rest of the request was not attempted.`);
    return { quoteKey: g.key, outcome: "reconciled", result: "declined" };
  }
  const isCard = req.method.payment_type === "card";
  const update: Record<string, unknown> = {
    payment_intent_id: res.paymentIntentId,
    payment_status: res.status === "succeeded" ? "succeeded" : "pending",
    payment_method_type: req.method.payment_type,
  };
  if (req.method.cpm_id) update.payment_method_id = req.method.cpm_id;
  if (isCard) update.card_fee_cents = req.chargeAmountCents - req.feeCents;
  const recorded = await recordResult(deps, quoteId, update, `replayed in-doubt attempt: Stripe ${res.status} (payment_intent ${res.paymentIntentId})`);
  if (res.status === "succeeded") await closeGroup(deps, g, quoteId);
  if (!recorded) return { quoteKey: g.key, outcome: "skipped", reason: "replay_result_not_recorded" };
  if ((await deps.clearUnknown(ids, req.idempotencyKey)) < 1) return { quoteKey: g.key, outcome: "skipped", reason: "marker_moved_on" };
  await deps.alert("dunning_retry_unknown_resolved", `Retry pass: in-doubt attempt for quote ${quoteId} (key ${req.idempotencyKey}) resolved by replay: ${res.status}, payment_intent ${res.paymentIntentId}.`);
  return { quoteKey: g.key, outcome: "reconciled", result: res.status };
}

export async function runRetryPass(deps: RetryPassDeps): Promise<GroupOutcome[]> {
  // Belt and braces: one pass at a time. The key-CAS above is what makes an overlap harmless; the lease makes it rare.
  const lease = await deps.acquireLease();
  if (!lease) return [{ quoteKey: "-", outcome: "skipped", reason: "another_pass_holds_the_lease" }];
  try {
    return await runRetryPassLocked(deps);
  } finally {
    try { await deps.releaseLease(lease); } catch (_) { /* the lease expires on its own */ }
  }
}

async function runRetryPassLocked(deps: RetryPassDeps): Promise<GroupOutcome[]> {
  const now = deps.now();
  const sinceIso = new Date(now.getTime() - 3 * MAX_REQUEST_AGE_MS).toISOString();
  const rows = await deps.listCandidateRows(sinceIso);
  const groups = groupRows(rows);
  const outcomes: GroupOutcome[] = [];
  let charged = 0;

  for (const g of groups) {
    const nowIso = deps.now().toISOString();
    const ids = g.rows.map((r) => r.id);

    if (g.rows.some((r) => r.retry_unknown_at)) {
      if (g.quoteId) outcomes.push(await reconcile(deps, g, g.quoteId));
      continue;
    }
    if (!isPending(g)) continue;

    // A refusal consumes the request (so it is not rescanned) but gives the request back: it must not use up the cap.
    const refuse = async (reason: string, alertType?: string, alertMsg?: string) => {
      const wrote = await deps.markHandled(ids, nowIso, g.requestedAt);
      if (wrote > 0) {
        const carrier = requestRow(g);
        if (carrier) await deps.refundRequest(carrier.id, carrier.retry_request_count as number);
      }
      if (alertType && alertMsg) await deps.alert(alertType, alertMsg);
      outcomes.push({ quoteKey: g.key, outcome: "refused", reason });
    };

    const reason = refusalReason(g, deps.now());
    if (reason) { await refuse(reason); continue; }
    if (charged >= MAX_QUOTES_PER_RUN) {
      outcomes.push({ quoteKey: g.key, outcome: "skipped", reason: "run_cap_next_tick" }); // left pending
      continue;
    }
    const quoteId = g.quoteId;
    const claimId = g.rows.find((r) => r.claim_id)?.claim_id ?? null;
    const fee = g.rows.reduce((m, r) => (r.amount_cents > m ? r.amount_cents : m), 0);
    const contractorId = g.rows[0].contractor_id;
    if (!quoteId || !claimId || !(fee > 0)) { await refuse("missing_quote_claim_or_amount"); continue; }

    const payStatus = await deps.getQuotePaymentStatus(quoteId);
    if (payStatus && PAYMENT_HOLD_STATUSES.includes(payStatus)) { await refuse(`quote_payment_${payStatus}`); continue; }

    const guard = await deps.chargeGuard(claimId);
    if (!guard.allow) {
      await refuse("live_charge_guard", "platform_fee_refused_unauthorized_test", `${guard.message} Retry-pass charge refused for quote ${quoteId}.`);
      continue;
    }

    const cm = await deps.getChargeMethods(contractorId);
    if (!cm || cm.methods.length === 0) { await refuse("no_payment_method"); continue; }

    // AT-MOST-ONCE: consume the request BEFORE any Stripe call (compare-and-set); no row written = no charge.
    const written = await deps.markHandled(ids, nowIso, g.requestedAt);
    if (written < 1) {
      outcomes.push({ quoteKey: g.key, outcome: "skipped", reason: "could_not_consume_request" });
      continue;
    }
    charged++;

    const requestedAtMs = ms(g.requestedAt);
    let hardDeclines = 0;
    let done = false;
    for (const method of cm.methods) {
      const isCard = method.payment_type === "card";
      const chargeAmountCents = isCard ? cardChargeAmount(fee) : fee;
      const chargeReq: ChargeRequest = {
        quoteId,
        contractorId,
        claimId,
        customerId: cm.customerId,
        method,
        feeCents: fee,
        chargeAmountCents,
        idempotencyKey: attemptIdempotencyKey(quoteId, method.stripe_pm_id, g.requestedAt),
        requestedAtMs,
      };
      // WRITE-AHEAD (D1/D2): the marker + exact request land BEFORE the POST. No landed write = no Stripe call.
      const attempt: UnknownAttempt = { req: chargeReq, attemptedAt: deps.now().toISOString() };
      const landed = await deps.markUnknown(ids, attempt);
      if (landed < 1) {
        await deps.alert("dunning_retry_write_ahead_failed", `Retry pass: could not store the in-doubt marker for quote ${quoteId} (${method.payment_type} ****${method.stripe_pm_id.slice(-4)}); Stripe was NOT called.`);
        outcomes.push({ quoteKey: g.key, outcome: "skipped", reason: "could_not_write_ahead" });
        done = true;
        break;
      }
      const res = await deps.charge(chargeReq);
      if (res.status === "unknown") {
        // The charge may exist. The marker is already stored. NEVER try another method (a new key would not dedupe).
        await deps.alert("dunning_retry_unknown_outcome", `Retry pass: UNKNOWN Stripe outcome for quote ${quoteId} on ${method.payment_type} ****${method.stripe_pm_id.slice(-4)} (${res.message ?? "no detail"}). No further method tried; idempotency key ${chargeReq.idempotencyKey} is stored and the next pass replays that exact request.`);
        outcomes.push({ quoteKey: g.key, outcome: "unknown", methodType: method.payment_type });
        done = true;
        break;
      }
      if (res.status === "failed") {
        // definite decline: nothing in doubt. CAS on this attempt's key; if it does not land (an overlapping tick moved
        // the marker, or the write failed) STOP: the marker that is there is not ours to touch and not ours to outrun.
        if ((await deps.clearUnknown(ids, chargeReq.idempotencyKey)) < 1) {
          await deps.alert("dunning_retry_marker_moved", `Retry pass: after a definite decline for quote ${quoteId} the in-doubt marker no longer held key ${chargeReq.idempotencyKey}; stopped without trying another method.`);
          outcomes.push({ quoteKey: g.key, outcome: "skipped", reason: "marker_moved_on" });
          done = true;
          break;
        }
        if (isHardDecline(res.declineCode)) {
          hardDeclines++;
          await deps.alert("dunning_retry_hard_decline", `Retry pass: ${method.payment_type} ****${method.stripe_pm_id.slice(-4)} hard-declined (${res.declineCode}) for quote ${quoteId}.`);
        }
        continue; // a DEFINITE decline: next method; this method is not tried again in this request
      }
      const update: Record<string, unknown> = {
        payment_intent_id: res.paymentIntentId,
        payment_status: res.status === "succeeded" ? "succeeded" : "pending",
        payment_method_type: method.payment_type,
      };
      if (method.cpm_id) update.payment_method_id = method.cpm_id;
      if (isCard) update.card_fee_cents = chargeAmountCents - fee;
      const recorded = await recordResult(deps, quoteId, update, `Stripe ${res.status} (payment_intent ${res.paymentIntentId})`);
      if (res.status === "succeeded") await closeGroup(deps, g, quoteId);
      if (recorded) await deps.clearUnknown(ids, chargeReq.idempotencyKey); // settled; otherwise the marker stays and the next pass replays and records
      outcomes.push({
        quoteKey: g.key,
        outcome: res.status === "succeeded" ? "charged" : "processing",
        paymentIntentId: res.paymentIntentId as string,
        methodType: method.payment_type,
      });
      done = true;
      break; // never charge a second method after one has money in motion
    }
    if (!done) outcomes.push({ quoteKey: g.key, outcome: "all_methods_failed", hardDeclines });
  }
  return outcomes;
}

/**
 * N-g (REVIEW 6277377025): TRIGGER mode (stripe-webhook, async ACH failure) charges inline. It must not run while any row of
 * the quote carries the in-doubt marker, and when the retry pass is enabled it takes the same lease as the CRON pass.
 * Both refusals are logged and alerted; nothing is charged. Pure; wired by buildTriggerGateDeps.
 */
export interface TriggerGateDeps {
  quoteHasUnknownMarker: (quoteId: string) => Promise<boolean | "error">;
  acquireLease: () => Promise<string | null>;
  releaseLease: (token: string) => Promise<void>;
  alert: (type: string, message: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}
export type TriggerGate = { proceed: true; release: () => Promise<void> } | { proceed: false; reason: string };

export async function gateTrigger(deps: TriggerGateDeps, quoteId: string, leaseRequired: boolean): Promise<TriggerGate> {
  const refuse = async (reason: string, text: string): Promise<TriggerGate> => {
    console.error(`[process-dunning] TRIGGER for quote ${quoteId} skipped: ${reason}`);
    await deps.alert("dunning_trigger_skipped", `TRIGGER charge for quote ${quoteId} skipped (${reason}). ${text}`);
    return { proceed: false, reason };
  };
  let token: string | null = null;
  if (leaseRequired) {
    for (let i = 0; i < 3 && !token; i++) { token = await deps.acquireLease(); if (!token && i < 2) await deps.sleep(1500); }
    if (!token) return refuse("another_pass_holds_the_lease", "The retry pass holds the lease (or it is unreadable); re-send the failure once it is free.");
  }
  const release = async () => { if (token) { try { await deps.releaseLease(token); } catch (_) { /* expires on its own */ } } };
  const m = await deps.quoteHasUnknownMarker(quoteId);
  if (m !== false) {
    await release();
    return refuse(m === "error" ? "unknown_marker_unreadable" : "unknown_outcome_pending",
      "A retry attempt for this quote is in doubt (retry_unknown_at) and the quote may already be paid; resolve it first (replay by idempotency key) before any new charge.");
  }
  return { proceed: true, release };
}
