// gh-2564: static check that no non-test code writes a quotes.bid_status or quotes.status literal that
// production's check constraints refuse. Grep-based, in the style of gh2426-no-hubspot-callers.test.ts.
//
// Production, read 2026-10-13 (SELECT on pg_constraint):
//   quotes_bid_status_check: bid_status IN ('active','expired','superseded','cancelled')
//   quotes_status_check:     status     IN ('draft','submitted','selected','declined','expired')
// If a constraint is widened or narrowed, update the sets below in the same PR as the migration.
//
// Scope: object-literal keys (`bid_status: 'x'`, `bid_status: "x"`) and assignments (`.bid_status = 'x'`) in
// supabase/functions/**, react-app/app/** and the root *.html pages (tests, node_modules and Archive skipped),
// plus `status: 'x'` keys inside an .update(/.insert(/.upsert( that follows .from('quotes').
// Comparisons (===, .eq(), IN lists) are reads and are not matched.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const BID_STATUS_ADMITTED = new Set(["active", "expired", "superseded", "cancelled"]);
const STATUS_ADMITTED = new Set(["draft", "submitted", "selected", "declined", "expired"]);

// Known refused writes that are tracked elsewhere and NOT fixed by this change. Each entry must still be present
// in the scan (the last test fails when one is fixed, so the entry is deleted with the fix).
const KNOWN_OPEN: { file: string; col: "status" | "bid_status"; value: string; issue: string }[] = [
  // switch-contractor writes quotes.status = 'cancelled' (refused 23514); #2564 finding 2, not in this PR.
  { file: "supabase/functions/switch-contractor/index.ts", col: "status", value: "cancelled", issue: "#2564 finding 2" },
];

const ROOT = new URL("../../../", import.meta.url);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (["node_modules", "Archive", ".git", ".next", "__tests__"].includes(e.name)) continue;
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else yield u;
  }
}

type Hit = { file: string; col: "status" | "bid_status"; value: string };

export function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/\bbid_status\s*(?::|(?<![=!<>])=(?!=))\s*(['"])([a-z_]+)\1/g)) {
    hits.push({ file, col: "bid_status", value: m[2] });
  }
  for (const f of text.matchAll(/\.from\(\s*(['"])quotes\1\s*\)/g)) {
    const win = text.slice(f.index!, f.index! + 2500);
    const w = win.match(/\.(update|insert|upsert)\(/);
    if (!w) continue;
    const afterOp = win.slice(w.index!);
    // the object literal of the write: up to the first `.eq(`/`.select(`/`;` after the opening paren
    const end = afterOp.search(/\)\s*\.(eq|in|match|select|neq|is)\(|;/);
    const body = end === -1 ? afterOp : afterOp.slice(0, end);
    for (const s of body.matchAll(/(?<![\w.])status\s*:\s*(['"])([a-z_]+)\1/g)) {
      hits.push({ file, col: "status", value: s[2] });
    }
  }
  return hits;
}

async function allHits(): Promise<Hit[]> {
  const out: Hit[] = [];
  for (const dir of ["supabase/functions/", "react-app/app/"]) {
    for await (const u of walk(new URL(dir, ROOT))) {
      const p = u.pathname.slice(ROOT.pathname.length);
      if (!/\.(ts|tsx|js)$/.test(p) || /\.test\.(ts|tsx|js)$/.test(p)) continue;
      out.push(...scan(p, await Deno.readTextFile(u)));
    }
  }
  for await (const e of Deno.readDir(ROOT)) {
    if (e.isFile && e.name.endsWith(".html")) out.push(...scan(e.name, await Deno.readTextFile(new URL(e.name, ROOT))));
  }
  return out;
}

const isRefused = (h: Hit) => !(h.col === "bid_status" ? BID_STATUS_ADMITTED : STATUS_ADMITTED).has(h.value);
const isKnown = (h: Hit) => KNOWN_OPEN.some((k) => k.file === h.file && k.col === h.col && k.value === h.value);

Deno.test("scanner control: it catches the pre-fix writes (negative control)", () => {
  const preRescind = `await supabase.from("quotes").update({\n bid_status: "rescinded",\n updated_at: x,\n }).eq("id", id)`;
  assertEquals(scan("x.ts", preRescind).filter(isRefused).map((h) => h.value), ["rescinded"]);
  const preRenew = `...(renewMode ? {\n bid_status: 'submitted',\n expired_at: null } : {})`;
  assertEquals(scan("x.html", preRenew).filter(isRefused).map((h) => h.value), ["submitted"]);
  const preSwitch = `await supabase.from("quotes").update({ status: "cancelled", cancelled_at: n }).eq("id", q)`;
  assertEquals(scan("x.ts", preSwitch).filter(isRefused).map((h) => h.value), ["cancelled"]);
  const reads = `if (q.bid_status === 'rescinded') {} .eq('bid_status','rescinded') const x = { bid_status: 'active' }`;
  assertEquals(scan("x.ts", reads).filter(isRefused), []);
});

Deno.test("no code writes a bid_status or quotes.status value the live constraints refuse", async () => {
  const hits = await allHits();
  assert(hits.length > 5, `scanner found only ${hits.length} writes; the scan is broken`);
  const bad = hits.filter((h) => isRefused(h) && !isKnown(h));
  assertEquals(bad, [], `refused writes: ${JSON.stringify(bad)}`);
});

Deno.test("each KNOWN_OPEN entry is still present (delete the entry when the write is fixed)", async () => {
  const hits = await allHits();
  for (const k of KNOWN_OPEN) {
    assert(hits.some((h) => h.file === k.file && h.col === k.col && h.value === k.value), `${k.issue}: ${k.file} no longer writes ${k.col}='${k.value}'; remove the KNOWN_OPEN entry`);
  }
});
