// gh-3409 (REVIEW 6668449870 B1): the dispute evidence row must be the SELECTED bid's, with the bid's own fee.
// Shapes S1-S3 are the ones the reviewer reproduced on Postgres; each row below is "true at its own instant".
// On main the webhook took the newest row for (claim, contractor) and these returned the $0.05 row.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { describeMissingFeeAcceptance, describeMissingFeeAcceptanceForStripe, loadFeeAcceptanceForDispute, pickFeeAcceptanceForBid } from "./fee-acceptance-select.ts";
import { stripComments } from "./test-source-utils.ts";

const genuine = { id: "a1", bid_id: "bid-selected", fee_amount: 750 };
const secondBidRow = { id: "a2", bid_id: "bid-second", fee_amount: 0.05 };
const dipRow = { id: "a3", bid_id: "bid-dipped", fee_amount: 0.05 };

// what main did: rows[0] of a newest-first list
const oldPick = (rows: { fee_amount: number }[]) => rows[0];

Deno.test("S1: a second $1 bid with its own row is newer, main picked it; the selected bid's row is picked now", () => {
  const rows = [secondBidRow, genuine]; // newest first
  assertEquals(oldPick(rows).fee_amount, 0.05); // negative control: the defect
  const r = pickFeeAcceptanceForBid(rows, { id: "bid-selected", fee_amount: 750 });
  assertEquals(r.reason, "ok");
  assertEquals(r.row?.fee_amount, 750);
});

Deno.test("S2/S3: price dipped to $1, accepted, raised back: the row's fee differs from the bid's fee, so it is not evidence", () => {
  const rows = [dipRow];
  assertEquals(oldPick(rows).fee_amount, 0.05); // negative control
  const r = pickFeeAcceptanceForBid(rows, { id: "bid-dipped", fee_amount: "750.00" });
  assertEquals(r.row, null);
  assertEquals(r.reason, "fee_differs_from_bid");
});

Deno.test("no selected bid, or no row for it: not evidence (manual)", () => {
  assertEquals(pickFeeAcceptanceForBid([genuine], null).reason, "no_selected_bid");
  assertEquals(pickFeeAcceptanceForBid([secondBidRow], { id: "bid-selected", fee_amount: 750 }).reason, "no_row_for_selected_bid");
  assertEquals(pickFeeAcceptanceForBid(null, { id: "bid-selected", fee_amount: 750 }).reason, "no_row_for_selected_bid");
});

Deno.test("genuine rows still work: numeric strings, half-cent rounding, sub-dollar fee", () => {
  assertEquals(pickFeeAcceptanceForBid([{ bid_id: "b", fee_amount: "617.28" }], { id: "b", fee_amount: 617.28 }).reason, "ok");
  assertEquals(pickFeeAcceptanceForBid([{ bid_id: "b", fee_amount: 0.05 }], { id: "b", fee_amount: "0.05" }).reason, "ok");
  assertEquals(pickFeeAcceptanceForBid([{ bid_id: "b", fee_amount: 750 }], { id: "b", fee_amount: null }).reason, "fee_differs_from_bid");
});

// ---- the database reads, through a fake query builder that applies the filters it is given (REVIEW 6669057587 B2) ----
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let lim = Infinity;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, v: unknown) => { calls.push(`${table}.eq(${col})`); rows = rows.filter((r) => r[col] === v); return q; },
        is: (col: string, v: unknown) => { rows = rows.filter((r) => (r[col] ?? null) === v); return q; },
        order: (col: string, o: { ascending: boolean }) => { rows.sort((a, b) => (String(a[col]) < String(b[col]) ? 1 : -1) * (o.ascending ? -1 : 1)); return q; },
        limit: (n: number) => { lim = n; return q; },
        then: (res: (v: { data: Row[] }) => void) => res({ data: rows.slice(0, lim) }),
      };
      return q;
    },
  };
  return { db, calls };
}
const claim = { id: "claim-1" };
const C = "contractor-1";
const selected = { id: "bid-selected", claim_id: "claim-1", contractor_id: C, status: "selected", fee_amount: 750, created_at: "2026-11-01T10:00:00Z" };
const genuineRow = { id: "a1", claim_id: "claim-1", contractor_id: C, bid_id: "bid-selected", fee_amount: 750, rescinded_at: null, created_at: "2026-11-01T10:00:01Z" };
// a contractor who piles up other bids, each with a true, newer row (REVIEW: 20 more own bids pushed the selected bid's row out of a limit-20 read)
const otherBids = Array.from({ length: 30 }, (_, i) => ({ id: `bid-x${i}`, claim_id: "claim-1", contractor_id: C, status: "submitted", fee_amount: 0.05, created_at: `2026-11-02T10:00:${String(i).padStart(2, "0")}Z` }));
const otherRows = otherBids.map((b, i) => ({ id: `ax${i}`, claim_id: "claim-1", contractor_id: C, bid_id: b.id, fee_amount: 0.05, rescinded_at: null, created_at: `2026-11-02T10:01:${String(i).padStart(2, "0")}Z` }));

