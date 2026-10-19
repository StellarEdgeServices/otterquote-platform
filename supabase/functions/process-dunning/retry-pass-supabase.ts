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
      const data = await resp.json();
      if (resp.ok && data.status === "succeeded") {
        return { status: "succeeded", paymentIntentId: data.id, declineCode: null, message: null };
      }
      if (resp.ok && data.status === "processing") {
        return { status: "processing", paymentIntentId: data.id, declineCode: null, message: null };
      }
      // Cancel a stuck intent, as TRIGGER mode does. Non-fatal.
      if (data?.id && (data.status === "requires_action" || data.status === "requires_payment_method")) {
        try {
          await fetchFn(`${STRIPE_API_BASE}/payment_intents/${data.id}/cancel`, {
            method: "POST",
            headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
          });
        } catch (_) { /* non-fatal */ }
      }
      const err = data?.error ?? data?.last_payment_error ?? {};
      return {
        status: "failed",
        paymentIntentId: data?.id ?? null,
        declineCode: err.decline_code ?? err.code ?? null,
        message: err.message ?? data?.status ?? "unknown",
      };
    } catch (e) {
      return { status: "failed", paymentIntentId: null, declineCode: null, message: String(e) };
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
      const { data, error } = await supabase
        .from("payment_failures")
        .select("id, quote_id, contractor_id, claim_id, amount_cents, dunning_status, resolved_at, homeowner_notify_at, retry_requested_at, retry_request_count, retry_handled_at")
        .not("retry_requested_at", "is", null)
        .gte("retry_requested_at", sinceIso);
      if (error) throw new Error(`retry pass: could not list requests: ${error.message}`);
      return (data ?? []) as FailureRow[];
    },
    async markHandled(rowIds: string[], nowIso: string): Promise<number> {
      const { data, error } = await supabase
        .from("payment_failures")
        .update({ retry_handled_at: nowIso })
        .in("id", rowIds)
        .select("id");
      if (error) { console.error("[process-dunning] retry_handled_at write failed:", error); return 0; }
      return Array.isArray(data) ? data.length : 0;
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
