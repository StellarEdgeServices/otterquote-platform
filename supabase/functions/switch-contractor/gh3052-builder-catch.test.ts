// gh-3052 -- `.catch` chained on a supabase-js query builder.
//
// A PostgrestBuilder is a thenable, NOT a Promise: it has `.then` but no `.catch`.
// `await sb.from(t).insert(x).catch(...)` throws "TypeError: ....catch is not a
// function" before the request is sent. In switch-contractor step 11 that threw
// after the claim reset and the emails had committed, so the function returned
// 500 and no contractor_switched row was written (diagnosis [RW-EVIDENCE:
// cto77-w3017b] on #3017). The scanner below finds the whole class across
// supabase/functions (insert/update/upsert/delete/select/rpc chains).
//
// FAIL-FIRST: on main, the scan reports switch-contractor/index.ts, process-payout-reminders/
// index.ts and send-incomplete-onboarding-reminders/index.ts, and the step-11 wiring test fails.
// Run: deno test --allow-read=supabase/functions supabase/functions/switch-contractor/gh3052-builder-catch.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---- a faithful stand-in for the supabase-js builder: thenable, no .catch ----
function fakeBuilder(result: { error: unknown }) {
  return {
    then(onOk: (r: { error: unknown }) => unknown) {
      return Promise.resolve(result).then(onOk);
    },
  };
}
// deno-lint-ignore no-explicit-any
const asAny = (x: unknown): any => x;

// ---- scanner: walks back from each `.catch(` over the call chain it is attached to ----
export interface Hit { line: number; chain: string }

export function scanForBuilderCatch(text: string): Hit[] {
  const hits: Hit[] = [];
  const re = /\.catch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let i = m.index; // index of the '.' before catch
    const methods: string[] = [];
    // walk back over `.name(...)` / `.name` / `name(...)` links
    for (;;) {
      while (i > 0 && /\s/.test(text[i - 1])) i--;
      if (text[i - 1] === ")") {
        let depth = 0;
        let j = i - 1;
        for (; j >= 0; j--) {
          if (text[j] === ")") depth++;
          else if (text[j] === "(") { depth--; if (depth === 0) break; }
        }
        let k = j;
        while (k > 0 && /\s/.test(text[k - 1])) k--;
        let e = k;
        while (e > 0 && /[A-Za-z0-9_$]/.test(text[e - 1])) e--;
        methods.push(text.slice(e, k));
        i = e;
        while (i > 0 && /\s/.test(text[i - 1])) i--;
        if (text[i - 1] === ".") { i--; continue; }
        if (text[i - 1] === "?" && text[i - 2] === ".") { i -= 2; continue; }
        break;
      } else if (/[A-Za-z0-9_$\]]/.test(text[i - 1] ?? "")) {
        let e = i;
        while (e > 0 && /[A-Za-z0-9_$]/.test(text[e - 1])) e--;
        methods.push(text.slice(e, i));
        i = e;
        while (i > 0 && /\s/.test(text[i - 1])) i--;
        if (text[i - 1] === ".") { i--; continue; }
        break;
      } else break;
    }
    // methods is nearest-first. The builder is only the receiver of `.catch` when no
    // real Promise link (`then`, `json`, `text`, `fetch`, storage calls) sits between.
    const ordered = [...methods].reverse(); // outermost-first: sb, from, insert, ...
    const iFrom = ordered.findIndex((n) => n === "from" || n === "rpc");
    if (iFrom === -1) continue;
    if (ordered.includes("storage")) continue; // storage-js returns real Promises
    const after = ordered.slice(iFrom + 1);
    if (after.includes("then")) continue; // `.then()` returns a real Promise
    hits.push({ line: text.slice(0, m.index).split("\n").length, chain: ordered.join(".") });
  }
  return hits;
}

Deno.test("scanner flags the builder .catch shapes (negative controls: it can fail)", () => {
  const bad1 = `await sb.from("activity_log").insert({ title: "x" }).catch(err => console.warn(err));`;
  const bad2 = `await supabase.rpc("record_cron_health", { p_job_name: X }).catch(() => {});`;
  const bad3 = `await sb\n  .from("quotes")\n  .update({ s: 1 })\n  .eq("id", 1)\n  .catch(() => {});`;
  assertEquals(scanForBuilderCatch(bad1).length, 1);
  assertEquals(scanForBuilderCatch(bad2).length, 1);
  assertEquals(scanForBuilderCatch(bad3).length, 1);
});

Deno.test("scanner does not flag real-Promise chains", () => {
  assertEquals(scanForBuilderCatch(`const b = await req.json().catch(() => ({}));`).length, 0);
  assertEquals(scanForBuilderCatch(`await supabase.from("n").insert({ x: 1 }).then(() => {}).catch(() => {});`).length, 0);
  assertEquals(scanForBuilderCatch(`await sbAdmin.storage.from("b").remove([p]).catch(() => {});`).length, 0);
  assertEquals(scanForBuilderCatch(`fetch(u).then(r => r.json()).catch(e => e);`).length, 0);
  const { error } = { error: null };
  assertEquals(error, null);
});

Deno.test("the fake builder reproduces the production TypeError; the destructured form does not throw", async () => {
  const insertOld = () => asAny(fakeBuilder({ error: null })).catch(() => {});
  let threw: unknown;
  try { await insertOld(); } catch (e) { threw = e; }
  assert(threw instanceof TypeError, "old shape must throw TypeError (catch is not a function)");

  const { error } = await asAny(fakeBuilder({ error: { message: "boom" } }));
  assertEquals(error.message, "boom"); // the new shape surfaces the error as data, no throw
});

// ---- the repo-wide guard ----
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) yield p;
  }
}

Deno.test("no Edge Function chains .catch on a supabase-js query builder", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const offenders: string[] = [];
  let scanned = 0;
  for await (const f of walk(root)) {
    scanned++;
    for (const h of scanForBuilderCatch(await Deno.readTextFile(f))) {
      offenders.push(`${f.slice(root.length + 1)}:${h.line} ${h.chain}`);
    }
  }
  assert(scanned > 50, `scan walked too few files (${scanned}); root wrong?`);
  assertEquals(offenders, []);
});

Deno.test("switch-contractor step 11 awaits the insert and checks { error }", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = src.indexOf("// ── 11. Activity log");
  const end = src.indexOf("// ── Done");
  assert(start !== -1 && end > start, "anchors moved; update this test");
  const block = src.slice(start, end);
  assertStringIncludes(block, 'const { error: activityLogError } = await sb.from("activity_log").insert(');
  assertStringIncludes(block, "if (activityLogError)");
  assert(!block.includes(".catch("), "step 11 must not chain .catch on the builder");
  assert(!block.includes("throw"), "an activity-log failure must not throw (non-critical)");
});
