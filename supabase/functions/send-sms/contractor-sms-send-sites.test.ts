// gh-1916 / D-328 / R-134: static inventory + gate guard for every server-side
// SMS send site in supabase/functions.
//
// Run: deno test --allow-read=supabase/functions supabase/functions/send-sms/contractor-sms-send-sites.test.ts
//
// WHY THIS EXISTS. The contractor opt-in checkbox, the stored consent columns
// and the send-path refusal are on main (PR #1938, #2252). Only
// send-contractor-nudge had a test (consent-gate.test.ts). notify-contractors
// and process-dunning enforce the same gate inline with no test, so deleting
// the gate there would fail nothing. This test pins two things:
//   1. The set of files that can put an SMS on the wire is a closed, classified
//      list. A new `functions/v1/send-sms` call or a new Twilio Messages POST
//      anywhere else fails here until someone classifies it (contractor-gated,
//      homeowner/admin, or relay).
//   2. Every file classed "contractor" still carries one sms_opt_in gate per
//      send site, so a contractor without a stored opt-in gets 0 sends.
// It is a static (source) guard, not a behavioural one: the behavioural proof
// for send-contractor-nudge is consent-gate.test.ts. NEGATIVE CONTROLS at the
// bottom feed the checker a send site with no gate and expect a violation.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

type Kind = "contractor" | "admin-alert" | "relay";
// order: "gate-before-send" = every send in the file is preceded by a gate that sits after the
// previous send; "upstream" = the gate is in the function that builds the recipient list, so it
// must come before the first call of `callers` (process-dunning's Twilio helper is defined above
// the gate, so a textual send-before-gate comparison does not apply there).
interface Site { kind: Kind; sites: number; minGates: number; order?: "gate-before-send" | "upstream"; callers?: RegExp }

// path (relative to supabase/functions) -> classification
export const SEND_SITES: Record<string, Site> = {
  // helper gate (sendSmsViaEdgeFunction) + the inlined gate in the new-opportunity loop
  "notify-contractors/index.ts": { kind: "contractor", sites: 2, minGates: 2, order: "gate-before-send" },
  // one gate in the contact builder; every sendSMSToAll() call comes after it in the file
  "process-dunning/index.ts": { kind: "contractor", sites: 1, minGates: 1, order: "upstream", callers: /(?<!function\s)\bsendSMSToAll\s*\(/ },
  // The definition `export function isSmsConsented(` does not match GATE_RE (it needs the `!`),
  // so the one call-site gate is the only hit; 0 hits means the gate was removed or commented out.
  "send-contractor-nudge/consent-gate.ts": { kind: "contractor", sites: 1, minGates: 1, order: "gate-before-send" },
  // Alert to the owner's own number, not a contractor send (see the comment above it in index.ts).
  "send-contractor-nudge/index.ts": { kind: "admin-alert", sites: 1, minGates: 0 },
  // The Twilio relay itself; its callers are the sites above.
  "send-sms/index.ts": { kind: "relay", sites: 1, minGates: 0 },
};

const SEND_RE = /functions\/v1\/send-sms|api\.twilio\.com\/2010-04-01\/Accounts\/\$\{[^}]+\}\/Messages\.json(?!\?)/g;
// Call-site gates only: a negated consent call, or an explicit `sms_opt_in !== true` test.
// `isSmsConsented(` without the `!` (the definition, a doc comment, a call that is not negated) is NOT a gate.
const GATE_RE = /!\s*isSmsConsented\s*\(|\bsms_?opt_?in\s*!==\s*true/gi;
const REFUSAL_RE = /\b(?:return|continue|throw)\b/;

/**
 * Blank out comments (same length, newlines kept, so offsets stay valid) and report which
 * characters sit inside string-literal text. `${...}` expressions inside templates count as
 * code. `ok` is false when the scanner ends inside a string/comment (a desync, e.g. from a
 * regex literal containing a quote) and the caller must not trust the result.
 */
export function scan(src: string): { code: string; inStr: boolean[]; ok: boolean } {
  const out = src.split("");
  const inStr: boolean[] = new Array(src.length).fill(false);
  type Frame = { t: "tpl" } | { t: "expr"; depth: number };
  const stack: Frame[] = [];
  let i = 0;
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const ch = src[i], nx = src[i + 1];
    if (top && top.t === "tpl") {
      if (ch === "\\") { inStr[i] = inStr[i + 1] = true; i += 2; continue; }
      if (ch === "`") { stack.pop(); i++; continue; }
      if (ch === "$" && nx === "{") { stack.push({ t: "expr", depth: 0 }); i += 2; continue; }
      inStr[i] = true; i++; continue;
    }
    // code (top level or inside a ${} expression)
    if (ch === "/" && nx === "/") { const e = src.indexOf("\n", i); const end = e === -1 ? src.length : e; blank(i, end); i = end; continue; }
    if (ch === "/" && nx === "*") { const e = src.indexOf("*/", i + 2); if (e === -1) return { code: out.join(""), inStr, ok: false }; blank(i, e + 2); i = e + 2; continue; }
    if (ch === "`") { stack.push({ t: "tpl" }); i++; continue; }
    if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < src.length && src[k] !== ch && src[k] !== "\n") { if (src[k] === "\\") k++; inStr[k] = true; k++; }
      if (k >= src.length || src[k] !== ch) return { code: out.join(""), inStr, ok: false };
      i = k + 1; continue;
    }
    if (top && top.t === "expr") {
      if (ch === "{") top.depth++;
      else if (ch === "}") { if (top.depth === 0) stack.pop(); else top.depth--; }
    }
    i++;
  }
  return { code: out.join(""), inStr, ok: stack.length === 0 };
}

