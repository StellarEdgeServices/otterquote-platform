// gh-2884: structural guard that EVERY SMS body process-dunning can send names the sender.
// Test-only. index.ts calls serve() at import time, so (like sms-sender-id.test.ts) it is read as text.
// Instead of a hard-coded list of template names, this finds every sendSMSToAll(<phones>, <body>) call
// site, resolves <body> (an inline literal or a `const NAME = ...;` definition) to its string value,
// and asserts each contains the sender name. A NEW sms call site or template is therefore covered
// automatically, and an unresolvable body fails the test rather than being skipped.
// Brand string: D-175 ("Otter Quotes", two words) governs; see #2884.
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-all-bodies.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const BRAND = "Otter Quotes";

export function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Concatenated value of the string/template literals in an expression ("a" + `b${x}` -> "ab${x}"). */
export function literalValue(expr: string): string {
  const parts = expr.match(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/g) ?? [];
  return parts.map((p) => p.slice(1, -1)).join("");
}

/** Second argument source text of every sendSMSToAll(...) call (the helper's own definition excluded). */
export function smsCallArgs(src: string): string[] {
  const out: string[] = [];
  const re = /sendSMSToAll\(\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*([^)]+?)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push(m[1]);
  }
  return out;
}

/** Resolve a call argument (identifier or inline literal expression) to its body text, or null. */
export function resolveBody(src: string, arg: string): string | null {
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
    const d = src.match(new RegExp(`const ${arg}\\s*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)`));
    return d ? literalValue(d[1]) : null;
  }
  const v = literalValue(arg);
  return v === "" ? null : v;
}

export function allSmsBodies(src: string): { arg: string; body: string | null }[] {
  return smsCallArgs(src).map((arg) => ({ arg, body: resolveBody(src, arg) }));
}

async function indexSource(): Promise<string> {
  return stripComments(await Deno.readTextFile(new URL("./index.ts", import.meta.url)));
}

Deno.test("gh-2884 process-dunning: every SMS body at every sendSMSToAll call site names the sender", async () => {
  const src = await indexSource();
  const bodies = allSmsBodies(src);
  assert(bodies.length >= 4, `expected at least 4 sendSMSToAll call sites, found ${bodies.length}`);
  for (const { arg, body } of bodies) {
    assert(body !== null && body !== "", `could not resolve the SMS body for argument "${arg}"`);
    assert(body!.includes(BRAND), `SMS body for "${arg}" does not contain "${BRAND}": ${JSON.stringify(body!.slice(0, 60))}`);
  }
});

Deno.test("gh-2884 process-dunning: sendSMS is only called from the sendSMSToAll helper (no bypass path)", async () => {
  const src = await indexSource();
  const calls = src.match(/\bsendSMS\(/g) ?? [];
  const defs = src.match(/function\s+sendSMS\(/g) ?? [];
  assertEquals(calls.length - defs.length, 1, "sendSMS( must have exactly one call site (inside sendSMSToAll)");
});

// Controls on the scanner itself.
Deno.test("negative control: a body without the name is detected", () => {
  const src = `const X_SMS = "Hello there " + \`x\${U}\`;\nawait sendSMSToAll(c.phones, X_SMS);`;
  const [b] = allSmsBodies(src);
  assertEquals(b.body!.includes(BRAND), false);
});
Deno.test("positive control: inline literal and const bodies both resolve", () => {
  const src = `const A = "Otter Quotes: a" +\n  "b";\nawait sendSMSToAll(p, A);\nawait sendSMSToAll(p, \`Otter Quotes: hi \${U}\`);`;
  const bs = allSmsBodies(src);
  assertEquals(bs.length, 2);
  assert(bs.every((b) => b.body!.includes(BRAND)));
});
