/**
 * [#2862] Decking-price halt, extracted from index.ts (behaviour-neutral move)
 * so it can be driven with a stubbed Supabase client. index.ts calls
 * `runDeckingGate(...)` right after the contract-price chain and, when it
 * returns a Response, returns it -- i.e. before the D-127 charge block.
 *
 * Mirrors the contract-price mismatch halt: console.error, platform_alerts_log,
 * Sentry, deduped ops notification, HTTP 200. Returns null to proceed (match,
 * or a FLAG case: blank tab / NULL quote rate -- see price-verify.ts).
 */
import { deckingDispositionFor, deckingVerdictFor } from "./price-verify.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

export interface DeckingGateInput {
  supabase: AnySupabase;
  claimId: string;
  envelopeId: string;
  quoteId: string | null | undefined;
  /** quotes.decking_price_per_sheet of the accepted quote */
  quotedDecking: unknown;
  /** BoldSign signerDetails list from the successful properties read */
  signers: unknown[];
  reportToSentry: (
    err: unknown,
    ctx: { fn: string; op?: string; extra?: Record<string, unknown> },
  ) => Promise<unknown> | unknown;
  corsHeaders: Record<string, string>;
}

export async function runDeckingGate(i: DeckingGateInput): Promise<Response | null> {
  const { supabase, claimId, envelopeId } = i;
  const deckingExpected = i.quotedDecking != null ? Number(i.quotedDecking) : null;
  const deckingVerdict = deckingVerdictFor(i.signers, deckingExpected);
  const deckingDisposition = deckingDispositionFor(deckingVerdict);
  if (deckingDisposition === "halt") {
    const detail = deckingVerdict.state === "mismatch"
      ? `signed ${deckingVerdict.signed} vs quoted ${deckingExpected} (delta ${deckingVerdict.delta})`
      : `unreadable signed decking value ${JSON.stringify(deckingVerdict.state === "unverified" ? deckingVerdict.raw : null)} vs quoted ${deckingExpected}`;
    console.error(`[#2862] DECKING PRICE MISMATCH on envelope ${envelopeId}: ${detail} -- HALTED before charging`);
    try {
      await supabase.from("platform_alerts_log").insert({
        alert_type: "signed_decking_price_mismatch",
        function_name: "docusign-webhook",
        message:
          `#2862: envelope ${envelopeId} (claim ${claimId}, quote ${i.quoteId}) decking per sheet: ${detail}. ` +
          `Completion HALTED before charging: contract_signed not set, no platform fee charged, ` +
          `no invoice. Void/resend the envelope or record a disposition.`,
      });
    } catch (alertErr) {
      console.error("platform_alerts_log insert failed:", alertErr);
    }
    await i.reportToSentry(
      new Error(`#2862 signed decking-price mismatch: envelope ${envelopeId} ${detail}`),
      { fn: "docusign-webhook", op: "decking-price-reconciliation", extra: { envelope_id: envelopeId, claim_id: claimId, expected: deckingExpected } },
    );
    try {
      const { data: existingDecking } = await supabase
        .from("notifications")
        .select("id")
        .eq("notification_type", "decking_price_mismatch_pending")
        .like("message_preview", `envelope=${envelopeId};%`)
        .limit(1)
        .maybeSingle();
      if (!existingDecking) {
        await supabase.from("notifications").insert({
          claim_id: claimId,
          channel: "system",
          notification_type: "decking_price_mismatch_pending",
          recipient: "ops",
          message_preview: `envelope=${envelopeId};quoted=${deckingExpected}`,
        });
      }
    } catch (recErr) {
      console.error("notifications insert failed:", recErr);
    }
    // 200 so BoldSign does not retry forever; remediation is manual.
    return new Response(
      JSON.stringify({ received: true, defect: "decking_price_mismatch", claim_id: claimId, expected: deckingExpected }),
      { status: 200, headers: { ...i.corsHeaders, "Content-Type": "application/json" } },
    );
  } else if (deckingDisposition === "flag") {
    console.warn(`[#2862] decking reconciliation skipped for envelope ${envelopeId}: ${deckingVerdict.state === "unverified" ? deckingVerdict.reason : "n/a"} (no decking figure to contradict)`);
  }
  return null;
}