export function countSendSites(src: string): number {
  return (src.match(SEND_RE) ?? []).length;
}
/** Call-site gates in real code: not in a comment, not inside a string literal. */
export function findGates(src: string): number[] {
  const { code, inStr } = scan(src);
  return [...code.matchAll(GATE_RE)].filter((m) => !inStr[m.index!]).map((m) => m.index!);
}
export function countGates(src: string): number {
  return findGates(src).length;
}
/** The `{ ... }` block that follows a gate condition, or "" if none. */
function gateBlock(code: string, from: number): string {
  const open = code.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === "{") depth++;
    else if (code[k] === "}" && --depth === 0) return code.slice(open, k + 1);
  }
  return "";
}
/** Returns violation strings for one file given its classification (empty = ok). */
export function checkFile(path: string, src: string, c: Site): string[] {
  const v: string[] = [];
  const sites = countSendSites(src);
  if (sites !== c.sites) v.push(`${path}: ${sites} send sites, expected ${c.sites} (classify the new one)`);
  if (c.kind !== "contractor") return v;

  const sc = scan(src);
  if (!sc.ok) { v.push(`${path}: comment/string scanner lost sync (cannot trust the gate check)`); return v; }
  const gates = findGates(src);
  if (gates.length < c.minGates) {
    v.push(`${path}: ${gates.length} sms_opt_in gates for ${sites} contractor send sites (need >= ${c.minGates})`);
  }
  // every gate must refuse: its own block returns, continues or throws
  for (const g of gates) {
    const m = sc.code.slice(g).match(GATE_RE)![0];
    if (!REFUSAL_RE.test(gateBlock(sc.code, g + m.length))) {
      v.push(`${path}: gate at offset ${g} does not refuse (no return/continue/throw in its block)`);
    }
  }
  if (c.order === "gate-before-send") {
    const sends = [...sc.code.matchAll(SEND_RE)].map((m) => m.index!);
    let prev = -1;
    for (const s of sends) {
      if (!gates.some((g) => g > prev && g < s)) {
        v.push(`${path}: send at offset ${s} has no sms_opt_in gate before it (a gate after the send does not count)`);
      }
      prev = s;
    }
  } else if (c.order === "upstream") {
    const firstCall = sc.code.search(c.callers!);
    if (firstCall === -1) v.push(`${path}: no caller of the send helper found (callers pattern is stale)`);
    else if (!gates.length || Math.min(...gates) > firstCall) {
      v.push(`${path}: the first gate sits after the first send-helper call (offset ${firstCall})`);
    }
  }
  return v;
}