Deno.test("loader: the selected bid's row is returned even when 30 newer rows for the claim and contractor name other bids", async () => {
  const { db } = fakeDb({ quotes: [selected, ...otherBids], fee_acceptances: [genuineRow, ...otherRows] });
  const r = await loadFeeAcceptanceForDispute<{ id: string; bid_id: string; fee_amount: number }>(db, claim, C, null);
  assertEquals(r.reason, "ok");
  assertEquals(r.row?.id, "a1");
});

Deno.test("loader: the acceptance read filters on the selected bid_id itself (not only on claim and contractor)", async () => {
  const { db, calls } = fakeDb({ quotes: [selected], fee_acceptances: [genuineRow] });
  await loadFeeAcceptanceForDispute(db, claim, C, null);
  assert(calls.includes("fee_acceptances.eq(bid_id)"), "fee_acceptances must be filtered by bid_id");
});

Deno.test("loader: the fallback lookup takes the SELECTED quote only, never a newer submitted or declined one", async () => {
  const newerDeclined = { id: "bid-declined", claim_id: "claim-1", contractor_id: C, status: "declined", fee_amount: 0.05, created_at: "2026-11-03T10:00:00Z" };
  const declinedRow = { id: "a9", claim_id: "claim-1", contractor_id: C, bid_id: "bid-declined", fee_amount: 0.05, rescinded_at: null, created_at: "2026-11-03T10:00:01Z" };
  const { db } = fakeDb({ quotes: [selected, newerDeclined], fee_acceptances: [genuineRow, declinedRow] });
  const r = await loadFeeAcceptanceForDispute<{ id: string; bid_id: string; fee_amount: number }>(db, claim, C, null);
  assertEquals(r.row?.id, "a1");
});

Deno.test("loader: no selected bid, or a quote of another claim from the payment intent, gives no evidence", async () => {
  const { db } = fakeDb({ quotes: [{ ...selected, status: "submitted" }], fee_acceptances: [genuineRow] });
  assertEquals((await loadFeeAcceptanceForDispute(db, claim, C, null)).reason, "no_selected_bid");
  const { db: db2 } = fakeDb({ quotes: [], fee_acceptances: [genuineRow] });
  const other = { id: "bid-selected", claim_id: "claim-OTHER", fee_amount: 750 };
  assertEquals((await loadFeeAcceptanceForDispute(db2, claim, C, other)).reason, "no_selected_bid");
});

Deno.test("loader: a payment-intent quote of this claim is the bid, and its fee must equal the row's", async () => {
  const { db } = fakeDb({ quotes: [], fee_acceptances: [genuineRow] });
  assertEquals((await loadFeeAcceptanceForDispute(db, claim, C, { id: "bid-selected", claim_id: "claim-1", fee_amount: 750 })).reason, "ok");
  assertEquals((await loadFeeAcceptanceForDispute(db, claim, C, { id: "bid-selected", claim_id: "claim-1", fee_amount: 1050 })).reason, "fee_differs_from_bid");
});

Deno.test("messages: a record that exists but is not used is never described as 'no record found'", () => {
  assert(!/No fee_acceptances record found/.test(describeMissingFeeAcceptance("fee_differs_from_bid")));
  assert(/differs from the bid/.test(describeMissingFeeAcceptance("fee_differs_from_bid")));
  assert(/quarantine/.test(describeMissingFeeAcceptance("no_row_for_selected_bid")));
  assert(/No fee_acceptances record found/.test(describeMissingFeeAcceptance(null)));
});

Deno.test("messages for Stripe: neutral, never name the quarantine table, never say both 'not found' and 'a record exists'", () => {
  for (const r of ["fee_differs_from_bid", "no_row_for_selected_bid", "no_selected_bid", null] as const) {
    const m = describeMissingFeeAcceptanceForStripe(r);
    assert(m.startsWith("Not found in database"), "keeps the literal the final-submit gates look for");
    assert(!/quarantine|fee_acceptances|exists/i.test(m), `Stripe text leaks an internal name: ${m}`);
  }
});
