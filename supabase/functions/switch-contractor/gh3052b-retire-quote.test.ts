// gh-3052 part 2 -- a switched-away quote is retired as status 'declined' + bid_status
// 'superseded' (the pattern accept_bid() already uses), not 'cancelled'.
//   (1) switch-contractor step 6 writes values both CHECKs admit, with the bid_status that keeps
//       the quote un-awardable;
//   (2) process-dunning's "restore declined -> submitted" skips superseded rows;
//   (3) accept_bid() refuses declined+superseded (and, as the negative control, admits declined+active).
// Reads sources as text (the EFs call serve()). FAIL-FIRST: on 7149f3dd (step 6 'cancelled', restore with
// no bid_status filter) (1) and (2) fail.
// Run: deno test --allow-read=supabase/functions,supabase/migrations supabase/functions/switch-contractor/gh3052b-retire-quote.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const sw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const dunning = await Deno.readTextFile(new URL("../process-dunning/index.ts", import.meta.url));

// live constraints (production yeszghaspzwwstvsrioa, 2026-10-23)
const STATUS_OK = new Set(["draft", "submitted", "selected", "declined", "expired"]);
const BID_STATUS_OK = new Set(["active", "expired", "superseded", "cancelled"]);

function step6Write(src: string): string {
  const a = src.indexOf("// ── 6. Cancel the quote");
  const b = src.indexOf("// ── 7. Reset the claim");
  assert(a !== -1 && b > a, "step 6 anchors moved; update this test");
  const blk = src.slice(a, b);
  const u = blk.indexOf(".update({");
  return blk.slice(u, blk.indexOf("})", u));
}
const field = (w: string, k: string) => w.match(new RegExp(`(?<![\\w])${k}\\s*:\\s*"([a-z_]+)"`))?.[1];

Deno.test("(1) step 6 writes declined + superseded, both admitted by the live CHECKs", () => {
  const w = step6Write(sw);
  assertEquals(field(w, "status"), "declined");
  assertEquals(field(w, "bid_status"), "superseded");
  assert(STATUS_OK.has(field(w, "status")!) && BID_STATUS_OK.has(field(w, "bid_status")!));
  assertStringIncludes(w, "cancelled_at");
  assertStringIncludes(w, 'cancellation_reason: "homeowner_switched_contractor"');
});

Deno.test("(1) negative control: the old step 6 write would be refused (23514)", () => {
  const old = `.update({ status: "cancelled", cancelled_at: x, cancellation_reason: "homeowner_switched_contractor" `;
  assertEquals(field(old, "status"), "cancelled");
  assert(!STATUS_OK.has(field(old, "status")!));
  assertEquals(field(old, "bid_status"), undefined);
});

function restoreBlock(src: string): string {
  const a = src.indexOf('.update({ status: "submitted" })');
  assert(a !== -1, "restore update moved; update this test");
  return src.slice(a, src.indexOf(".select(", a));
}

Deno.test("(2) process-dunning restore skips bid_status superseded (and keeps NULL rows)", () => {
  const b = restoreBlock(dunning);
  assertStringIncludes(b, '.eq("status", "declined")');
  assertStringIncludes(b, '.or("bid_status.is.null,bid_status.neq.superseded")');
});

Deno.test("(2) negative control: the pre-fix restore had no bid_status filter", () => {
  const pre = `.update({ status: "submitted" }).eq("claim_id", c).eq("status", "declined")`;
  assert(!pre.includes("bid_status"));
});

// ---- (3) accept_bid predicate, taken from the repo migration and modelled ----
const PREDICATE =
  "IF COALESCE(v_q_status, '') NOT IN ('submitted', 'declined')\n     OR COALESCE(v_q_bid_status, 'active') <> 'active' THEN";
async function acceptBidMigration(): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  let latest = "";
  for await (const e of Deno.readDir(dir)) {
    if (!e.name.endsWith(".sql")) continue;
    const t = await Deno.readTextFile(new URL(e.name, dir));
    if (/CREATE OR REPLACE FUNCTION public\.accept_bid\(/.test(t) && e.name > latest) latest = e.name;
  }
  assert(latest, "no migration defines accept_bid");
  return await Deno.readTextFile(new URL(latest, dir));
}
const awardable = (status: string, bid: string | null) =>
  ["submitted", "declined"].includes(status) && (bid ?? "active") === "active";

Deno.test("(3) accept_bid refuses declined+superseded; admits declined+active (control)", async () => {
  const m = await acceptBidMigration();
  assertStringIncludes(m, PREDICATE); // the modelled predicate is the one in the latest accept_bid
  assertEquals(awardable("declined", "superseded"), false); // the retired switched-away quote
  assertEquals(awardable("declined", "active"), true); // control: why bid_status 'superseded' is needed
  assertEquals(awardable("selected", "active"), false);
  assertEquals(awardable("declined", "cancelled"), false);
});
