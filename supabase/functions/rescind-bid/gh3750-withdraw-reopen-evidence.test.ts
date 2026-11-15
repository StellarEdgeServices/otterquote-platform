// gh-3750 (REVIEW 6901068974 / LEGAL-READ 6901069249): END TO END, through the real code on both sides.
//   rescind-bid's real stamp  ->  the bid is reopened (renew_quote 'reopen', same quote id)  ->  the reopen path's fresh fee_acceptances insert
//   ->  stripe-webhook's REAL loadFeeAcceptanceForDispute (rescinded_at IS NULL) must return the FRESH row, not "no_row_for_selected_bid".
// The table below is an in-memory stand-in. The guard trigger is modelled by `guard` and PROVEN on a real Postgres by
// supabase/tests/gh3750_reopen_acceptance_proof.sql (before the migration the fresh row is quarantined duplicate_bid; after, it is recorded).
// FAIL-FIRST on head 8042784a: the stamp alone (no reopen insert in either form) leaves the dispute path with no row, and the two form-wiring tests fail.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { stampFeeAcceptancesRescinded } from "./fee-acceptance-rescind.ts";
import { loadFeeAcceptanceForDispute } from "../stripe-webhook/fee-acceptance-select.ts";

type Row = Record<string, unknown>;
const QID = "bid-1", CID = "c-1", CLAIM = "claim-1";

class Store {
  fa: Row[] = [];
  quarantine: Row[] = [];
  quotes: Row[] = [{ id: QID, claim_id: CLAIM, contractor_id: CID, status: "selected", bid_status: "active", fee_amount: 910, created_at: "2026-11-15T19:00:00Z" }];
  // guard: client insert is quarantined as duplicate_bid when a row exists for the bid. `ignoreRescinded` is the gh3750 migration's one added condition.
  constructor(public ignoreRescinded: boolean) {}
  clientInsert(r: Row) {
    const dup = this.fa.some((d) => d.bid_id === r.bid_id && (!this.ignoreRescinded || d.rescinded_at == null));
    if (dup) { this.quarantine.push(r); return []; }
    const row = { ...r, id: "fa-" + (this.fa.length + 1), rescinded_at: null, rescission_reason: null, created_at: "2026-11-15T19:5" + this.fa.length + ":00Z" };
    this.fa.push(row);
    return [row];
  }
  from(table: string) {
    // deno-lint-ignore no-this-alias
    const st = this;
    let rows: Row[] = table === "quotes" ? st.quotes : st.fa;
    let patch: Row | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Row) => { patch = p; return q; },
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return q; },
      order: () => { rows = [...rows].sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1)); return q; },
      limit: (n: number) => { rows = rows.slice(0, n); return q; },
      then: (res: (v: unknown) => void) => { if (patch) rows.forEach((r) => Object.assign(r, patch)); res({ data: rows.map((r) => ({ ...r })), error: null }); },
    };
    return q;
  }
}
const firstRow = (): Row => ({ id: "fa-1", contractor_id: CID, claim_id: CLAIM, bid_id: QID, fee_pct: 5, fee_amount: 910, fee_text_displayed: "TEXT", accepted_at: "2026-11-15T19:54:46Z", ip_address: "1.2.3.4", user_agent: "UA", invoice_url: null, rescinded_at: null, created_at: "2026-11-15T19:54:46Z" });
const freshRow = (): Row => ({ contractor_id: CID, claim_id: CLAIM, bid_id: QID, fee_pct: 5, fee_amount: 910, fee_text_displayed: "TEXT", accepted_at: "2026-11-15T21:00:00Z", ip_address: "1.2.3.4", user_agent: "UA" });
const pick = (st: Store) => loadFeeAcceptanceForDispute(st, { id: CLAIM }, CID, null);

