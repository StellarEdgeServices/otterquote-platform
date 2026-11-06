// gh-1916 / D-328 / R-134, rewritten by D-391 / #2875 layer 4: static inventory + gate guard for every server-side
// SMS send site in supabase/functions.
//
// Run: deno test --allow-read=supabase/functions supabase/functions/send-sms/contractor-sms-send-sites.test.ts
//
// WHY THIS EXISTS. The set of files that can put an SMS on the wire is a closed, classified list. A new
// `functions/v1/send-sms` call or a new Twilio Messages POST anywhere else fails here until someone classifies it
// (contractor, admin-alert, or relay). Every file classed "contractor" must:
//   1. keep the TCR release gate (_shared/contractor-sms-release.ts) in front of each send (D-391 / #2875 PR 3124);
//   2. get its recipients ONLY from the verified-number list: it calls resolveContractorTextableNumbers() (_shared/
//      contractor-textable.ts, a wrapper over contractor_textable_numbers()) and contains NO other phone source in code
//      (notification_phones, contractors.phone, profiles.phone, sms_opt_in, sms_consent_text_version). D-391 replaced the
//      sms_opt_in gate: the unit of consent is the one-time-code-verified number.
// It is a static (source) guard, not a behavioural one: the behavioural proofs are _shared/contractor-textable.test.ts,
// send-contractor-nudge/consent-gate.test.ts and process-dunning/sms-runtime-bodies.test.ts. NEGATIVE CONTROLS at the
// bottom feed the checker a send site with no lookup / a legacy phone source and expect a violation.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

type Kind = "contractor" | "admin-alert" | "relay";
// order: "gate-before-send" = every send in the file is preceded by a gate that sits after the
// previous send; "upstream" = the gate is in the function that builds the recipient list, so it
// must come before the first call of `callers` (process-dunning's Twilio helper is defined above
// the gate, so a textual send-before-gate comparison does not apply there).
interface Site { kind: Kind; sites: number; minGates: number; minLookups?: number; noLegacy?: boolean; order?: "gate-before-send" | "upstream"; callers?: RegExp }

