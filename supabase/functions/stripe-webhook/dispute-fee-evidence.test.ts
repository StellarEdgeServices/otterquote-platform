// gh-3409 (REVIEW 6669923343 B2): the webhook's ACTUAL reading of the anchored acceptance, end to end: the database reads, the pick, the Stripe evidence text and the
// ClickUp fee block, all through assembleDisputeFeeEvidence() (the code index.ts calls). Each test below fails if a link in that chain is broken;
// supabase/tests/gh3409_webhook_mutants.sh breaks each link in a copy of the code and requires a failure.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assembleDisputeFeeEvidence, type FeeAcceptanceRow } from "./dispute-fee-evidence.ts";
import { stripComments } from "./test-source-utils.ts";

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let lim = Infinity;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return q; },
        order: (c: string, o: { ascending: boolean }) => { rows.sort((a, b) => (String(a[c]) < String(b[c]) ? 1 : -1) * (o.ascending ? -1 : 1)); return q; },
        limit: (n: number) => { lim = n; return q; },
        then: (res: (v: { data: Row[] }) => void) => res({ data: rows.slice(0, lim) }),
      };
      return q;
    },
  };
}
const dispute = { id: "dp_123456789", charge: "ch_1", amount: 75000, currency: "usd", reason: "fraudulent" };
const C = "con-1";
const claim = { id: "claim-1", selected_contractor_id: C, contract_signed_at: "2026-11-01T00:00:00Z", completion_date: null };
const TEXT = "Platform fee for this job: $750.00 (5.00% of your bid). By submitting this bid, you agree to pay Otter Quotes this fee ...";
const bid = { id: "bid-sel", claim_id: "claim-1", contractor_id: C, status: "selected", fee_amount: 750, created_at: "2026-11-01T10:00:00Z" };
const row = (over: Row = {}): Row => ({ id: "fa-1", claim_id: "claim-1", contractor_id: C, bid_id: "bid-sel", fee_pct: 5, fee_amount: 750, fee_text_displayed: TEXT, accepted_at: "2026-11-01T10:00:01Z", ip_address: "203.0.113.7", user_agent: "UA", invoice_url: null, rescinded_at: null, created_at: "2026-11-01T10:00:01Z", ...over });
const run = (tables: Record<string, Row[]>, quote: { id: string; claim_id: string; contractor_id: string; fee_amount: number | null } | null = null) =>
  assembleDisputeFeeEvidence(fakeDb(tables), dispute, claim, quote);
const stripeText = (e: { evidencePayload: Record<string, string> }) => Object.values(e.evidencePayload).join("\n");

Deno.test("end to end: the selected bid's acceptance reaches the Stripe evidence and the task", async () => {
  const e = await run({ quotes: [bid], fee_acceptances: [row()] });
  assertEquals((e.feeAcceptance as FeeAcceptanceRow).id, "fa-1");
  assertEquals(e.feeAcceptanceMissingReason, null);
  assert(stripeText(e).includes("Fee Amount: $750.00"), "Stripe evidence carries the accepted fee");
  assert(stripeText(e).includes(TEXT), "Stripe evidence carries the text the contractor was shown");
  assert(stripeText(e).includes("IP Address: 203.0.113.7"));
  assert(e.taskFeeInfo.includes("**Fee Amount:** $750.00"), "the task carries the accepted fee");
});

Deno.test("end to end: via the payment-intent quote, its fee (dollars) is what the row is compared with", async () => {
  const ok = await run({ quotes: [], fee_acceptances: [row()] }, { id: "bid-sel", claim_id: "claim-1", contractor_id: C, fee_amount: 750 });
  assertEquals((ok.feeAcceptance as FeeAcceptanceRow).id, "fa-1");
  const noFee = await run({ quotes: [], fee_acceptances: [row()] }, { id: "bid-sel", claim_id: "claim-1", contractor_id: C, fee_amount: null });
  assertEquals(noFee.feeAcceptance, null);
  assertEquals(noFee.feeAcceptanceMissingReason, "fee_differs_from_bid");
});

Deno.test("end to end: a newer $0.05 row for a second bid never replaces the selected bid's row", async () => {
  const second = { ...bid, id: "bid-2", status: "submitted", fee_amount: 0.05, created_at: "2026-11-02T00:00:00Z" };
  const e = await run({ quotes: [bid, second], fee_acceptances: [row(), row({ id: "fa-2", bid_id: "bid-2", fee_amount: 0.05, created_at: "2026-11-02T00:00:01Z" })] });
  assertEquals((e.feeAcceptance as FeeAcceptanceRow).id, "fa-1");
  assert(!stripeText(e).includes("$0.05"));
});

Deno.test("end to end: a dip row (fee differs from the bid's fee) is not evidence, and BOTH documents say so, in their own words", async () => {
  const e = await run({ quotes: [bid], fee_acceptances: [row({ fee_amount: 0.05 })] });
  assertEquals(e.feeAcceptance, null);
  assertEquals(e.feeAcceptanceMissingReason, "fee_differs_from_bid");
  const s = stripeText(e);
  assert(s.includes("FEE ACCEPTANCE RECORD: Not found in database"), "Stripe packet keeps the literal the gates look for");
  assert(s.includes("Not found in database as a record usable for this charge"), "the Stripe packet carries the reason's neutral wording");
  assert(!s.includes("$0.05") && !/quarantine|fee_acceptances|exists/i.test(s), "Stripe packet names no internal table or reason and shows no stale fee");
  assert(/differs from the bid/.test(e.taskFeeInfo), "the ClickUp task gets the internal reason");
});

