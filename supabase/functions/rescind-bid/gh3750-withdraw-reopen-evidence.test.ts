// gh-3750 (REVIEW 6901068974 / LEGAL-READ 6901069249): END TO END, through the real code on both sides.
//   rescind-bid's real stamp  ->  the bid is reopened (renew_quote 'reopen', same quote id)  ->  the reopen path's fresh fee_acceptances insert
//   ->  stripe-webhook's REAL loadFeeAcceptanceForDispute (rescinded_at IS NULL) must return the FRESH row, not "no_row_for_selected_bid".
// The table below is an in-memory stand-in. The guard trigger is modelled by `guard` and PROVEN on a real Postgres by
// supabase/tests/gh3750_reopen_acceptance_proof.sql (before the migration the fresh row is quarantined duplicate_bid; after, it is recorded).
// The 'hazard' test documents what the stamp alone does without the reopen insert; the form-side tests that fail on 8042784a are the vitest wiring test and the Chromium test.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
  assertEquals((r.row as unknown as Row).id, "fa-2");
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

// The two forms' wiring is asserted where the CI read scope allows it: react-app vitest (gh3750-reopen-acceptance-wiring.test.ts, both forms)
// and the real-browser test tests/gh3750-reopen-acceptance-chromium.mjs. (CI runs this suite with --allow-read scoped to supabase/, so it cannot read the pages.)