async function withdrawn(st: Store) {
  st.fa.push(firstRow());
  const r = await stampFeeAcceptancesRescinded(st, { quoteId: QID, contractorId: CID, rescindedAt: "2026-11-15T19:56:00Z" });
  assertEquals(r, { ok: true, stamped: 1 });
  assertEquals(st.fa[0].rescission_reason, "bid_withdrawn");
  st.quotes[0].bid_status = "active"; // renew_quote('reopen'): same quote id, live again, then selected and charged
}

Deno.test("hazard (the REVIEW's finding): stamp + reopen with NO fresh row leaves the dispute path without evidence", async () => {
  const st = new Store(true);
  await withdrawn(st);
  const r = await pick(st);
  assertEquals(r.row, null);
  assertEquals(r.reason, "no_row_for_selected_bid");
});

Deno.test("END TO END: stamp + reopen + the form's fresh insert -> the real stripe-webhook selector returns the FRESH row", async () => {
  const st = new Store(true); // guard as changed by the gh3750 migration
  await withdrawn(st);
  assertEquals(st.clientInsert(freshRow()).length, 1);
  const r = await pick(st);
  assertEquals(r.reason, "ok");
  assertEquals((r.row as Row).id, "fa-2");
  assertEquals(st.fa.filter((x) => x.rescinded_at == null).length, 1);
  assertEquals(st.fa[0].rescinded_at, "2026-11-15T19:56:00Z"); // the withdrawn acceptance stays on file, stamped
  assertEquals(st.quarantine.length, 0);
});

Deno.test("NEGATIVE CONTROL: with today's guard (no migration) the fresh row is quarantined, so the selector finds nothing", async () => {
  const st = new Store(false);
  await withdrawn(st);
  assertEquals(st.clientInsert(freshRow()).length, 0);
  assertEquals(st.quarantine.length, 1);
  assertEquals((await pick(st)).reason, "no_row_for_selected_bid");
});

const html = await Deno.readTextFile(new URL("../../../contractor-bid-form.html", import.meta.url));
const tsx = await Deno.readTextFile(new URL("../../../react-app/app/contractor/bid/[claimId]/bid-form.tsx", import.meta.url));

Deno.test("form wiring (HTML): the reopen path inserts fee_acceptances for the SAME quote id after the field UPDATE, once", () => {
  const reopenFlag = html.indexOf("const _reopenedWithdrawnBid = _renewRpcMode === 'reopen'");
  const updateZero = html.indexOf("bid_update_zero_rows: no matching quote row was updated");
  const ins = html.indexOf("if (_reopenedWithdrawnBid && existingQuote.id !== _reopenAcceptanceDoneId)");
  assert(reopenFlag > 0 && updateZero > reopenFlag && ins > updateZero, "flag read before the RPC; insert after the UPDATE's zero-row check");
  const block = html.slice(ins, ins + 2200);
  assert(/from\('fee_acceptances'\)\.insert\(\{/.test(block) && /bid_id: existingQuote\.id,/.test(block));
  assert(/fee_text_displayed: _exactFeeText,/.test(block) && /fee_amount: _feeAmount,/.test(block));
  assert(/_reopenAcceptanceDoneId = existingQuote\.id;/.test(block));
});

Deno.test("form wiring (React twin): same, through buildFeeAcceptanceInsert", () => {
  const flag = tsx.indexOf("const reopenedWithdrawnBid = renewRpcMode === 'reopen'");
  const zero = tsx.indexOf("bid_update_zero_rows: no matching quote row was updated");
  const ins = tsx.indexOf("if (reopenedWithdrawnBid && existingQuote && reopenAcceptanceDoneRef.current !== existingQuote.id)");
  assert(flag > 0 && zero > flag && ins > zero);
  const block = tsx.slice(ins, ins + 2600);
  assert(/from\('fee_acceptances'\)\.insert\(buildFeeAcceptanceInsert\(\{/.test(block) && /bidId: reopenBidId/.test(block) && /feeTextDisplayed: exactFeeText/.test(block));
  assert(/reopenAcceptanceDoneRef\.current = reopenBidId;/.test(block));
});
