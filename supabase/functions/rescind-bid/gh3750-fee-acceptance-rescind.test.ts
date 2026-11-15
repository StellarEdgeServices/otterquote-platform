// gh-3750 -- rescind-bid must stamp fee_acceptances.rescinded_at for the withdrawn bid.
// FAIL-FIRST: on main there is no ./fee-acceptance-rescind.ts and index.ts never touches fee_acceptances, so the import
// below fails to resolve (and every wiring assertion would fail too).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { alertStampFailure, BID_WITHDRAWN_REASON, STAMP_FAILED_ALERT_TYPE, stampFeeAcceptancesRescinded } from "./fee-acceptance-rescind.ts";

type Row = { id: string; bid_id: string; contractor_id: string; rescinded_at: string | null; rescission_reason: string | null };

// Minimal PostgREST-shaped fake: update(patch).eq().eq().is().select() applies the patch to matching rows.
class FakeDb {
  constructor(public rows: Row[], public fail: string | null = null, public throwIt = false) {}
  from(table: string) {
    assertEquals(table, "fee_acceptances");
    // deno-lint-ignore no-this-alias
    const db = this;
    let patch: Partial<Row> = {};
    const eqs: [string, string][] = [];
    let nullCol: string | null = null;
    const q = {
      update(p: Partial<Row>) { patch = p; return q; },
      eq(c: string, v: string) { eqs.push([c, v]); return q; },
      is(c: string, _v: null) { nullCol = c; return q; },
      select(_c: string) {
        if (db.throwIt) throw new Error("network down");
        if (db.fail) return Promise.resolve({ data: null, error: { message: db.fail } });
        const hit = db.rows.filter((r) =>
          eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v) &&
          (nullCol === null || (r as unknown as Record<string, unknown>)[nullCol] === null));
        hit.forEach((r) => Object.assign(r, patch));
        return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
      },
    };
    return q;
  }
}

const base = (): Row[] => [
  { id: "fa-1", bid_id: "bid-1", contractor_id: "c-1", rescinded_at: null, rescission_reason: null },
  { id: "fa-2", bid_id: "bid-2", contractor_id: "c-1", rescinded_at: null, rescission_reason: null },
  { id: "fa-3", bid_id: "bid-1", contractor_id: "c-9", rescinded_at: null, rescission_reason: null },
];
const T = "2026-11-15T19:56:00.000Z";

Deno.test("stamps only the withdrawn bid's own row, with the fixed bid_withdrawn marker (not the free-text reason)", async () => {
  const db = new FakeDb(base());
  const r = await stampFeeAcceptancesRescinded(db, { quoteId: "bid-1", contractorId: "c-1", rescindedAt: T });
  assertEquals(r, { ok: true, stamped: 1 });
  assertEquals(db.rows[0].rescinded_at, T);
  assertEquals(db.rows[0].rescission_reason, BID_WITHDRAWN_REASON);
  assertEquals(BID_WITHDRAWN_REASON, "bid_withdrawn");
  assertEquals(db.rows[1].rescinded_at, null);
  assertEquals(db.rows[2].rescinded_at, null);
});

Deno.test("idempotent: a second call stamps nothing and keeps the first timestamp", async () => {
  const db = new FakeDb(base());
  await stampFeeAcceptancesRescinded(db, { quoteId: "bid-1", contractorId: "c-1", rescindedAt: T });
  const again = await stampFeeAcceptancesRescinded(db, { quoteId: "bid-1", contractorId: "c-1", rescindedAt: "2026-11-16T00:00:00.000Z" });
  assertEquals(again, { ok: true, stamped: 0 });
  assertEquals(db.rows[0].rescinded_at, T);
  assertEquals(db.rows[0].rescission_reason, BID_WITHDRAWN_REASON);
});

Deno.test("a database error or a throw is returned, never thrown", async () => {
  const e1 = await stampFeeAcceptancesRescinded(new FakeDb(base(), "permission denied"), { quoteId: "bid-1", contractorId: "c-1", rescindedAt: T });
  assertEquals(e1.ok, false);
  assertEquals(e1.error, "permission denied");
  const e2 = await stampFeeAcceptancesRescinded(new FakeDb(base(), null, true), { quoteId: "bid-1", contractorId: "c-1", rescindedAt: T });
  assertEquals(e2.ok, false);
  assertEquals(e2.error, "network down");
});

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("wiring: index.ts calls the stamp after the zero-row check, before the 200, and does not fail the rescind on error", () => {
  assert(/import \{ alertStampFailure, stampFeeAcceptancesRescinded \} from "\.\/fee-acceptance-rescind\.ts";/.test(src));
  const zero = src.indexOf("gh2105_zero_rows");
  const call = src.indexOf("await stampFeeAcceptancesRescinded(supabase");
  const ok = src.lastIndexOf("success: true");
  assert(zero > 0 && call > zero && ok > call, "stamp must sit between the zero-row guard and the success response");
  assert(!/stampFeeAcceptancesRescinded\(supabase, \{[^}]*reason/.test(src), "the free-text reason is not passed to the stamp (rescission_reason is the fixed marker)");
  const block = src.slice(call, ok);
  assert(/if \(!feeStamp\.ok\) \{\s*console\.error/.test(block));
  assert(/await alertStampFailure\(supabase, \{ quoteId: body\.quote_id, contractorId: body\.contractor_id/.test(block), "a failed stamp raises a platform_alerts_log alert");
  assert(!/return new Response[\s\S]{0,200}feeStamp/.test(block), "a failed stamp must not produce an error response");
});

Deno.test("alert: a failed stamp writes one platform_alerts_log row; the alert helper never throws", async () => {
  const inserted: Record<string, unknown>[] = [];
  const db = { from(t: string) { assertEquals(t, "platform_alerts_log"); return { insert: (r: Record<string, unknown>) => { inserted.push(r); return Promise.resolve({ error: null }); } }; } };
  assertEquals(await alertStampFailure(db, { quoteId: "bid-1", contractorId: "c-1", error: "permission denied" }), true);
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].alert_type, STAMP_FAILED_ALERT_TYPE);
  assertEquals(inserted[0].function_name, "rescind-bid");
  assert(String(inserted[0].message).includes("quote=bid-1") && String(inserted[0].message).includes("permission denied"));
  const throwing = { from() { throw new Error("down"); } };
  assertEquals(await alertStampFailure(throwing, { quoteId: "bid-1", contractorId: "c-1" }), false);
  const refused = { from() { return { insert: () => Promise.resolve({ error: { message: "rls" } }) }; } };
  assertEquals(await alertStampFailure(refused, { quoteId: "bid-1", contractorId: "c-1" }), false);
});
