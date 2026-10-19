// gh-2884: structural guard that EVERY SMS body process-dunning can send names the sender.
// Test-only. index.ts calls serve() at import time, so (like sms-sender-id.test.ts) it is read as text.
// Brand string: D-175 ("Otter Quotes", two words) governs; see #2884.
//
// What it enforces (all fail closed):
//  1. Transport: the only SMS transport is the sendSMS helper in index.ts. Neither index.ts nor any
//     local module it imports (recursively) may reach api.twilio.com / Messages.json / a twilio import /
//     a send-sms function elsewhere, and every other fetch() must go to an allow-listed non-SMS host.
//  2. References: sendSMS and sendSMSToAll may only be DIRECTLY called (or defined). Aliasing,
//     destructuring, passing as a value, or string/bracket access fails.
//  3. Bodies: for every sendSMSToAll(phones, body) call, EVERY branch of the body expression (each arm
//     of ?: / || / ??, and the start of every concatenation) must begin with a string/template literal
//     starting "Otter Quotes". A brand on only a dead/optional branch does not count.
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-all-bodies.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const BRAND = "Otter Quotes";

// ---------------------------------------------------------------- scanning helpers

export function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Index just past the string/template literal starting at s[i] (quote char). */
export function skipString(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (q === "`" && c === "$" && s[j + 1] === "{") { j = skipBalanced(s, j + 1); continue; }
    if (c === q) return j + 1;
    j++;
  }
  return s.length;
}

/** Index just past the bracket group opening at s[i] ((, [ or {), skipping nested strings. */
export function skipBalanced(s: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") { j = skipString(s, j); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return s.length;
}

/** Split `expr` on top-level occurrences of any separator (outside strings and brackets). */
export function splitTop(expr: string, seps: string[]): string[] {
  const out: string[] = [];
  let start = 0;
  let j = 0;
  while (j < expr.length) {
    const c = expr[j];
    if (c === '"' || c === "'" || c === "`") { j = skipString(expr, j); continue; }
    if (c === "(" || c === "[" || c === "{") { j = skipBalanced(expr, j); continue; }
    const sep = seps.find((p) => expr.startsWith(p, j));
    if (sep) {
      out.push(expr.slice(start, j));
      j += sep.length;
      start = j;
      continue;
    }
    j++;
  }
  out.push(expr.slice(start));
  return out;
}

/** The initializer expression of `const NAME = ...;` (text up to the top-level ;), or null. */
export function constInitializer(src: string, name: string): string | null {
  const m = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*`).exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  return splitTop(rest, [";"])[0].trim();
}

// ---------------------------------------------------------------- body check

/**
 * Violations for one body expression: every branch must begin with a literal starting with BRAND.
 * Returns [] when the expression is fully covered.
 */
export function bodyViolations(src: string, expr: string, depth = 0): string[] {
  const e = expr.trim();
  if (depth > 8) return [`expression nests too deeply: ${e.slice(0, 40)}`];
  if (e === "") return ["empty body expression"];

  // Whole expression wrapped in one pair of parentheses.
  if (e[0] === "(" && skipBalanced(e, 0) === e.length) return bodyViolations(src, e.slice(1, -1), depth + 1);

  // Ternary: condition is not a body; both arms are.
  const q = splitTop(e, ["??", "||", "&&", "?"]);
  if (q.length > 1) {
    const ternary = e.slice(q[0].length).startsWith("?") && !e.slice(q[0].length).startsWith("??");
    if (ternary) {
      const rest = e.slice(q[0].length + 1);
      const arms = splitTop(rest, [":"]);
      if (arms.length !== 2) return [`unsupported ternary shape: ${e.slice(0, 60)}`];
      return arms.flatMap((a) => bodyViolations(src, a, depth + 1));
    }
    // || ?? && : every operand could be the whole message.
    return splitTop(e, ["??", "||", "&&"]).flatMap((a) => bodyViolations(src, a, depth + 1));
  }

  // Concatenation: the message starts with the first piece, so that piece must carry the brand.
  const first = splitTop(e, ["+"])[0].trim();
  if (first[0] === '"' || first[0] === "'" || first[0] === "`") {
    if (skipString(first, 0) !== first.length) return [`first piece is not a single literal: ${first.slice(0, 60)}`];
    const text = first.slice(1, -1);
    return text.startsWith(BRAND) ? [] : [`literal does not begin with "${BRAND}": ${JSON.stringify(text.slice(0, 50))}`];
  }
  if (/^[A-Za-z_$][\w$]*$/.test(first)) {
    const init = constInitializer(src, first);
    return init === null ? [`cannot resolve identifier ${first}`] : bodyViolations(src, init, depth + 1);
  }
  return [`unsupported body expression (must start with a literal or a named const): ${first.slice(0, 60)}`];
}

