/**
 * gh-2442 -- real wiring for retry-pass.ts: Supabase (service role) + Stripe over fetch.
 * Kept separate so retry-pass.ts stays pure. `fetchFn` is injectable so the Stripe request (URL, headers,
 * idempotency key, form body) is asserted in tests/gh2442-dunning-retry-pass.mjs without a network.
 *
 * Every .update( chains .select( (gh-2105 ratchet): a zero-row write is reported, never assumed.
 */
import type { ChargeMethod, ChargeRequest, ChargeResult, FailureRow, RetryPassDeps } from "./retry-pass.ts";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

export interface GuardApi {
  GUARD_SELECT: string;
  evaluateLiveChargeGuard: (claim: any) => { allow: boolean };
  describeGuardVerdict: (verdict: any, claimId: string | null, amountCents: number) => string;
}

export function buildStripeCharge(stripeSecretKey: string, fetchFn: typeof fetch) {
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
      const resp = await fetchFn(`${STRIPE_API_BASE}/payment_intents`, {
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
          await fetchFn(`${STRIPE_API_BASE}/payment_intents/${stuckId}/cancel`, {
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

export function buildRetryPassDeps(
  supabase: any,
  stripeSecretKey: string,
  guard: GuardApi,
  fetchFn: typeof fetch = fetch,
  nowFn: () => Date = () => new Date(),
): RetryPassDeps {
  return {
    now: nowFn,
    async listCandidateRows(sinceIso: string): Promise<FailureRow[]> {
      const cols = "id, quote_id, contractor_id, claim_id, amount_cents, dunning_status, resolved_at, homeowner_notify_at, retry_requested_at, retry_request_count, retry_handled_at, retry_unknown_at";
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
    async markUnknown(rowIds: string[], nowIso: string): Promise<number> {
      const { data, error } = await supabase.from("payment_failures").update({ retry_unknown_at: nowIso }).in("id", rowIds).select("id");
      if (error) { console.error("[process-dunning] retry_unknown_at write failed:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
    },
    async clearUnknown(rowIds: string[]): Promise<number> {
      const { data, error } = await supabase.from("payment_failures").update({ retry_unknown_at: null }).in("id", rowIds).select("id");
      if (error) { console.error("[process-dunning] retry_unknown_at clear failed:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
    },
    async lookupIntent(quoteId: string, requestedAtMs: number) {
      if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !Number.isFinite(requestedAtMs)) return { error: "bad_lookup_args" };
      try {
        const q = `metadata['quote_id']:'${quoteId}' AND metadata['retry_requested_ms']:'${requestedAtMs}'`;
        const resp = await fetchFn(`${STRIPE_API_BASE}/payment_intents/search?query=${encodeURIComponent(q)}`, {
          method: "GET",
          headers: { Authorization: `Basic ${btoa(`${stripeSecretKey}:`)}` },
        });
        const data = await resp.json();
        if (!resp.ok || !Array.isArray(data?.data)) return { error: `HTTP ${resp.status}` };
        if (data.data.length === 0) return { found: false as const };
        const best = data.data.find((i: any) => i.status === "succeeded") ?? data.data.find((i: any) => i.status === "processing") ?? data.data[0];
        return { found: true as const, id: best.id as string, status: best.status as string };
      } catch (e) { return { error: String(e) }; }
    },
    async getQuotePaymentStatus(quoteId: string) {
      const { data } = await supabase.from("quotes").select("payment_status").eq("id", quoteId).maybeSingle();
      return data?.payment_status ?? null;
    },
    async chargeGuard(claimId: string | null) {
      const { data: claim } = await supabase.from("claims").select(guard.GUARD_SELECT).eq("id", claimId ?? "").maybeSingle();
      const verdict = guard.evaluateLiveChargeGuard(claim);
      return { allow: verdict.allow, message: verdict.allow ? "" : guard.describeGuardVerdict(verdict, claimId, 0) };
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
    charge: buildStripeCharge(stripeSecretKey, fetchFn),
    async recordQuoteResult(quoteId: string, update: Record<string, unknown>) {
      const { data, error } = await supabase.from("quotes").update(update).eq("id", quoteId).select("id");
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