const FUNCTIONS_URL = new URL("../", import.meta.url);

async function listTs(dir: URL, out: string[] = [], prefix = ""): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) await listTs(new URL(`${e.name}/`, dir), out, `${prefix}${e.name}/`);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(`${prefix}${e.name}`);
  }
  return out;
}

Deno.test("every SMS send site in supabase/functions is in the classified list", async () => {
  const found: string[] = [];
  for (const p of await listTs(FUNCTIONS_URL)) {
    const src = await Deno.readTextFile(new URL(p, FUNCTIONS_URL));
    if (countSendSites(src) > 0) found.push(p);
  }
  assertEquals(found.sort(), Object.keys(SEND_SITES).sort());
});

Deno.test("each classified send site keeps its sms_opt_in gate (no opt-in -> no send)", async () => {
  const violations: string[] = [];
  for (const [p, c] of Object.entries(SEND_SITES)) {
    const src = await Deno.readTextFile(new URL(p, FUNCTIONS_URL));
    violations.push(...checkFile(p, src, c));
  }
  assertEquals(violations, []);
});

// ── Negative controls: the checker must FAIL on a bad shape, and pass the good one ──
const REFUSE = `{ console.warn("refused"); return false; }`;
const SEND = "await fetch(`${url}/functions/v1/send-sms`, { method: \"POST\", body: \"x\" });";
const GATED = `async function go(contractor) {\n  if (contractor.sms_opt_in !== true) ${REFUSE}\n  ${SEND}\n}`;
const ORDERED: Site = { kind: "contractor", sites: 1, minGates: 1, order: "gate-before-send" };