// ---------------------------------------------------------------- call sites & references

/** Source text of the args of every direct call `name(...)`, definition excluded. */
export function callArgs(src: string, name: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = skipBalanced(src, open) - 1;
    out.push(splitTop(src.slice(open + 1, close), [","]).map((a) => a.trim()).filter((a) => a !== ""));
  }
  return out;
}

/** Every reference to `name` that is neither a definition nor a direct call. */
export function nonCallReferences(src: string, name: string): string[] {
  const bad: string[] = [];
  const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 14), m.index);
    const after = src.slice(m.index + name.length);
    if (/function\s+$/.test(before) && /^\s*\(/.test(after)) continue; // definition
    if (/^\s*\(/.test(after) && !/\.\s*$/.test(before)) continue; // direct call
    bad.push(src.slice(Math.max(0, m.index - 25), m.index + name.length + 25).replace(/\s+/g, " "));
  }
  return bad;
}

// ---------------------------------------------------------------- transport

/** Body range [start, end) of `async function sendSMS(`, or null. */
export function functionRange(src: string, name: string): [number, number] | null {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  const open = src.indexOf("{", skipBalanced(src, m.index + m[0].length - 1));
  return [m.index, skipBalanced(src, open)];
}

const FORBIDDEN_TRANSPORT = [
  /api\.twilio\.com/,
  /Messages\.json/,
  /(?:from|import)\s*\(?\s*["'][^"']*twilio/i,
  /send-sms/,
];
const FETCH_ALLOW = [/api\.mailgun\.net/, /STRIPE_API_BASE/];

/** Violations for one module's (comment-stripped) text, with the sendSMS body already removed. */
export function transportViolations(file: string, srcWithoutSendSms: string): string[] {
  const v: string[] = [];
  for (const re of FORBIDDEN_TRANSPORT) if (re.test(srcWithoutSendSms)) v.push(`${file}: ${re} outside the sendSMS helper`);
  const re = /(?<![\w$.])fetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(srcWithoutSendSms)) !== null) {
    const open = m.index + m[0].length - 1;
    const arg = splitTop(srcWithoutSendSms.slice(open + 1, skipBalanced(srcWithoutSendSms, open) - 1), [","])[0];
    if (!FETCH_ALLOW.some((a) => a.test(arg))) v.push(`${file}: fetch to a non-allow-listed URL: ${arg.trim().slice(0, 70)}`);
  }
  return v;
}

/** Local relative modules imported by `src` (non-test), e.g. "./templates.ts", "../_shared/x.ts". */
export function localImports(src: string): string[] {
  const out = new Set<string>();
  const re = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return [...out];
}

async function loadModules(): Promise<Map<string, string>> {
  const mods = new Map<string, string>();
  const queue: URL[] = [new URL("./index.ts", import.meta.url)];
  while (queue.length) {
    const url = queue.pop()!;
    if (mods.has(url.href)) continue;
    const src = stripComments(await Deno.readTextFile(url));
    mods.set(url.href, src);
    for (const rel of localImports(src)) queue.push(new URL(rel, url));
  }
  return mods;
}

const indexUrl = () => new URL("./index.ts", import.meta.url).href;

// ---------------------------------------------------------------- tests

Deno.test("gh-2884 process-dunning: every SMS body at every sendSMSToAll call site names the sender on EVERY branch", async () => {
  const src = (await loadModules()).get(indexUrl())!;
  const calls = callArgs(src, "sendSMSToAll");
  assert(calls.length >= 4, `expected at least 4 sendSMSToAll call sites, found ${calls.length}`);
  for (const args of calls) {
    assertEquals(args.length, 2, `sendSMSToAll must be called with exactly (phones, body): ${args.join(" , ")}`);
    const v = bodyViolations(src, args[1]);
    assertEquals(v, [], `SMS body "${args[1].slice(0, 40)}" has a branch without the sender name`);
  }
});

