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
 * AT-MOST-ONCE. `retry_handled_at` is written BEFORE any Stripe call. If that write fails or matches no row,
 * nothing is charged. A crash after the write loses the attempt (the contractor can ask again, subject to the
 * cap); it can never charge twice. The Stripe idempotency key carries the request timestamp as a second lock.
 *
 * NOT DONE HERE: the card-surcharge formula is copied from TRIGGER mode (index.ts "MULTI-METHOD RETRY") rather than
 * extracted from it, so the live TRIGGER path is untouched by this change. tests/gh2442-dunning-retry-pass.mjs pins
 * the two formulas together.
 */

export const MAX_REQUESTS_PER_QUOTE = 3; // D-379
export const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1000; // a request older than this is never charged
export const MAX_QUOTES_PER_RUN = 10; // blast-radius cap per cron tick
export const OPEN_STATUSES = ["active", "warning_sent"];

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
}

export interface ChargeResult {
  status: "succeeded" | "processing" | "failed";
  paymentIntentId: string | null;
  declineCode: string | null;
  message: string | null;
}

export interface RetryPassDeps {
  now: () => Date;
  listCandidateRows: (sinceIso: string) => Promise<FailureRow[]>;
  /** Stamp retry_handled_at on these rows. Returns the number of rows actually written. */
  markHandled: (rowIds: string[], nowIso: string) => Promise<number>;
  getQuotePaymentStatus: (quoteId: string) => Promise<string | null>;
  /** Live-charge guard (#1467): fails closed. */
  chargeGuard: (claimId: string | null) => Promise<{ allow: boolean; message: string }>;
  getChargeMethods: (contractorId: string) => Promise<{ customerId: string; methods: ChargeMethod[] } | null>;
  charge: (req: ChargeRequest) => Promise<ChargeResult>;
  recordQuoteResult: (
    quoteId: string,
    update: Record<string, unknown>,
  ) => Promise<boolean>;
  /** Stop the reminder sequence for a quote whose fee has now been collected. Rows written. */
  closeDunningRows: (rowIds: string[], nowIso: string) => Promise<number>;
  alert: (alertType: string, message: string) => Promise<void>;
}

export type GroupOutcome =
  | { quoteKey: string; outcome: "charged"; paymentIntentId: string; methodType: string }
  | { quoteKey: string; outcome: "processing"; paymentIntentId: string; methodType: string }
  | { quoteKey: string; outcome: "all_methods_failed"; hardDeclines: number }
  | { quoteKey: string; outcome: "refused"; reason: string }
  | { quoteKey: string; outcome: "skipped"; reason: string };

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

export async function runRetryPass(deps: RetryPassDeps): Promise<GroupOutcome[]> {
  const now = deps.now();
  const sinceIso = new Date(now.getTime() - 3 * MAX_REQUEST_AGE_MS).toISOString();
  const rows = await deps.listCandidateRows(sinceIso);
  const pending = groupRows(rows).filter(isPending);
  const outcomes: GroupOutcome[] = [];
  let charged = 0;

  for (const g of pending) {
    const nowIso = deps.now().toISOString();
    const ids = g.rows.map((r) => r.id);
    const reason = refusalReason(g, deps.now());
    if (reason) {
      await deps.markHandled(ids, nowIso); // consume it so it is not rescanned; no charge
      outcomes.push({ quoteKey: g.key, outcome: "refused", reason });
      continue;
    }
    if (charged >= MAX_QUOTES_PER_RUN) {
      outcomes.push({ quoteKey: g.key, outcome: "skipped", reason: "run_cap_next_tick" }); // left pending
      continue;
    }
    const quoteId = g.quoteId;
    const claimId = g.rows.find((r) => r.claim_id)?.claim_id ?? null;
    const fee = g.rows.reduce((m, r) => (r.amount_cents > m ? r.amount_cents : m), 0);
    const contractorId = g.rows[0].contractor_id;
    if (!quoteId || !claimId || !(fee > 0)) {
      await deps.markHandled(ids, nowIso);
      outcomes.push({ quoteKey: g.key, outcome: "refused", reason: "missing_quote_claim_or_amount" });
      continue;
    }

    const payStatus = await deps.getQuotePaymentStatus(quoteId);
    if (payStatus === "succeeded" || payStatus === "pending") {
      await deps.markHandled(ids, nowIso);
      outcomes.push({ quoteKey: g.key, outcome: "refused", reason: `quote_payment_${payStatus}` });
      continue;
    }

    const guard = await deps.chargeGuard(claimId);
    if (!guard.allow) {
      await deps.markHandled(ids, nowIso);
      await deps.alert("platform_fee_refused_unauthorized_test", `${guard.message} Retry-pass charge refused for quote ${quoteId}.`);
      outcomes.push({ quoteKey: g.key, outcome: "refused", reason: "live_charge_guard" });
      continue;
    }

    const cm = await deps.getChargeMethods(contractorId);
    if (!cm || cm.methods.length === 0) {
      await deps.markHandled(ids, nowIso);
      outcomes.push({ quoteKey: g.key, outcome: "refused", reason: "no_payment_method" });
      continue;
    }

    // AT-MOST-ONCE: consume the request BEFORE any Stripe call; no row written = no charge.
    const written = await deps.markHandled(ids, nowIso);
    if (written < 1) {
      outcomes.push({ quoteKey: g.key, outcome: "skipped", reason: "could_not_consume_request" });
      continue;
    }
    charged++;

    let hardDeclines = 0;
    let done = false;
    for (const method of cm.methods) {
      const isCard = method.payment_type === "card";
      const chargeAmountCents = isCard ? cardChargeAmount(fee) : fee;
      const res = await deps.charge({
        quoteId,
        contractorId,
        claimId,
        customerId: cm.customerId,
        method,
        feeCents: fee,
        chargeAmountCents,
        idempotencyKey: attemptIdempotencyKey(quoteId, method.stripe_pm_id, g.requestedAt),
      });
      if (res.status === "failed") {
        if (isHardDecline(res.declineCode)) {
          hardDeclines++;
          await deps.alert("dunning_retry_hard_decline", `Retry pass: ${method.payment_type} ****${method.stripe_pm_id.slice(-4)} hard-declined (${res.declineCode}) for quote ${quoteId}.`);
        }
        continue; // next method; this method is not tried again in this request
      }
      const update: Record<string, unknown> = {
        payment_intent_id: res.paymentIntentId,
        payment_status: res.status === "succeeded" ? "succeeded" : "pending",
        payment_method_type: method.payment_type,
      };
      if (method.cpm_id) update.payment_method_id = method.cpm_id;
      if (isCard) update.card_fee_cents = chargeAmountCents - fee;
      const recorded = await deps.recordQuoteResult(quoteId, update);
      if (!recorded) {
        await deps.alert("gh2105_zero_row_update", `Retry pass for quote ${quoteId}: Stripe ${res.status} (payment_intent ${res.paymentIntentId}) but the quotes write matched zero rows.`);
      }
      if (res.status === "succeeded") await deps.closeDunningRows(ids, deps.now().toISOString());
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
