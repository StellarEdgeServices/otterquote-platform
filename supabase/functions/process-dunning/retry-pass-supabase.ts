/**
 * gh-2442 -- real wiring for retry-pass.ts: Supabase (service role) + Stripe over HTTPS.
 * Kept separate so retry-pass.ts stays pure. `httpFn` is injectable so the Stripe request (URL, headers,
 * idempotency key, form body) is asserted in tests/gh2442-dunning-retry-pass.mjs without a network.
 *
 * Every .update( chains .select( (gh-2105 ratchet): a zero-row write is reported, never assumed.
 */
import { QUOTE_STATUS_UNREADABLE } from "./retry-pass.ts";
import type { ChargeMethod, ChargeRequest, ChargeResult, FailureRow, RetryPassDeps, UnknownAttempt } from "./retry-pass.ts";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * The only network call in this module. Takes a PATH under STRIPE_API_BASE (not a URL) so that the gh-2884 transport
 * guard (sms-all-bodies.test.ts) can see every request goes to the allow-listed Stripe base; tests inject a fake.
 */
export type StripeHttp = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
/** A hung Stripe call must become `unknown` inside the Edge Function wall-clock limit (REVIEW 6276858298 D1). */
export const STRIPE_TIMEOUT_MS = 20_000;
/** A pass that dies leaves the lease to expire after this long. */
export const LEASE_TTL_MS = 10 * 60 * 1000;
export const stripeHttp: StripeHttp = (path, init) =>
  fetch(`${STRIPE_API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) });

export interface GuardApi {
  GUARD_SELECT: string;
  evaluateLiveChargeGuard: (claim: any) => { allow: boolean; reason?: string };
  describeGuardVerdict: (verdict: any, claimId: string | null, amountCents: number) => string;
}

export function buildStripeCharge(stripeSecretKey: string, httpFn: StripeHttp) {
  const basicAuth = btoa(`${stripeSecretKey}:`);
  return async (req: ChargeRequest): Promise<ChargeResult> => {
    const form = new URLSearchParams();
    form.append("amount", String(req.chargeAmountCents));
    form.append("currency", "usd");
    form.append("customer", req.customerId);
    form.append("payment_method", req.method.stripe_pm_id);
    form.append("off_session", "true");
    form.append("confirm", "true");
    form.append("description", `Otter Quotes platform fee — quote ${req.quoteId.substring(0, 8)}`);
    form.append("metadata[claim_id]", req.claimId);
    form.append("metadata[type]", "platform_fee");
    form.append("metadata[contractor_id]", req.contractorId);
    form.append("metadata[payment_type]", req.method.payment_type);
    form.append("metadata[platform_fee_cents]", String(req.feeCents));
    form.append("metadata[source]", "dunning_retry_request");
    form.append("metadata[quote_id]", req.quoteId); // lets a later pass find this intent without re-charging
    form.append("metadata[retry_requested_ms]", String(req.requestedAtMs));
    form.append("payment_method_types[]", req.method.payment_type === "us_bank_account" ? "us_bank_account" : "card");
    try {
      const resp = await httpFn("/payment_intents", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": req.idempotencyKey,
        },
        body: form.toString(),
      });
      let data: any;
      try { data = await resp.json(); } catch (_) {
        return { status: "unknown", paymentIntentId: null, declineCode: null, message: `non-JSON response (HTTP ${resp.status})` };
      }
      if (resp.ok && data.status === "succeeded") {
        return { status: "succeeded", paymentIntentId: data.id, declineCode: null, message: null };
      }
      if (resp.ok && data.status === "processing") {
        return { status: "processing", paymentIntentId: data.id, declineCode: null, message: null };
      }
      const err = data?.error ?? data?.last_payment_error ?? {};
      // DEFINITE decline only: Stripe answered 402 card_error, or returned an intent that needs a new payment
      // method / action (no money moved). Everything else (5xx, 409, 429, odd 2xx status, any other 4xx) leaves the
      // outcome unknown: the charge may exist, so the caller must stop and never try another method.
      const definite =
        (resp.status === 402 && (err.type === "card_error" || data?.error?.payment_intent)) ||
        (resp.ok && (data?.status === "requires_payment_method" || data?.status === "requires_action" || data?.status === "canceled"));
      if (!definite) {
        return { status: "unknown", paymentIntentId: data?.id ?? data?.error?.payment_intent?.id ?? null, declineCode: null, message: `HTTP ${resp.status} ${err.code ?? data?.status ?? "unexpected response"}` };
      }
      // Cancel a stuck intent, as TRIGGER mode does. Non-fatal.
      const stuckId = data?.id ?? data?.error?.payment_intent?.id;
      if (stuckId && (data?.status === "requires_action" || data?.status === "requires_payment_method")) {
        try {
          await httpFn(`/payment_intents/${stuckId}/cancel`, {
            method: "POST",
            headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
          });
        } catch (_) { /* non-fatal */ }
      }
      return {
        status: "failed",
        paymentIntentId: stuckId ?? null,
        declineCode: err.decline_code ?? err.code ?? null,
        message: err.message ?? data?.status ?? "declined",
      };
    } catch (e) {
      // Thrown fetch (timeout, reset, DNS): the request may have reached Stripe. Unknown, not a decline.
      return { status: "unknown", paymentIntentId: null, declineCode: null, message: String(e) };
    }
  };
}

async function insertAlert(supabase: any, alertType: string, message: string): Promise<void> {
  try {
    await supabase.from("platform_alerts_log").insert({
      alert_type: alertType, function_name: "process-dunning", message, sent_at: new Date().toISOString(),
    });
  } catch (e) { console.error("[process-dunning] platform_alerts_log insert failed:", e); }
}

/**
 * Single-row lease (dunning_retry_pass_lease), shared by the CRON retry pass and TRIGGER mode (N-g).
 * Fails closed: an unreadable lease means "do not charge this tick", and that raises a platform_alerts_log alert (N-h),
 * not only console.error.
 */
export function leaseOps(supabase: any, nowFn: () => Date = () => new Date()) {
  return {
    async acquire(): Promise<string | null> {
      const token = crypto.randomUUID();
      const t = nowFn();
      const { data, error } = await supabase
        .from("dunning_retry_pass_lease")
        .update({ holder: token, locked_until: new Date(t.getTime() + LEASE_TTL_MS).toISOString() })
        .eq("id", 1)
        .lt("locked_until", t.toISOString())
        .select("id");
      if (error) {
        console.error("[process-dunning] dunning lease unavailable; nothing charged this tick:", error);
        await insertAlert(supabase, "dunning_retry_lease_unreadable",
          `dunning_retry_pass_lease could not be read or written (${error.message ?? String(error)}); the retry pass / TRIGGER charge was skipped. Check the lease migration is applied.`);
        return null;
      }
      return Array.isArray(data) && data.length > 0 ? token : null;
    },
    async release(token: string): Promise<void> {
      await supabase
        .from("dunning_retry_pass_lease")
        .update({ locked_until: new Date(0).toISOString() })
        .eq("id", 1)
        .eq("holder", token)
        .select("id");
    },
  };
}

/** TRIGGER-mode gate wiring (N-g). */
export function buildTriggerGateDeps(supabase: any, nowFn: () => Date = () => new Date()) {
  const lease = leaseOps(supabase, nowFn);
  return {
    acquireLease: () => lease.acquire(),
    releaseLease: (t: string) => lease.release(t),
    async quoteHasUnknownMarker(quoteId: string): Promise<boolean | "error"> {
      const { data, error } = await supabase.from("payment_failures").select("id").eq("quote_id", quoteId).not("retry_unknown_at", "is", null);
      if (error) return "error";
      return Array.isArray(data) && data.length > 0;
    },
    alert: (type: string, message: string) => insertAlert(supabase, type, message),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

export function buildRetryPassDeps(
  supabase: any,
  stripeSecretKey: string,
  guard: GuardApi,
  httpFn: StripeHttp = stripeHttp,
  nowFn: () => Date = () => new Date(),
): RetryPassDeps {
  return {
    now: nowFn,
    async listCandidateRows(sinceIso: string): Promise<FailureRow[]> {
      const cols = "id, quote_id, contractor_id, claim_id, amount_cents, dunning_status, resolved_at, homeowner_notify_at, retry_requested_at, retry_request_count, retry_handled_at, retry_unknown_at, retry_unknown_attempt";
      const { data: req, error } = await supabase
        .from("payment_failures")
        .select(cols)
        .not("retry_requested_at", "is", null)
        .gte("retry_requested_at", sinceIso);
      if (error) throw new Error(`retry pass: could not list requests: ${error.message}`);
      const byId = new Map<string, FailureRow>();
      for (const r of (req ?? []) as FailureRow[]) byId.set(r.id, r);
      // The request sits on ONE row, but a failed payment is the whole QUOTE (the webhook row and the scheduled row).
      // Read every row of each requested quote so the refusal checks see the whole group.
      const quoteIds = [...new Set([...byId.values()].map((r) => r.quote_id).filter((q): q is string => !!q))];
      if (quoteIds.length > 0) {
        const { data: all, error: allErr } = await supabase.from("payment_failures").select(cols).in("quote_id", quoteIds);
        if (allErr) throw new Error(`retry pass: could not read the quote's rows: ${allErr.message}`);
        for (const r of (all ?? []) as FailureRow[]) byId.set(r.id, r);
      }
      return [...byId.values()];
    },
    async markHandled(rowIds: string[], nowIso: string, requestedAtIso: string): Promise<number> {
      // Compare-and-set: only rows not yet handled for this (or a newer) request. Two overlapping ticks cannot both win.
      const requested = new Date(requestedAtIso).toISOString();
      const { data, error } = await supabase
        .from("payment_failures")
        .update({ retry_handled_at: nowIso })
        .in("id", rowIds)
        .or(`retry_handled_at.is.null,retry_handled_at.lt.${requested}`)
        .select("id");
      if (error) { console.error("[process-dunning] retry_handled_at write failed:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
    },
    async refundRequest(rowId: string, currentCount: number): Promise<boolean> {
      const { data, error } = await supabase
        .from("payment_failures")
        .update({ retry_request_count: Math.max(0, currentCount - 1) })
        .eq("id", rowId)
        .eq("retry_request_count", currentCount)
        .select("id");
      if (error) { console.error("[process-dunning] retry request refund failed:", error); return false; }
      return Array.isArray(data) && data.length > 0;
    },
    async markUnknown(rowIds: string[], attempt: UnknownAttempt): Promise<number> {
      // Write-once (.is NULL): a later request can never move the stored key of the attempt in doubt.
      const { data, error } = await supabase
        .from("payment_failures")
        .update({ retry_unknown_at: attempt.attemptedAt, retry_unknown_attempt: attempt })
        .in("id", rowIds)
        .is("retry_unknown_at", null)
        .select("id");
      if (error) { console.error("[process-dunning] retry_unknown_at write failed:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
    },
    async markStuckAlerted(rowIds: string[], attempt: UnknownAttempt, nowIso: string): Promise<number> {
      // Adds stuckAlertedAt to the stored attempt (request and key copied unchanged). Compare-and-set: only rows that
      // still hold THIS attempt (by key) and have no flag yet, so exactly one tick wins and alerts.
      const { data, error } = await supabase
        .from("payment_failures")
        .update({ retry_unknown_attempt: { ...attempt, stuckAlertedAt: nowIso } })
        .in("id", rowIds)
        .eq("retry_unknown_attempt->req->>idempotencyKey", attempt.req.idempotencyKey)
        .is("retry_unknown_attempt->>stuckAlertedAt", null)
        .select("id");
      if (error) { console.error("[process-dunning] stuck-alert flag write failed:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
    },
    async retrieveIntent(paymentIntentId: string) {
      if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return { error: "bad_intent_id" };
      try {
        const resp = await httpFn(`/payment_intents/${paymentIntentId}`, {
          method: "GET",
          headers: { Authorization: `Basic ${btoa(`${stripeSecretKey}:`)}` },
        });
        const data = await resp.json();
        if (!resp.ok || typeof data?.status !== "string") return { error: `HTTP ${resp.status}` };
        return { status: data.status as string };
      } catch (e) { return { error: String(e) }; }
    },
    async countOpenRows(rowIds: string[]) {
      const { data, error } = await supabase
        .from("payment_failures").select("id").in("id", rowIds).in("dunning_status", ["active", "warning_sent"]).is("resolved_at", null);
      if (error) return rowIds.length; // cannot tell: treat as still open so the alert is raised
      return Array.isArray(data) ? data.length : 0;
    },
    async clearUnknown(rowIds: string[], idempotencyKey: string): Promise<number> {
      // Compare-and-set on the stored attempt's idempotency key (never a timestamp): only clears the attempt it settles.
      const { data, error } = await supabase
        .from("payment_failures")
        .update({ retry_unknown_at: null, retry_unknown_attempt: null })
        .in("id", rowIds)
        .eq("retry_unknown_attempt->req->>idempotencyKey", idempotencyKey)
        .select("id");
      if (error) { console.error("[process-dunning] retry_unknown_at clear failed:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
    },
    acquireLease: () => leaseOps(supabase, nowFn).acquire(),
    releaseLease: (token: string) => leaseOps(supabase, nowFn).release(token),
    async getQuotePaymentStatus(quoteId: string) {
      // I-2: a failed read is NOT "no status": it is the distinct unreadable sentinel, which every caller treats as "do not charge".
      try {
        const { data, error } = await supabase.from("quotes").select("payment_status").eq("id", quoteId).maybeSingle();
        if (error) { console.error(`[process-dunning] quote ${quoteId} payment_status read failed:`, error); return QUOTE_STATUS_UNREADABLE; }
        return data?.payment_status ?? null;
      } catch (e) { console.error(`[process-dunning] quote ${quoteId} payment_status read threw:`, e); return QUOTE_STATUS_UNREADABLE; }
    },
    async chargeGuard(claimId: string | null) {
      const { data: claim } = await supabase.from("claims").select(guard.GUARD_SELECT).eq("id", claimId ?? "").maybeSingle();
      const verdict = guard.evaluateLiveChargeGuard(claim);
      return { allow: verdict.allow, reason: verdict.reason, message: verdict.allow ? "" : guard.describeGuardVerdict(verdict, claimId, 0) };
    },
    async getChargeMethods(contractorId: string) {
      const { data: c } = await supabase.from("contractors").select("stripe_customer_id, stripe_payment_method_id").eq("id", contractorId).single();
      if (!c?.stripe_customer_id) return null;
      const { data: all } = await supabase
        .from("contractor_payment_methods").select("*").eq("contractor_id", contractorId)
        .order("is_default", { ascending: false }).order("payment_type", { ascending: true });
      const methods: ChargeMethod[] = [];
      if (all && all.length > 0) {
        // Same order as TRIGGER mode: default first, then bank accounts, then cards.
        const def = all.find((m: any) => m.is_default);
        const rest = all.filter((m: any) => !m.is_default);
        const pick = (m: any): ChargeMethod => ({ stripe_pm_id: m.stripe_payment_method_id, payment_type: m.payment_type, cpm_id: m.id });
        if (def) methods.push(pick(def));
        for (const m of rest.filter((x: any) => x.payment_type === "us_bank_account")) methods.push(pick(m));
        for (const m of rest.filter((x: any) => x.payment_type === "card")) methods.push(pick(m));
      } else if (c.stripe_payment_method_id) {
        methods.push({ stripe_pm_id: c.stripe_payment_method_id, payment_type: "card", cpm_id: null });
      }
      return { customerId: c.stripe_customer_id, methods };
    },
    charge: buildStripeCharge(stripeSecretKey, httpFn),
    async recordQuoteResult(quoteId: string, update: Record<string, unknown>) {
      // N-p: compare-and-set; a result is never written over a refunded quote (NULL counts as not refunded).
      const { data, error } = await supabase.from("quotes").update(update).eq("id", quoteId).or("payment_status.is.null,payment_status.neq.refunded").select("id");
      if (error) { console.error(`[process-dunning] retry pass quotes update failed for ${quoteId}:`, error); return false; }
      return Array.isArray(data) && data.length > 0;
    },
    async closeDunningRows(rowIds: string[], nowIso: string) {
      const { data, error } = await supabase
        .from("payment_failures")
        .update({ dunning_status: "resolved", resolved_at: nowIso, next_reminder_at: null })
        .in("id", rowIds)
        .in("dunning_status", ["active", "warning_sent"])
        .select("id");
      if (error) { console.error("[process-dunning] retry pass could not close dunning rows:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
    },
    async alert(alertType: string, message: string) {
      try {
        await supabase.from("platform_alerts_log").insert({
          alert_type: alertType, function_name: "process-dunning", message, sent_at: new Date().toISOString(),
        });
      } catch (e) { console.error("[process-dunning] platform_alerts_log insert failed:", e); }
    },
  };
}