Deno.test("positive control: the gated shape passes", () => {
  assertEquals(checkFile("x.ts", GATED, ORDERED), []);
});
Deno.test("negative control: a contractor send with no sms_opt_in gate is flagged", () => {
  const v = checkFile("x.ts", `async function go(c) {\n  ${SEND}\n}`, ORDERED);
  assert(v.some((s) => s.includes("0 sms_opt_in gates")));
});
Deno.test("negative control: an unclassified extra send site is flagged", () => {
  const v = checkFile("x.ts", GATED + GATED, ORDERED);
  assert(v.some((s) => s.includes("2 send sites, expected 1")));
});
Deno.test("negative control: a gate that sits AFTER the send is flagged (reviewer bypass M2)", () => {
  const src = `async function go(contractor) {\n  ${SEND}\n  if (contractor.sms_opt_in !== true) ${REFUSE}\n}`;
  const v = checkFile("x.ts", src, ORDERED);
  assert(v.some((s) => s.includes("no sms_opt_in gate before it")), JSON.stringify(v));
});
Deno.test("negative control: a gate that exists only in a comment is flagged (reviewer bypass M3)", () => {
  const src = `async function go(contractor) {\n  // if (contractor.sms_opt_in !== true) ${REFUSE}\n  /* if (!isSmsConsented(a, b)) ${REFUSE} */\n  ${SEND}\n}`;
  const v = checkFile("x.ts", src, ORDERED);
  assert(v.some((s) => s.includes("0 sms_opt_in gates")), JSON.stringify(v));
});
Deno.test("negative control: a gate named only inside a string literal is flagged", () => {
  const src = `async function go(contractor) {\n  const doc = "if (contractor.sms_opt_in !== true) return";\n  ${SEND}\n}`;
  const v = checkFile("x.ts", src, ORDERED);
  assert(v.some((s) => s.includes("0 sms_opt_in gates")), JSON.stringify(v));
});
Deno.test("negative control: the isSmsConsented DEFINITION is not a call-site gate (reviewer defect 1, M1)", () => {
  const src = `export function isSmsConsented(a, b) { return a === true; }\nasync function go(c) {\n  if (false) ${REFUSE}\n  ${SEND}\n}`;
  const v = checkFile("x.ts", src, ORDERED);
  assert(v.some((s) => s.includes("0 sms_opt_in gates")), JSON.stringify(v));
});
Deno.test("negative control: a gate whose block does not refuse is flagged", () => {
  const src = `async function go(contractor) {\n  if (contractor.sms_opt_in !== true) { console.warn("noted"); }\n  ${SEND}\n}`;
  const v = checkFile("x.ts", src, ORDERED);
  assert(v.some((s) => s.includes("does not refuse")), JSON.stringify(v));
});
Deno.test("negative control: upstream mode flags a gate after the first helper call", () => {
  const up: Site = { kind: "contractor", sites: 1, minGates: 1, order: "upstream", callers: /(?<!function\s)\bsendSMSToAll\s*\(/ };
  const good = `async function sendSMSToAll(p) { ${SEND} }\nfunction contacts(c) { if (c.sms_opt_in !== true) ${REFUSE} }\nawait sendSMSToAll(x);`;
  const bad = `async function sendSMSToAll(p) { ${SEND} }\nawait sendSMSToAll(x);\nfunction contacts(c) { if (c.sms_opt_in !== true) ${REFUSE} }`;
  assertEquals(checkFile("x.ts", good, up), []);
  assert(checkFile("x.ts", bad, up).some((s) => s.includes("sits after the first send-helper call")));
});
Deno.test("scanner: handles // inside strings, nested template expressions and comment text", () => {
  const src = "const u = `https://a.b/${x ? `y` : \"z\"}`; // sms_opt_in !== true\nconst q = 'it\\'s'; /* isSmsConsented( */";
  const sc = scan(src);
  assert(sc.ok);
  assertEquals(findGates(src), []);
  assert(sc.code.includes("https://a.b/"));
});

// ── The same bypasses against the REAL files (mutated in memory, never written) ──
async function real(p: string): Promise<string> {
  return await Deno.readTextFile(new URL(p, FUNCTIONS_URL));
}
function mutate(src: string, from: string | RegExp, to: string): string {
  const out = src.replace(from, to);
  assert(out !== src, `mutation did not apply: ${from}`);
  return out;
}
Deno.test("real files: the scanner stays in sync on every classified file", async () => {
  for (const p of Object.keys(SEND_SITES)) assert(scan(await real(p)).ok, `${p}: scanner desync`);
});
Deno.test("real files: removing the nudge call-site gate fails (M1)", async () => {
  const src = mutate(await real("send-contractor-nudge/consent-gate.ts"), "if (!isSmsConsented(smsOptIn, smsConsentTextVersion)) {", "if (false) {");
  assert(checkFile("send-contractor-nudge/consent-gate.ts", src, SEND_SITES["send-contractor-nudge/consent-gate.ts"]).length > 0);
});
Deno.test("real files: commenting out the notify-contractors inline gate fails (M3)", async () => {
  const src = mutate(await real("notify-contractors/index.ts"), "if (contractor.sms_opt_in !== true) {", "// contractor.sms_opt_in !== true was here\n        if (false) {");
  const v = checkFile("notify-contractors/index.ts", src, SEND_SITES["notify-contractors/index.ts"]);
  assert(v.some((s) => s.includes("1 sms_opt_in gates")), JSON.stringify(v));
});
Deno.test("real files: a process-dunning gate moved below the helper calls fails", async () => {
  const src = (await real("process-dunning/index.ts")).replace(/\n\s*if \(contractor\.sms_opt_in !== true\) \{[\s\S]*?return \{ emails, phones: \[\] \};\n\s*\}\n/, "\n") +
    "\nfunction late(contractor) { if (contractor.sms_opt_in !== true) { return null; } }\n";
  const v = checkFile("process-dunning/index.ts", src, SEND_SITES["process-dunning/index.ts"]);
  assert(v.some((s) => s.includes("sits after the first send-helper call")), JSON.stringify(v));
});
