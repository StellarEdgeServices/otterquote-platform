// D-391 / #2875 layer 4: the shared verified-number lookup. Run: deno test supabase/functions/_shared/contractor-textable.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { resolveContractorTextableNumbers, TEXTABLE_RPC, type TextableClient } from "./contractor-textable.ts";

type Row = { number_id: string; phone_e164: string; is_primary: boolean };
const A: Row = { number_id: "na", phone_e164: "+15155550142", is_primary: true };
const B: Row = { number_id: "nb", phone_e164: "+15155550143", is_primary: false };

function client(opts: { rpc?: () => Promise<{ data: unknown; error: { message?: string } | null }>; consent?: () => Promise<unknown> }) {
  const seen = { rpc: [] as Array<[string, Record<string, unknown>]> };
  const sb: TextableClient = {
    rpc(fn, args) {
      seen.rpc.push([fn, args]);
      return opts.rpc!();
    },
    from(_t: string) {
      return { select: () => ({ in: () => (opts.consent ? opts.consent() : Promise.resolve({ data: [] })) }) };
    },
  };
  return { sb, seen };
}
const ok = (rows: unknown) => () => Promise.resolve({ data: rows, error: null });

async function run(sb: TextableClient, id: string | null | undefined = "c1") {
  const warn: string[] = [];
  const info: string[] = [];
  const out = await resolveContractorTextableNumbers(sb, id, { site: "t/site", log: (l) => warn.push(l), info: (l) => info.push(l) });
  return { out, warn, info };
}

Deno.test("calls contractor_textable_numbers with the contractor id and returns the verified numbers in order", async () => {
  const { sb, seen } = client({ rpc: ok([A, B]) });
  const { out, warn } = await run(sb);
  assertEquals(seen.rpc, [[TEXTABLE_RPC, { p_contractor_id: "c1" }]]);
  assertEquals(out.map((r) => r.phone), ["+15155550142", "+15155550143"]);
  assertEquals(out[0].is_primary, true);
  assertEquals(warn, []);
});

Deno.test("no verified number -> [] and ONE unverified_number refusal (masked contractor-level, no phones)", async () => {
  const { sb } = client({ rpc: ok([]) });
  const { out, warn } = await run(sb);
  assertEquals(out, []);
  assertEquals(warn.length, 1);
  assert(warn[0].includes('"event":"contractor_sms_refused"'));
  assert(warn[0].includes('"reason":"unverified_number"'));
  assert(warn[0].includes('"detail":"no_verified_number"'));
  assert(warn[0].includes('"site":"t/site"'));
});

Deno.test("fail closed: rpc error, rpc throw, non-array data, missing contractor id -> [] and a refusal each", async () => {
  const cases: Array<[string, TextableClient, string | null | undefined, string]> = [
    ["rpc error", client({ rpc: () => Promise.resolve({ data: null, error: { message: "x" } }) }).sb, "c1", "lookup_failed"],
    ["rpc throw", client({ rpc: () => Promise.reject(new Error("net")) }).sb, "c1", "lookup_failed"],
    ["non-array", client({ rpc: ok({ phone_e164: "+15155550142" }) }).sb, "c1", "no_verified_number"],
    ["no id", client({ rpc: ok([A]) }).sb, null, "no_contractor_id"],
    ["empty id", client({ rpc: ok([A]) }).sb, "", "no_contractor_id"],
  ];
  for (const [name, sb, id, detail] of cases) {
    const { out, warn } = await run(sb, id);
    assertEquals(out, [], name);
    assertEquals(warn.length, 1, name);
    assert(warn[0].includes('"reason":"unverified_number"') && warn[0].includes(`"detail":"${detail}"`), `${name}: ${warn[0]}`);
  }
});

Deno.test("a missing contractor id never reaches the database", async () => {
  const { sb, seen } = client({ rpc: ok([A]) });
  await run(sb, null);
  assertEquals(seen.rpc.length, 0);
});

Deno.test("rows that are not E.164, have no number id, or repeat a number are dropped", async () => {
  const { sb } = client({ rpc: ok([{ ...A, phone_e164: "515-555-0142" }, { ...B, number_id: "" }, A, { ...A, number_id: "dup" }, { number_id: "x" }, null]) });
  const { out } = await run(sb);
  assertEquals(out.map((r) => r.phone), ["+15155550142"]);
  assertEquals(out[0].number_id, "na");
});

Deno.test("only malformed rows -> [] and an unverified_number refusal", async () => {
  const { sb } = client({ rpc: ok([{ ...A, phone_e164: "5155550142" }]) });
  const { out, warn } = await run(sb);
  assertEquals(out, []);
  assert(warn[0].includes('"reason":"unverified_number"'));
});

Deno.test("consent record: verified_at + disclosure version are logged for each number; the number is masked", async () => {
  const { sb } = client({
    rpc: ok([A, B]),
    consent: () => Promise.resolve({ data: [{ id: "na", verified_at: "2026-10-01T00:00:00Z", disclosure_version_id: "v1" }, { id: "nb", verified_at: "2026-10-02T00:00:00Z", disclosure_version_id: "v1" }] }),
  });
  const { out, info } = await run(sb);
  assertEquals(out[1].consent, { verified_at: "2026-10-02T00:00:00Z", disclosure_version_id: "v1" });
  assertEquals(info.length, 2);
  assert(info[0].includes('"event":"contractor_sms_verified_recipient"') && info[0].includes('"verified_at":"2026-10-01T00:00:00Z"') && info[0].includes('"disclosure_version_id":"v1"'));
  for (const l of info) assert(!l.includes("515555014"), "full number must never be logged");
});

Deno.test("a failed consent-record read does NOT block a verified number (fields logged as null)", async () => {
  const { sb } = client({ rpc: ok([A]), consent: () => Promise.reject(new Error("boom")) });
  const { out, info } = await run(sb);
  assertEquals(out.length, 1);
  assertEquals(out[0].consent, { verified_at: null, disclosure_version_id: null });
  assert(info[0].includes('"verified_at":null'));
});
