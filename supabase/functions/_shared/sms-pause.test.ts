// D-391 / #2875: send-side pause. Run: deno test --allow-read=supabase/functions supabase/functions/_shared/sms-pause.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isSmsPaused, toE164 } from "./sms-pause.ts";

function fake(result: { data?: unknown[] | null; error?: { code?: string } | null } | "throw") {
  const seen: string[] = [];
  const q = {
    select: (c: string) => { seen.push(`select ${c}`); return q; },
    eq: (c: string, v: string) => { seen.push(`eq ${c}=${v}`); return q; },
    limit: (_n: number) => result === "throw" ? Promise.reject(new Error("boom")) : Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return { sb: { from: (t: string) => { seen.push(`from ${t}`); return q; } }, seen };
}

Deno.test("toE164 normalises common US shapes and rejects junk", () => {
  assertEquals(toE164("+13175551234"), "+13175551234");
  assertEquals(toE164("317-555-1234"), "+13175551234");
  assertEquals(toE164("(317) 555 1234"), "+13175551234");
  assertEquals(toE164("1 317 555 1234"), "+13175551234");
  assertEquals(toE164("12345"), null);
  assertEquals(toE164(""), null);
  assertEquals(toE164(null), null);
  assertEquals(toE164("+0123"), null);
});

Deno.test("a pending review row pauses the number; the query is keyed on the E.164 form and status pending", async () => {
  const { sb, seen } = fake({ data: [{ id: "x" }] });
  assertEquals(await isSmsPaused(sb, "317-555-1234"), { paused: true, reason: "pending_review" });
  assert(seen.includes("from sms_optout_review") && seen.includes("eq phone_e164=+13175551234") && seen.includes("eq status=pending"));
});

Deno.test("no pending row -> not paused", async () => {
  assertEquals(await isSmsPaused(fake({ data: [] }).sb, "+13175551234"), { paused: false });
});

Deno.test("NEGATIVE CONTROL: any lookup error other than a missing table FAILS CLOSED (paused)", async () => {
  assertEquals(await isSmsPaused(fake({ error: { code: "XX000" } }).sb, "+13175551234"), { paused: true, reason: "lookup_failed" });
  assertEquals(await isSmsPaused(fake({ error: {} }).sb, "+13175551234"), { paused: true, reason: "lookup_failed" });
  assertEquals(await isSmsPaused(fake("throw").sb, "+13175551234"), { paused: true, reason: "lookup_failed" });
});

Deno.test("a missing review table (migration not applied) means nothing can be flagged -> not paused", async () => {
  assertEquals(await isSmsPaused(fake({ error: { code: "42P01" } }).sb, "+13175551234"), { paused: false });
  assertEquals(await isSmsPaused(fake({ error: { code: "PGRST205" } }).sb, "+13175551234"), { paused: false });
});

Deno.test("an unparseable recipient is not keyed (no lookup)", async () => {
  const { sb, seen } = fake({ data: [{ id: "x" }] });
  assertEquals(await isSmsPaused(sb, "not a number"), { paused: false });
  assertEquals(seen, []);
});

// Source pin: every wire-level send site calls the pause check BEFORE the Twilio request (the closed list of send sites is
// pinned in send-sms/contractor-sms-send-sites.test.ts).
Deno.test("send-sms and process-dunning call isSmsPaused before the Twilio POST", async () => {
  for (const f of ["send-sms/index.ts", "process-dunning/index.ts"]) {
    const src = await Deno.readTextFile(new URL(`../${f}`, import.meta.url));
    const call = src.indexOf("isSmsPaused(");
    const post = src.indexOf("api.twilio.com/2010-04-01/Accounts/");
    assert(call > 0 && post > 0 && call < post, `${f}: isSmsPaused must precede the Twilio request`);
    assert(src.includes('from "../_shared/sms-pause.ts"'), `${f}: imports the shared pause check`);
  }
});
