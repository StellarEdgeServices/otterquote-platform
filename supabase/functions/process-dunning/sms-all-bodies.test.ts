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
//  4. Scope-aware names (B1): an identifier used as a body must have exactly ONE declaration in the module
//     (no block-scoped duplicate/shadow, no let/var/destructure/parameter shadow) and no reassignment.
//  5. Send path pinned (B2): sendSMSToAll passes its `message` parameter UNCHANGED as the second argument of
//     the single sendSMS call, sendSMS appends exactly that parameter as the one Twilio "Body" and sends that
//     same URLSearchParams as the fetch body, and neither parameter is reassigned/shadowed.
// Negative controls: in-memory mutations of the REAL index.ts (M0-M3, B1, B2a-d) must each produce violations.
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

// ---------------------------------------------------------------- identifier hazards (B1)

const NOT_MEMBER = "(?<![\\w$.])";
const NOT_IDENT = "(?![\\w$])";

/**
 * Hazards that make a name unsafe to resolve with a text scan: more or fewer than one declaration
 * (const/let/var, destructuring, parameter) anywhere in the module, or any reassignment/increment.
 * `exactlyOne` additionally requires a declaration to exist (a body identifier must resolve to one).
 */
export function identifierHazards(src: string, name: string, exactlyOne: boolean): string[] {
  const n = name.replace(/[$]/g, "\\$&");
  const id = `${NOT_MEMBER}${n}${NOT_IDENT}`;
  const decls =
    (src.match(new RegExp(`\\b(?:const|let|var)\\s+${n}${NOT_IDENT}`, "g")) ?? []).length +
    (src.match(new RegExp(`\\b(?:const|let|var)\\s*[\\[{][^;=]*?${id}[^;=]*?[\\]}]\\s*=`, "g")) ?? []).length +
    (src.match(new RegExp(`\\bfunction\\b[^(]*\\([^)]*${id}`, "g")) ?? []).length +
    (src.match(new RegExp(`\\(([^()]*)\\)\\s*(?::[^=;{]+)?=>`, "g")) ?? []).filter((m) => new RegExp(id).test(m)).length +
    (src.match(new RegExp(`${id}\\s*=>`, "g")) ?? []).length;
  const v: string[] = [];
  if (exactlyOne ? decls !== 1 : decls > 1) v.push(`${name}: ${decls} declarations/shadows in the module (need exactly one, unambiguous scope)`);
  const assign = new RegExp(`(?<!\\b(?:const|let|var)\\s+)${id}\\s*\\]?\\s*\\}?\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])`, "g");
  if (assign.test(src)) v.push(`${name}: reassigned`);
  if (new RegExp(`${id}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${id}`).test(src)) v.push(`${name}: incremented/decremented`);
  return v;
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
    const hazards = identifierHazards(src, first, true);
    if (hazards.length) return hazards;
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

// ---------------------------------------------------------------- send path (B2)

/** Parameter names of `function name(...)` (fails closed on destructuring/defaults/rest). */
export function paramNames(src: string, name: string): string[] | null {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const params = splitTop(src.slice(open + 1, skipBalanced(src, open) - 1), [","]).map((p) => p.trim()).filter((p) => p !== "");
  const names: string[] = [];
  for (const p of params) {
    const mm = /^([A-Za-z_$][\w$]*)\s*:\s*[^=]+$/.exec(p);
    if (!mm) return null;
    names.push(mm[1]);
  }
  return names;
}

/** Text of the function body (from its opening brace), or null. */
function bodyText(src: string, name: string): string | null {
  const r = functionRange(src, name);
  if (!r) return null;
  const fn = src.slice(r[0], r[1]);
  const open = fn.indexOf("{", skipBalanced(fn, fn.indexOf("(")));
  return fn.slice(open);
}

/** Hazards for a name INSIDE a function body: declared, shadowed, or reassigned there. */
function bodyHazards(body: string, name: string, label: string): string[] {
  const n = name.replace(/[$]/g, "\\$&");
  const id = `${NOT_MEMBER}${n}${NOT_IDENT}`;
  const v: string[] = [];
  if (new RegExp(`\\b(?:const|let|var)\\s*[\\[{]?[^;=]*?${id}`).test(body) && new RegExp(`\\b(?:const|let|var)\\s+${n}${NOT_IDENT}|\\b(?:const|let|var)\\s*[\\[{][^;=]*?${id}`).test(body)) v.push(`${label}: ${name} re-declared inside the function`);
  if (/\bfunction\b/.test(body)) v.push(`${label}: nested function declaration`);
  if ((body.match(/\(([^()]*)\)\s*(?::[^=;{]+)?=>/g) ?? []).some((m) => new RegExp(id).test(m)) || new RegExp(`${id}\\s*=>`).test(body)) v.push(`${label}: ${name} shadowed by an arrow parameter`);
  const assign = new RegExp(`${id}\\s*\\]?\\s*\\}?\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])`);
  if (assign.test(body)) v.push(`${label}: ${name} reassigned`);
  if (new RegExp(`${id}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${id}`).test(body)) v.push(`${label}: ${name} incremented/decremented`);
  return v;
}

/**
 * The body that reaches Twilio must be exactly the `message` passed to sendSMSToAll:
 *  - sendSMSToAll(phones, M): its single sendSMS call is sendSMS(<to>, M) with M never reassigned or shadowed;
 *  - sendSMS(to, Q): exactly one "Body" key, appended as V.append("Body", Q) to the single
 *    `const V = new URLSearchParams()`, V is what fetch sends (`body: V.toString()`), Q/V never reassigned.
 */
export function sendPathViolations(src: string): string[] {
  const v: string[] = [];
  const all = paramNames(src, "sendSMSToAll");
  const one = paramNames(src, "sendSMS");
  if (!all || all.length !== 2) return ["sendSMSToAll must have exactly two plain typed parameters (phones, message)"];
  if (!one || one.length !== 2) return ["sendSMS must have exactly two plain typed parameters (to, message)"];
  const M = all[1];
  const Q = one[1];

  const allBody = bodyText(src, "sendSMSToAll")!;
  const inner = callArgs(allBody, "sendSMS");
  if (inner.length !== 1) v.push(`sendSMSToAll must contain exactly one sendSMS call, found ${inner.length}`);
  for (const a of inner) {
    if (a.length !== 2 || a[1] !== M) v.push(`sendSMSToAll must pass its ${M} parameter unchanged: sendSMS(${a.join(", ")})`);
  }
  v.push(...bodyHazards(allBody, M, "sendSMSToAll"));

  const smsBody = bodyText(src, "sendSMS")!;
  v.push(...bodyHazards(smsBody, Q, "sendSMS"));
  const bodyKeys = (smsBody.match(/["'`]Body["'`]/g) ?? []).length;
  if (bodyKeys !== 1) v.push(`sendSMS must set the "Body" form key exactly once, found ${bodyKeys}`);
  const params = [...smsBody.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+URLSearchParams\s*\(([^)]*)\)/g)];
  if (params.length !== 1 || (params[0] && params[0][2].trim() !== "")) {
    v.push("sendSMS must create exactly one empty URLSearchParams");
  } else {
    const V = params[0][1];
    const vn = V.replace(/[$]/g, "\\$&");
    if (!new RegExp(`${NOT_MEMBER}${vn}\\s*\\.\\s*append\\s*\\(\\s*["']Body["']\\s*,\\s*${Q.replace(/[$]/g, "\\$&")}\\s*\\)`).test(smsBody)) {
      v.push(`sendSMS must append the Body as ${V}.append("Body", ${Q}) with its own message parameter`);
    }
    const fetchBodies = smsBody.match(/\bbody\s*:\s*[^,}]+/g) ?? [];
    if (fetchBodies.length !== 1 || fetchBodies[0].replace(/\s+/g, "") !== `body:${V}.toString()`) {
      v.push(`sendSMS fetch must send exactly body: ${V}.toString(); found ${fetchBodies.join(" | ") || "none"}`);
    }
    if (new RegExp(`${NOT_MEMBER}${vn}\\s*\\.\\s*(?:set|delete|append)\\s*\\(`, "g").test(smsBody.replace(new RegExp(`${NOT_MEMBER}${vn}\\s*\\.\\s*append\\s*\\(\\s*["'](?:To|Body|MessagingServiceSid|From)["']`, "g"), ""))) {
      v.push(`sendSMS mutates ${V} outside the known To/Body/sender appends`);
    }
    v.push(...bodyHazards(smsBody.replace(params[0][0], ""), V, "sendSMS").filter((h) => !h.includes("nested function")));
  }
  return v;
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

// ---------------------------------------------------------------- whole-module checks (shared by the real run and the mutation fixtures)

export function bodyCheck(src: string): string[] {
  const calls = callArgs(src, "sendSMSToAll");
  const v: string[] = [];
  if (calls.length < 4) v.push(`expected at least 4 sendSMSToAll call sites, found ${calls.length}`);
  for (const args of calls) {
    if (args.length !== 2) { v.push(`sendSMSToAll must be called with exactly (phones, body): ${args.join(" , ")}`); continue; }
    v.push(...bodyViolations(src, args[1]).map((x) => `body ${args[1].slice(0, 40)}: ${x}`));
  }
  return v;
}

export function referenceCheck(src: string): string[] {
  const v: string[] = [];
  for (const name of ["sendSMS", "sendSMSToAll"]) {
    for (const r of nonCallReferences(src, name)) v.push(`${name} referenced other than by a direct call: ${r}`);
  }
  const n = callArgs(src, "sendSMS").length;
  if (n !== 1) v.push(`sendSMS( must have exactly one call site (inside sendSMSToAll), found ${n}`);
  return v;
}

export function transportCheck(mods: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [href, src] of mods) {
    let rest = src;
    if (href === indexUrl()) {
      const r = functionRange(src, "sendSMS");
      if (r === null) { violations.push("sendSMS helper not found in index.ts"); continue; }
      const inside = src.slice(r[0], r[1]);
      if (!(/api\.twilio\.com/.test(inside) && /Messages\.json/.test(inside))) violations.push("sendSMS no longer holds the Twilio endpoint; update this guard");
      rest = src.slice(0, r[0]) + src.slice(r[1]);
    }
    violations.push(...transportViolations(href.split("/").slice(-2).join("/"), rest));
  }
  return violations;
}

/** Everything the guard enforces, over a module map (index.ts keyed by indexUrl()). */
export function allViolations(mods: Map<string, string>): string[] {
  const src = mods.get(indexUrl())!;
  return [...bodyCheck(src), ...referenceCheck(src), ...sendPathViolations(src), ...transportCheck(mods)];
}

// ---------------------------------------------------------------- tests

Deno.test("gh-2884 process-dunning: every SMS body at every sendSMSToAll call site names the sender on EVERY branch", async () => {
  const src = (await loadModules()).get(indexUrl())!;
  assert(callArgs(src, "sendSMSToAll").length >= 4, "expected at least 4 sendSMSToAll call sites");
  assertEquals(bodyCheck(src), []);
});

Deno.test("gh-2884 process-dunning: sendSMS and sendSMSToAll are only ever directly called (no alias, destructure, or value use)", async () => {
  const src = (await loadModules()).get(indexUrl())!;
  assertEquals(referenceCheck(src), []);
});

Deno.test("gh-2884 process-dunning: the sendSMS helper is the only SMS transport in index.ts and every local module it imports", async () => {
  const mods = await loadModules();
  assert(mods.size >= 2, "expected index.ts plus at least one local import");
  assertEquals(transportCheck(mods), [], "a second SMS transport (or an un-allow-listed fetch) exists");
});

Deno.test("gh-2884 process-dunning: the body reaching Twilio is exactly sendSMSToAll's message parameter (B2 pin)", async () => {
  const src = (await loadModules()).get(indexUrl())!;
  assertEquals(sendPathViolations(src), []);
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

Deno.test("control: identifier hazards (B1) - duplicate, shadow, reassignment and missing declarations are refused", () => {
  const ok = 'const A = "Otter Quotes: a";\nsend(p, A);';
  assertEquals(bodyViolations(ok, "A"), []);
  assert(bodyViolations('const A = "Otter Quotes: a";\n{ const A = "bad"; }', "A").length > 0);
  assert(bodyViolations('const A = "Otter Quotes: a";\nlet A2 = 1; var A = "bad";', "A").length > 0);
  assert(bodyViolations('const A = "Otter Quotes: a";\nA = "bad";', "A").length > 0);
  assert(bodyViolations('let A = "Otter Quotes: a";\nA += "x";', "A").length > 0);
  assert(bodyViolations('const A = "Otter Quotes: a";\nconst f = (A) => A;', "A").length > 0);
  assert(bodyViolations('const A = "Otter Quotes: a";\nconst { A: B } = o; const [A] = z;', "A").length > 0);
  assert(bodyViolations("send(p, A);", "A").length > 0);
});

Deno.test("control: send path (B2) - minimal sendSMSToAll/sendSMS pair passes, each rewrite is refused", () => {
  const good = [
    "async function sendSMS(to: string, message: string): Promise<boolean> {",
    "  const body = new URLSearchParams();",
    '  body.append("To", to);',
    '  body.append("Body", message);',
    '  const r = await fetch("https://api.twilio.com/x/Messages.json", { method: "POST", body: body.toString() });',
    "  return r.ok;",
    "}",
    "async function sendSMSToAll(phones: string[], message: string): Promise<number> {",
    "  let count = 0;",
    "  for (const phone of phones) { const ok = await sendSMS(phone, message); if (ok) count++; }",
    "  return count;",
    "}",
  ].join("\n");
  assertEquals(sendPathViolations(good), []);
  const bad = (from: string, to: string) => {
    assert(good.includes(from), `fixture precondition: ${from}`);
    return sendPathViolations(good.replace(from, to));
  };
  assert(bad("sendSMS(phone, message)", 'sendSMS(phone, `Reminder: ${message.replace("Otter Quotes: ", "")}`)').length > 0);
  assert(bad("let count = 0;", 'let count = 0; message = message.slice(14);').length > 0);
  assert(bad("let count = 0;", 'let count = 0; { const message = "x"; }').length > 0);
  assert(bad('body.append("Body", message);', 'body.append("Body", message.slice(14));').length > 0);
  assert(bad('body.append("Body", message);', 'body.append("Body", message); body.set("Body", "hi");').length > 0);
  assert(bad("body: body.toString()", 'body: "Body=hi"').length > 0);
  assert(bad("  return r.ok;", "  message = 'x'; return r.ok;").length > 0);
});

// Mutations applied IN MEMORY to the real index.ts. Each must produce violations; the unmutated file must not.
async function realIndex(): Promise<{ mods: Map<string, string>; src: string }> {
  const mods = await loadModules();
  return { mods, src: mods.get(indexUrl())! };
}
function mutated(mods: Map<string, string>, src: string, edit: (s: string) => string): Map<string, string> {
  const out = edit(src);
  assert(out !== src, "mutation did not change index.ts - update the fixture");
  const m = new Map(mods);
  m.set(indexUrl(), out);
  return m;
}
const fixtures: Array<[string, (s: string) => string]> = [
  ["M0 prefix removed from HOURLY_SMS", (s) => s.replace(/(const\s+HOURLY_SMS\s*=\s*[`"'])Otter Quotes/, "$1Hello")],
  ["M1 extra direct fetch to Twilio Messages.json", (s) => s + '\nawait fetch("https://api.twilio.com/2010-04-01/Accounts/x/Messages.json", { method: "POST", body: "Body=hello" });\n'],
  ["M2 alias const go = sendSMSToAll", (s) => s + '\nconst go = sendSMSToAll; await go(["1"], "hello nobody");\n'],
  ["M3 brand only on a dead ternary branch", (s) => s + '\nawait sendSMSToAll(p, (cond ? "Otter Quotes" : "") + "You have a balance");\n'],
  ["B1 block-scoped duplicate const proceedSMS", (s) => s + '\n{ const proceedSMS = "Your card failed, pay now"; await sendSMSToAll(contacts.phones, proceedSMS); }\n'],
  ["B1b block-scoped duplicate const WARNING_SMS before the real one", (s) => '{ const WARNING_SMS = "bad"; }\n' + s],
  ["B1c reassignment of a body const via let shadow", (s) => s + '\n{ let lostSMS = "x"; lostSMS = "bad"; await sendSMSToAll(p, lostSMS); }\n'],
  ["B2a body rewritten between sendSMSToAll and sendSMS", (s) => s.replace(/sendSMS\(\s*e164\s*,\s*message\s*\)/, 'sendSMS(e164, `Reminder: ${message.replace("Otter Quotes: ", "")}`)')],
  ["B2b message reassigned before the sendSMS call", (s) => s.replace(/(const\s+ok\s*=\s*await\s+sendSMS\(\s*e164)/, 'message = message.replace("Otter Quotes: ", ""); $1')],
  ["B2c Body appended with a transformed message in sendSMS", (s) => s.replace('body.append("Body", message)', 'body.append("Body", message.replace("Otter Quotes: ", ""))')],
  ["B2d second Body key set after the append", (s) => s.replace('body.append("Body", message);', 'body.append("Body", message); body.set("Body", "hello");')],
  ["B2e fetch sends a different payload", (s) => s.replace(/(Messages\.json`,[\s\S]*?)body:\s*body\.toString\(\)/, '$1body: "To=" + to + "&Body=hello"')],
];

Deno.test("gh-2884 mutation fixtures: the unmutated real index.ts is clean", async () => {
  const { mods } = await realIndex();
  assertEquals(allViolations(mods), []);
});

for (const [name, edit] of fixtures) {
  Deno.test(`gh-2884 mutation fixture FAILS the guard: ${name}`, async () => {
    const { mods, src } = await realIndex();
    const v = allViolations(mutated(mods, src, edit));
    assert(v.length > 0, `mutation "${name}" slipped past the guard`);
  });
}