Deno.test("gh-2884 process-dunning: sendSMS and sendSMSToAll are only ever directly called (no alias, destructure, or value use)", async () => {
  const src = (await loadModules()).get(indexUrl())!;
  for (const name of ["sendSMS", "sendSMSToAll"]) {
    assertEquals(nonCallReferences(src, name), [], `${name} referenced other than by a direct call`);
  }
  assertEquals(callArgs(src, "sendSMS").length, 1, "sendSMS( must have exactly one call site (inside sendSMSToAll)");
});

Deno.test("gh-2884 process-dunning: the sendSMS helper is the only SMS transport in index.ts and every local module it imports", async () => {
  const mods = await loadModules();
  assert(mods.size >= 2, "expected index.ts plus at least one local import");
  const violations: string[] = [];
  for (const [href, src] of mods) {
    let rest = src;
    if (href === indexUrl()) {
      const r = functionRange(src, "sendSMS");
      assert(r !== null, "sendSMS helper not found in index.ts");
      const inside = src.slice(r![0], r![1]);
      assert(/api\.twilio\.com/.test(inside) && /Messages\.json/.test(inside), "sendSMS no longer holds the Twilio endpoint; update this guard");
      rest = src.slice(0, r![0]) + src.slice(r![1]);
    }
    violations.push(...transportViolations(href.split("/").slice(-2).join("/"), rest));
  }
  assertEquals(violations, [], "a second SMS transport (or an un-allow-listed fetch) exists");
});

// ---------------------------------------------------------------- controls on the scanners themselves

Deno.test("control: brand only on a dead ternary branch is rejected", () => {
  const e = '(cond ? "Otter Quotes" : "") + `text ${x}`';
  assert(bodyViolations("", e).length > 0);
});
Deno.test("control: ternary / || / ?? arms are each required to carry the brand", () => {
  assertEquals(bodyViolations("", 'c ? "Otter Quotes: a" : "Otter Quotes: b"'), []);
  assert(bodyViolations("", 'c ? "Otter Quotes: a" : "hello"').length > 0);
  assert(bodyViolations("", 'x || "hello"').length > 0);
  assert(bodyViolations("", 'x ?? "Otter Quotes: a"').length > 0); // x is not a resolvable body
});
Deno.test("control: concatenation must START with the brand; later pieces may be anything", () => {
  assertEquals(bodyViolations("", '"Otter Quotes: a" + `b ${u}` + "c"'), []);
  assert(bodyViolations("", '"hello " + "Otter Quotes"').length > 0);
});
Deno.test("control: named const bodies resolve; unresolvable or function-call bodies fail closed", () => {
  const src = 'const A =\n  "Otter Quotes: a" +\n  `b ${u};`;\nconst B = "nope";';
  assertEquals(bodyViolations(src, "A"), []);
  assert(bodyViolations(src, "B").length > 0);
  assert(bodyViolations(src, "missing").length > 0);
  assert(bodyViolations(src, "build()").length > 0);
});
Deno.test("control: alias, destructure and value use are caught; direct call and definition are not", () => {
  assert(nonCallReferences("const go = sendSMSToAll; go(p, 'x');", "sendSMSToAll").length > 0);
  assert(nonCallReferences("const { sendSMSToAll: go } = mod;", "sendSMSToAll").length > 0);
  assert(nonCallReferences("run(sendSMSToAll);", "sendSMSToAll").length > 0);
  assertEquals(nonCallReferences("async function sendSMSToAll(a, b) {}\nawait sendSMSToAll(p, B);", "sendSMSToAll"), []);
});
Deno.test("control: a second Twilio fetch and an un-allow-listed fetch are caught", () => {
  assert(transportViolations("x", 'await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s}/Messages.json`, {});').length > 0);
  assert(transportViolations("x", 'await fetch("https://example.com/hook", {});').length > 0);
  assertEquals(transportViolations("x", "await fetch(`https://api.mailgun.net/v3/${d}/messages`, {});"), []);
});