// path (relative to supabase/functions) -> classification
export const SEND_SITES: Record<string, Site> = {
  // helper release gate (sendSmsViaEdgeFunction) + the inlined release gate in the new-opportunity loop; recipients via verifiedSmsPhones()
  "notify-contractors/index.ts": { kind: "contractor", sites: 2, minGates: 2, minLookups: 1, order: "gate-before-send" },
  // one release gate + one lookup in the contact builder; every sendSMSToAll() call comes after it in the file
  "process-dunning/index.ts": { kind: "contractor", sites: 1, minGates: 1, minLookups: 1, order: "upstream", callers: /(?<!function\s)\bsendSMSToAll\s*\(/ },
  // attemptContractorSms (release gate before the send) and resolveNudgeRecipients (the lookup) live here.
  "send-contractor-nudge/consent-gate.ts": { kind: "contractor", sites: 1, minGates: 1, minLookups: 1, order: "gate-before-send" },
  // Alert to the owner's own number, not a contractor send (see the comment above it in index.ts). It builds the
  // contractor recipient list, so it must not read a legacy phone source either.
  "send-contractor-nudge/index.ts": { kind: "admin-alert", sites: 1, minGates: 0, noLegacy: true },
  // The Twilio relay itself; its callers are the sites above.
  "send-sms/index.ts": { kind: "relay", sites: 1, minGates: 0 },
};

const SEND_RE = /functions\/v1\/send-sms|api\.twilio\.com\/2010-04-01\/Accounts\/\$\{[^}]+\}\/Messages\.json(?!\?)/g;
// D-391 / #2875 layer 4: the lookup of the verified-number list, and every legacy phone / consent source that must no
// longer feed a contractor SMS. Matched against code (comments blanked) so a doc comment may still name them.
const LOOKUP_RE = /\bresolveContractorTextableNumbers\s*\(/g;
const LEGACY_RE = /\bnotification_phones\b|\bsms_opt_in\b|\bsms_consent_text_version\b|\bcontractor\??\.phone\b|\bprofile\??\.phone\b|\.select\(\s*[`"'][^`"']*\bphone\b/g;
// Every contractor send site needs the TCR release gate (_shared/contractor-sms-release.ts), a
// negated `.allowed` check that refuses. The import line, doc comments and strings do not count (scan() blanks them).
const RELEASE_RE = /!\s*contractorSmsReleaseGate\s*\(/g;
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
/** Index just past the `)` that closes the call whose `(` ends the match at `from` (object-literal args contain `{`). */
function afterCallArgs(code: string, from: number): number {
  let depth = 1;
  for (let k = from; k < code.length; k++) {
    if (code[k] === "(") depth++;
    else if (code[k] === ")" && --depth === 0) return k + 1;
  }
  return from;
}
/** Returns violation strings for one file given its classification (empty = ok). */
export function checkFile(path: string, src: string, c: Site): string[] {
  const v: string[] = [];
  const sites = countSendSites(src);
  if (sites !== c.sites) v.push(`${path}: ${sites} send sites, expected ${c.sites} (classify the new one)`);
  if (c.kind !== "contractor" && !c.noLegacy) return v;

  const sc = scan(src);
  if (!sc.ok) { v.push(`${path}: comment/string scanner lost sync (cannot trust the check)`); return v; }
  // D-391 / #2875 layer 4: no legacy phone / consent source anywhere in the code of a contractor sender.
  for (const m of sc.code.matchAll(LEGACY_RE)) {
    v.push(`${path}: legacy phone/consent source \`${m[0].trim()}\` at offset ${m.index} (contractor SMS may read only contractor_textable_numbers())`);
  }
  if (c.kind !== "contractor") return v;

  const lookups = [...sc.code.matchAll(LOOKUP_RE)].filter((m) => !sc.inStr[m.index!]);
  if (lookups.length < (c.minLookups ?? 1)) {
    v.push(`${path}: ${lookups.length} resolveContractorTextableNumbers calls for ${sites} contractor send sites (need >= ${c.minLookups ?? 1})`);
  }
  // TCR release gate (PR 3124): each gate must refuse, and one must sit before each send.
  const releases = [...sc.code.matchAll(RELEASE_RE)].filter((m) => !sc.inStr[m.index!]).map((m) => m.index!);
  if (releases.length < c.minGates) {
    v.push(`${path}: ${releases.length} contractorSmsReleaseGate gates for ${sites} contractor send sites (need >= ${c.minGates})`);
  }
  for (const g of releases) {
    const m = sc.code.slice(g).match(RELEASE_RE)![0];
    if (!REFUSAL_RE.test(gateBlock(sc.code, afterCallArgs(sc.code, g + m.length)))) {
      v.push(`${path}: contractorSmsReleaseGate at offset ${g} does not refuse (no return/continue/throw in its block)`);
    }
  }
  if (c.order === "gate-before-send") {
    let prevR = -1;
    for (const s of [...sc.code.matchAll(SEND_RE)].map((m) => m.index!)) {
      if (!releases.some((g) => g > prevR && g < s)) {
        v.push(`${path}: send at offset ${s} has no contractorSmsReleaseGate before it (a gate after the send does not count)`);
      }
      prevR = s;
    }
  } else if (c.order === "upstream") {
    const firstCall = sc.code.search(c.callers!);
    if (firstCall === -1) v.push(`${path}: no caller of the send helper found (callers pattern is stale)`);
    else {
      if (!releases.length || Math.min(...releases) > firstCall) {
        v.push(`${path}: the first contractorSmsReleaseGate sits after the first send-helper call (offset ${firstCall})`);
      }
      if (!lookups.length || Math.min(...lookups.map((m) => m.index!)) > firstCall) {
        v.push(`${path}: the first resolveContractorTextableNumbers call sits after the first send-helper call (offset ${firstCall})`);
      }
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

Deno.test("each classified contractor send site reads only the verified list and keeps the release gate", async () => {
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
const RELEASE = `if (!contractorSmsReleaseGate(contractor, { site: "x" }).allowed) ${REFUSE}`;
const LOOKUP = `const r = await resolveContractorTextableNumbers(sb, contractor.id, { site: "x" });`;
const GATED = `async function go(contractor) {\n  ${RELEASE}\n  ${LOOKUP}\n  ${SEND}\n}`;
const ORDERED: Site = { kind: "contractor", sites: 1, minGates: 1, minLookups: 1, order: "gate-before-send" };

Deno.test("positive control: the verified-list shape passes", () => {
  assertEquals(checkFile("x.ts", GATED, ORDERED), []);
});
Deno.test("negative control: a contractor send that never calls the verified-list lookup is flagged", () => {
  const v = checkFile("x.ts", `async function go(contractor) {\n  ${RELEASE}\n  ${SEND}\n}`, ORDERED);
  assert(v.some((s) => s.includes("0 resolveContractorTextableNumbers calls")), JSON.stringify(v));
});
Deno.test("negative control: every legacy phone / consent source is flagged in a contractor sender", () => {
  for (const legacy of [
    "const p = contractor.notification_phones;",
    "const p = contractor.phone;",
    "if (contractor.sms_opt_in === true) {}",
    "const p = profile?.phone;",
    "const v = c.sms_consent_text_version;",
    'sb.from("contractors").select("id, phone, is_test");',
  ]) {
    const v = checkFile("x.ts", GATED.replace("  " + SEND, `  ${legacy}\n  ${SEND}`), ORDERED);
    assert(v.some((s) => s.includes("legacy phone/consent source")), `${legacy}: ${JSON.stringify(v)}`);
  }
});
Deno.test("negative control: a legacy source named only in a comment is NOT flagged", () => {
  const commented = GATED.replace("  " + SEND, `  // contractor.notification_phones and sms_opt_in were removed\n  ${SEND}`);
  assertEquals(checkFile("x.ts", commented, ORDERED), []);
});
Deno.test("negative control: the lookup named only in a comment or a string is flagged", () => {
  const src = `async function go(contractor) {\n  ${RELEASE}\n  // await resolveContractorTextableNumbers(sb, id, o);\n  const d = "resolveContractorTextableNumbers(";\n  ${SEND}\n}`;
  assert(checkFile("x.ts", src, ORDERED).some((s) => s.includes("0 resolveContractorTextableNumbers calls")));
});
Deno.test("negative control: an unclassified extra send site is flagged", () => {
  const v = checkFile("x.ts", GATED + GATED, ORDERED);
  assert(v.some((s) => s.includes("2 send sites, expected 1")));
});
Deno.test("negative control: upstream mode flags a lookup or release gate after the first helper call", () => {
  const up: Site = { kind: "contractor", sites: 1, minGates: 1, minLookups: 1, order: "upstream", callers: /(?<!function\s)\bsendSMSToAll\s*\(/ };
  const good = `async function sendSMSToAll(p) { ${SEND} }\nasync function contacts(c) { ${RELEASE} ${LOOKUP} }\nawait sendSMSToAll(x);`;
  const late = `async function sendSMSToAll(p) { ${SEND} }\nawait sendSMSToAll(x);\nasync function contacts(c) { ${RELEASE} ${LOOKUP} }`;
  assertEquals(checkFile("x.ts", good, up), []);
  assert(checkFile("x.ts", late, up).some((s) => s.includes("sits after the first send-helper call")));
});
Deno.test("scanner: handles // inside strings, nested template expressions and comment text", () => {
  const src = "const u = `https://a.b/${x ? `y` : \"z\"}`; // sms_opt_in\nconst q = 'it\\'s'; /* notification_phones */";
  const sc = scan(src);
  assert(sc.ok);
  assert(sc.code.includes("https://a.b/"));
  assertEquals([...sc.code.matchAll(LEGACY_RE)].length, 0);
});

// ── The same checks against the REAL files (mutated in memory, never written) ──
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
Deno.test("real files (mutation): reverting the recipient source to a legacy phone column fails in every contractor sender", async () => {
  const cases: Array<[string, string | RegExp, string]> = [
    ["notify-contractors/index.ts", /\.select\("id, user_id, email, contact_name, company_name, notification_emails, notification_preferences, is_test"\)/, '.select("id, user_id, email, phone, notification_phones, sms_opt_in, is_test")'],
    ["process-dunning/index.ts", /\.select\("email"\)/, '.select("email, phone")'],
    ["process-dunning/index.ts", "phones = (await resolveContractorTextableNumbers(", "phones = contractor.notification_phones ?? []; void (await resolveContractorTextableNumbers("],
    ["send-contractor-nudge/index.ts", /\.select\("company_name, is_test"\)/, '.select("company_name, phone, notification_phones, sms_opt_in, is_test")'],
  ];
  for (const [p, from, to] of cases) {
    const v = checkFile(p, mutate(await real(p), from, to), SEND_SITES[p]);
    assert(v.some((s) => s.includes("legacy phone/consent source")), `${p}: reverting to a legacy source was not caught: ${JSON.stringify(v)}`);
  }
});
Deno.test("real files (mutation): removing the lookup from each contractor sender fails", async () => {
  for (const p of ["notify-contractors/index.ts", "process-dunning/index.ts", "send-contractor-nudge/consent-gate.ts"]) {
    const src = (await real(p)).replaceAll("resolveContractorTextableNumbers(", "resolveNothing(");
    assert(checkFile(p, src, SEND_SITES[p]).some((s) => s.includes("resolveContractorTextableNumbers calls")), `${p}: removing the lookup was not caught`);
  }
});

// ── D-391 / #2875: the TCR release gate must sit on every contractor send site too ──
Deno.test("negative control: a contractor send with the lookup but NO TCR release gate is flagged", () => {
  const v = checkFile("x.ts", `async function go(contractor) {\n  ${LOOKUP}\n  ${SEND}\n}`, ORDERED);
  assert(v.some((s) => s.includes("contractorSmsReleaseGate gates")), JSON.stringify(v));
  assert(v.some((s) => s.includes("no contractorSmsReleaseGate before it")), JSON.stringify(v));
});
Deno.test("negative control: a TCR release gate that sits AFTER the send is flagged", () => {
  const src = `async function go(contractor) {\n  ${LOOKUP}\n  ${SEND}\n  ${RELEASE}\n}`;
  assert(checkFile("x.ts", src, ORDERED).some((s) => s.includes("no contractorSmsReleaseGate before it")));
});
Deno.test("negative control: a TCR release gate named only in a comment or string is flagged", () => {
  const src = `import { contractorSmsReleaseGate } from "x";\nasync function go(contractor) {\n  ${LOOKUP}\n  // if (!contractorSmsReleaseGate(contractor, {}).allowed) return false;\n  const d = "if (!contractorSmsReleaseGate(c, {}).allowed) return";\n  ${SEND}\n}`;
  assert(checkFile("x.ts", src, ORDERED).some((s) => s.includes("0 contractorSmsReleaseGate gates")));
});
Deno.test("negative control: a TCR release gate whose block does not refuse is flagged", () => {
  const src = `async function go(contractor) {\n  ${LOOKUP}\n  if (!contractorSmsReleaseGate(contractor, {}).allowed) { console.warn("noted"); }\n  ${SEND}\n}`;
  assert(checkFile("x.ts", src, ORDERED).some((s) => s.includes("contractorSmsReleaseGate at offset") && s.includes("does not refuse")));
});
Deno.test("real files: removing the TCR release gate from each contractor send site fails", async () => {
  const cases: Array<[string, string | RegExp]> = [
    ["send-contractor-nudge/consent-gate.ts", /!contractorSmsReleaseGate\(/g], // two gates here (recipient lookup + the send): drop both
    ["notify-contractors/index.ts", /!contractorSmsReleaseGate\(\s*\{ id: contractorId/],
    ["process-dunning/index.ts", "!contractorSmsReleaseGate("],
  ];
  for (const [p, from] of cases) {
    const src = mutate(await real(p), from, "false && contractorSmsReleaseGate(");
    assert(checkFile(p, src, SEND_SITES[p]).length > 0, `${p}: removing the release gate was not caught`);
  }
  // notify-contractors has TWO send sites: dropping only the inline loop gate must also fail.
  const nc = mutate(await real("notify-contractors/index.ts"), /!contractorSmsReleaseGate\(contractor, /, "false && contractorSmsReleaseGate(contractor, ");
  assert(checkFile("notify-contractors/index.ts", nc, SEND_SITES["notify-contractors/index.ts"]).length > 0);
});
Deno.test("real files: the nudge's Dustin alert stays an ungated admin-alert (internal, not a contractor send)", () => {
  assertEquals(SEND_SITES["send-contractor-nudge/index.ts"].kind, "admin-alert");
});
