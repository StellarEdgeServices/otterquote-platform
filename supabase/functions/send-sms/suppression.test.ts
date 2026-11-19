// gh-3768 (child of gate #3726): send-sms refuses a number with an open sms_suppression_list row.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-sms/suppression.test.ts
// No network, no Twilio, no SMS: the Supabase client and Twilio are fakes.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isSmsSuppressed, last4, smsSuppressionRefusal } from "../_shared/sms-suppression.ts";

const CORS = { "Access-Control-Allow-Origin": "https://otterquote.com" };
const OWNER = "+13175019215"; // the owner-alert number hard-coded in send-contractor-nudge/index.ts

type Result = { data?: unknown[] | null; error?: { code?: string } | null } | "throw";

/** Fake client: the suppression table holds `open` (E.164 strings with released_at NULL); `result` overrides the answer. */
function fake(open: string[], result?: Result) {
  const seen: string[] = [];
  let phone = "";
  let openOnly = false;
  const q = {
    select: (c: string) => { seen.push(`select ${c}`); return q; },
    eq: (c: string, v: string) => { seen.push(`eq ${c}=${v}`); if (c === "phone_e164") phone = v; return q; },
    is: (c: string, v: unknown) => { seen.push(`is ${c}=${v}`); openOnly = c === "released_at" && v === null; return q; },
    limit: (_n: number) => {
      if (result === "throw") return Promise.reject(new Error("boom"));
      if (result) return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
      const hit = openOnly && open.includes(phone);
      return Promise.resolve({ data: hit ? [{ id: "row" }] : [], error: null });
    },
  };
  return { sb: { from: (t: string) => { seen.push(`from ${t}`); return q; } }, seen };
}

/** Mirror of the handler's order: suppression refusal first, Twilio only when it answers null. */
async function handle(sb: { from(t: string): unknown }, to: string, twilio: () => Promise<void>, log: (l: string) => void = () => {}) {
  // deno-lint-ignore no-explicit-any
  const refusal = await smsSuppressionRefusal(sb as any, to, CORS, "send-sms", log);
  if (refusal) return refusal;
  await twilio();
  return new Response(JSON.stringify({ status: "sent" }), { status: 200 });
}

Deno.test("a suppressed number is refused (403 number_suppressed) with ZERO Twilio calls", async () => {
  let calls = 0;
  const { sb, seen } = fake(["+13175551234"]);
  const r = await handle(sb, "(317) 555-1234", async () => { calls++; });
  assertEquals(r.status, 403);
  assertEquals((await r.json()).error, "number_suppressed");
  assertEquals(calls, 0);
  // keyed on the E.164 form, open rows only
  assert(seen.includes("from sms_suppression_list") && seen.includes("eq phone_e164=+13175551234") && seen.includes("is released_at=null"));
});

Deno.test("an unsuppressed number sends (one Twilio call)", async () => {
  let calls = 0;
  const r = await handle(fake(["+13175550000"]).sb, "+13175551234", async () => { calls++; });
  assertEquals(r.status, 200);
  assertEquals(calls, 1);
});

Deno.test("the owner alert number is not suppressed, so the alert still goes out", async () => {
  let calls = 0;
  const r = await handle(fake(["+13175551234"]).sb, OWNER, async () => { calls++; });
  assertEquals(r.status, 200);
  assertEquals(calls, 1);
});

Deno.test("a lookup error refuses (503 suppression_lookup_failed), fails closed, zero Twilio calls", async () => {
  for (const result of [{ error: { code: "XX000" } }, { error: {} }, { error: { code: "42P01" } }, "throw"] as Result[]) {
    let calls = 0;
    const r = await handle(fake([], result).sb, "+13175551234", async () => { calls++; });
    assertEquals(r.status, 503);
    assertEquals((await r.json()).error, "suppression_lookup_failed");
    assertEquals(calls, 0);
  }
});

Deno.test("an unparseable number refuses with the lookup-failed code and never queries", async () => {
  let calls = 0;
  const { sb, seen } = fake(["+13175551234"]);
  const r = await handle(sb, "not a number", async () => { calls++; });
  assertEquals(r.status, 503);
  assertEquals(calls, 0);
  assertEquals(seen, []);
});

Deno.test("the two refusals are distinct codes and the log line carries the last 4 digits only", async () => {
  const lines: string[] = [];
  const a = await handle(fake(["+13175551234"]).sb, "+13175551234", async () => {}, (l) => lines.push(l));
  const b = await handle(fake([], { error: {} }).sb, "+13175551234", async () => {}, (l) => lines.push(l));
  assert((await a.json()).error !== (await b.json()).error);
  assertEquals(lines.length, 2);
  for (const l of lines) {
    assert(l.includes("to_last4=1234"), l);
    assert(!l.includes("3175551234") && !l.includes("317555"), `full number leaked: ${l}`);
  }
  assertEquals(last4("+13175551234"), "1234");
  assertEquals(last4("x"), "????");
});

Deno.test("isSmsSuppressed verdicts", async () => {
  assertEquals(await isSmsSuppressed(fake(["+13175551234"]).sb, "317-555-1234"), { suppressed: true, reason: "open_suppression" });
  assertEquals(await isSmsSuppressed(fake([]).sb, "+13175551234"), { suppressed: false });
  assertEquals(await isSmsSuppressed(fake([], "throw").sb, "+13175551234"), { suppressed: true, reason: "lookup_failed" });
});

// Source pin: index.ts calls the suppression check after the pause check and before the rate limit and the Twilio POST,
// and returns its refusal (no bypass flag, no swallowed result).
Deno.test("send-sms/index.ts wires the suppression refusal between the pause check and the Twilio request", async () => {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const pause = src.indexOf("isSmsPaused(");
  const sup = src.indexOf("smsSuppressionRefusal(");
  const rate = src.indexOf('"check_rate_limit"');
  const post = src.indexOf("api.twilio.com/2010-04-01/Accounts/");
  assert(sup > -1, "index.ts never calls smsSuppressionRefusal");
  assert(pause > -1 && pause < sup && sup < rate && rate < post, "order must be pause < suppression < rate limit < Twilio POST");
  assert(/if\s*\(\s*suppressionRefusal\s*\)\s*return\s+suppressionRefusal\s*;/.test(src), "the refusal must be returned");
  assert(!/bypass|skip_suppression|skipSuppression/i.test(src), "no bypass flag");
});
