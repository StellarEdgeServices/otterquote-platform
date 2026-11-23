// gh-3848 -- the auto-renew swap against an in-memory quotes table that ENFORCES the manual-bid unique index
// (claim_id, contractor_id) WHERE is_auto_bid IS NOT TRUE AND bid_status IN ('active','expired'): a write that would leave two such
// rows fails 23505 "quotes_manual_bid_uidx". Drives the shipped swapInRenewalClone(). The fake is a model of the index, not Postgres.
//
// NEGATIVE CONTROL: `insertThenSupersede` below is main's order (clone first, original superseded second); against the same table it
// fails with 23505 on the clone insert, which is what the reordering fixes.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { swapInRenewalClone } from "./renewal-swap.ts";

type Row = Record<string, unknown>;
const live = (r: Row) => r.is_auto_bid !== true && (r.bid_status === "active" || r.bid_status === "expired");
const clash = (rows: Row[], cand: Row, ignoreId?: unknown) =>
  live(cand) && rows.some((r) => r.id !== ignoreId && live(r) && r.claim_id === cand.claim_id && r.contractor_id === cand.contractor_id);
const VIOLATION = { code: "23505", message: 'duplicate key value violates unique constraint "quotes_manual_bid_uidx"' };

function fakeDb(rows: Row[], opts: { failInsert?: boolean; failRestore?: boolean } = {}) {
  const log: string[] = [];
  let seq = 0;
  const client = {
    from(_t: string) {
      const s = { patch: {} as Row, eqs: [] as [string, unknown][] };
      const b: Record<string, unknown> = {
        update(p: Row) { s.patch = p; return b; },
        insert(p: Row) {
          return {
            select: () => ({
              single: async () => {
                log.push(`insert ${p.bid_status}`);
                if (opts.failInsert) return { data: null, error: { message: "boom" } };
                const row = { id: `clone-${++seq}`, ...p };
                if (clash(rows, row)) return { data: null, error: VIOLATION };
                rows.push(row);
                return { data: { id: row.id }, error: null };
              },
            }),
          };
        },
        eq(c: string, v: unknown) { s.eqs.push([c, v]); return b; },
        select() {
          return {
            then: (res: (v: unknown) => unknown) => {
              const hit = rows.filter((r) => s.eqs.every(([c, v]) => r[c] === v));
              log.push(`update ${JSON.stringify(s.patch)} hit=${hit.length}`);
              if (s.patch.bid_status === "active" && opts.failRestore) {
                return Promise.resolve({ data: null, error: { message: "restore boom" } }).then(res);
              }
              const bad = hit.map((r) => ({ ...r, ...s.patch })).find((t) => clash(rows, t, t.id));
              if (bad) return Promise.resolve({ data: null, error: VIOLATION }).then(res);
              hit.forEach((r) => Object.assign(r, s.patch));
              return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(res);
            },
          };
        },
      };
      return b;
    },
  };
  return { client, log };
}

const original = (): Row => ({ id: "orig", claim_id: "c1", contractor_id: "k1", bid_status: "active", is_auto_bid: false, total_price: 100, auto_renew: true, trade_type: "roofing" });
const Q = { id: "orig", claim_id: "c1", contractor_id: "k1", total_price: 100, auto_renew: true, trade_type: "roofing" };
const liveCount = (rows: Row[]) => rows.filter((r) => live(r) && r.claim_id === "c1").length;

Deno.test("swap: original superseded first, clone inserted second, never two live rows", async () => {
  const rows = [original()];
  const { client, log } = fakeDb(rows);
  const r = await swapInRenewalClone(client, Q, "2026-12-01T00:00:00Z", "2026-11-23T00:00:00Z");
  assertEquals(r.outcome, "renewed");
  assertEquals(r.errors, []);
  assert(log[0].startsWith("update") && log[0].includes("superseded"), log.join(" | "));
  assertEquals(log[1], "insert active");
  assertEquals(rows.find((x) => x.id === "orig")!.bid_status, "superseded");
  assertEquals(rows.find((x) => x.renewed_from_quote_id === "orig")!.bid_status, "active");
  assertEquals(liveCount(rows), 1);
});

Deno.test("swap: clone insert fails -> the original is restored to active (one live row, no lost bid)", async () => {
  const rows = [original()];
  const { client } = fakeDb(rows, { failInsert: true });
  const r = await swapInRenewalClone(client, Q, "x", "y");
  assertEquals(r.outcome, "insert_failed");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].bid_status, "active");
  assertEquals(rows[0].expired_at, null);
  assert(r.errors.some((e) => e.includes("Auto-renew insert failed")));
});

Deno.test("swap: clone insert fails AND restore fails -> both errors reported", async () => {
  const rows = [original()];
  const { client } = fakeDb(rows, { failInsert: true, failRestore: true });
  const r = await swapInRenewalClone(client, Q, "x", "y");
  assertEquals(r.outcome, "insert_failed");
  assert(r.errors.some((e) => e.includes("Restore after failed renewal failed")));
});

Deno.test("swap: the original already changed (not active) -> skipped, no clone inserted", async () => {
  const o = original();
  o.bid_status = "cancelled";
  const rows = [o];
  const { client, log } = fakeDb(rows);
  const r = await swapInRenewalClone(client, Q, "x", "y");
  assertEquals(r.outcome, "skipped");
  assertEquals(rows.length, 1);
  assert(!log.some((l) => l.startsWith("insert")));
});

Deno.test("swap: another live manual bid exists beside an auto-bid original -> clone refused by the index, original restored", async () => {
  // An auto-bid original is outside the index; a live manual bid sits beside it; the clone (is_auto_bid defaults false) would be the
  // second manual row.
  const orig = original();
  orig.is_auto_bid = true;
  const manual: Row = { id: "m1", claim_id: "c1", contractor_id: "k1", bid_status: "active", is_auto_bid: false };
  const rows = [orig, manual];
  const { client } = fakeDb(rows);
  const r = await swapInRenewalClone(client, Q, "x", "y");
  assertEquals(r.outcome, "insert_failed");
  assertEquals(rows.find((x) => x.id === "orig")!.bid_status, "active");
  assertEquals(rows.length, 2);
});

// ---- negative control: main's order ----
Deno.test("negative control: main's order (insert the clone while the original is live) is refused by the index", async () => {
  const rows = [original()];
  const { client } = fakeDb(rows);
  // deno-lint-ignore no-explicit-any
  const ins: any = await (client.from("quotes") as any).insert({ claim_id: "c1", contractor_id: "k1", renewed_from_quote_id: "orig", bid_status: "active" }).select().single();
  assertEquals(ins.error?.code, "23505");
  assertEquals(rows.length, 1); // auto-renewal would have fallen back to plain expiry
});

// ---- the shipped SQL file, read as text: the predicate this model enforces is the predicate that ships ----
Deno.test("the draft migration's key and predicate are the ones modeled here", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations_drafts/gh3848_quotes_manual_bid_unique.sql", import.meta.url));
  const stmt = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").replace(/\s+/g, " ");
  assert(
    stmt.includes("CREATE UNIQUE INDEX IF NOT EXISTS quotes_manual_bid_uidx ON public.quotes (claim_id, contractor_id) WHERE is_auto_bid IS NOT TRUE AND bid_status IN ('active', 'expired');"),
    stmt,
  );
});