Deno.test("end to end: no row for the selected bid says so in the task (and names the quarantine there), and Stripe's text stays neutral", async () => {
  const e = await run({ quotes: [bid], fee_acceptances: [] });
  assertEquals(e.feeAcceptanceMissingReason, "no_row_for_selected_bid");
  assert(/quarantine/.test(e.taskFeeInfo));
  assert(!/quarantine/.test(stripeText(e)));
});

Deno.test("end to end: a rescinded row is not evidence", async () => {
  const e = await run({ quotes: [bid], fee_acceptances: [row({ rescinded_at: "2026-11-02T00:00:00Z" })] });
  assertEquals(e.feeAcceptance, null);
  assertEquals(e.feeAcceptanceMissingReason, "no_row_for_selected_bid");
});

Deno.test("end to end: of two rows for one bid the NEWEST right-fee row is used (a stale earlier row never wins)", async () => {
  const older = row({ id: "fa-old", fee_amount: 0.05, created_at: "2026-11-01T09:00:00Z" });
  const newer = row({ id: "fa-new", created_at: "2026-11-01T10:00:01Z" });
  const e = await run({ quotes: [bid], fee_acceptances: [older, newer] });
  assertEquals((e.feeAcceptance as FeeAcceptanceRow).id, "fa-new");
  const reversed = await run({ quotes: [bid], fee_acceptances: [row({ id: "fa-old", created_at: "2026-11-01T09:00:00Z" }), row({ id: "fa-new", fee_amount: 0.05, created_at: "2026-11-01T10:00:01Z" })] });
  // gh-3490: the newest row is the wrong-fee one (price went A -> B -> A, no new row for the return to A): the older row that matches the bid's current fee is used
  assertEquals((reversed.feeAcceptance as FeeAcceptanceRow).id, "fa-old");
  const none = await run({ quotes: [bid], fee_acceptances: [row({ id: "x1", fee_amount: 0.05 }), row({ id: "x2", fee_amount: 1 })] });
  assertEquals(none.feeAcceptance, null); // no row matches: still manual evidence
});

Deno.test("gh-3490 end to end: two rows for one bid both match the bid's fee: the NEWEST is used (a reversed sort would pick the older)", async () => {
  const older = row({ id: "fa-a1", created_at: "2026-11-01T09:00:00Z" });
  const newer = row({ id: "fa-a2", created_at: "2026-11-01T10:00:01Z" });
  const between = row({ id: "fa-b", fee_amount: 800, created_at: "2026-11-01T09:30:00Z" });
  const e = await run({ quotes: [bid], fee_acceptances: [older, between, newer] });
  assertEquals((e.feeAcceptance as FeeAcceptanceRow).id, "fa-a2");
});

Deno.test("end to end: fee tolerance is half a cent: $750.004 matches, $751 does not", async () => {
  assertEquals((await run({ quotes: [bid], fee_acceptances: [row({ fee_amount: "750.004" })] })).feeAcceptance !== null, true);
  assertEquals((await run({ quotes: [bid], fee_acceptances: [row({ fee_amount: 751 })] })).feeAcceptance, null);
  assertEquals((await run({ quotes: [bid], fee_acceptances: [row({ fee_amount: 750.01 })] })).feeAcceptance, null);
});

Deno.test("index.ts wiring: calls the assembler with the payment-intent quote, selects fee_amount on that quote, and hands every field on", () => {
  const src = stripComments(Deno.readTextFileSync(new URL("./index.ts", import.meta.url)));
  assert(/await assembleDisputeFeeEvidence\(supabase, dispute, claim, quote\)/.test(src), "index.ts must call the assembler with the dispute, claim and payment-intent quote");
  assert(/\.select\("id, claim_id, contractor_id, payment_intent_id, fee_amount"\)\s*\.eq\("payment_intent_id"/.test(src), "the payment-intent quote read must select fee_amount");
  assert(/const evidencePayload = feeEvidence\.evidencePayload;/.test(src), "the Stripe evidence must come from the assembler");
  assert(/postDisputeEvidence\(\{[^}]*evidence: evidencePayload[^}]*feeAcceptanceResolved: feeAcceptance !== null/s.test(src), "postDisputeEvidence gets that payload and the resolved flag");
  assert(/const feeAcceptance: FeeAcceptanceRow \| null = feeEvidence\.feeAcceptance;/.test(src));
  assert(/createClickUpTask\(\{[^}]*taskFeeInfo: feeEvidence\.taskFeeInfo/s.test(src), "the task gets the assembler's fee block");
  assert(!/loadFeeAcceptanceForDispute|pickFeeAcceptanceForBid|from\("fee_acceptances"\)/.test(src), "index.ts reads fee_acceptances only through the assembler");
});
