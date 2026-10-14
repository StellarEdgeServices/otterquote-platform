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
interface Site { kind: Kind; sites: number; minGates: number }

// path (relative to supabase/functions) -> classification
export const SEND_SITES: Record<string, Site> = {
  "notify-contractors/index.ts": { kind: "contractor", sites: 2, minGates: 2 },
  "process-dunning/index.ts": { kind: "contractor", sites: 1, minGates: 1 },
  "send-contractor-nudge/consent-gate.ts": { kind: "contractor", sites: 1, minGates: 1 },
  // Alert to the owner's own number, not a contractor send (see the comment above it in index.ts).
  "send-contractor-nudge/index.ts": { kind: "admin-alert", sites: 1, minGates: 0 },
  // The Twilio relay itself; its callers are the sites above.
  "send-sms/index.ts": { kind: "relay", sites: 1, minGates: 0 },
};

const SEND_RE = /functions\/v1\/send-sms|api\.twilio\.com\/2010-04-01\/Accounts\/\$\{[^}]+\}\/Messages\.json(?!\?)/g;
const GATE_RE = /(?:sms_?opt_?in)\s*!==\s*true|isSmsConsented\s*\(/gi;

export function countSendSites(src: string): number {
  return (src.match(SEND_RE) ?? []).length;
}
export function countGates(src: string): number {
  return (src.match(GATE_RE) ?? []).length;
}
/** Returns violation strings for one file given its classification (empty = ok). */
export function checkFile(path: string, src: string, c: Site): string[] {
  const v: string[] = [];
  const sites = countSendSites(src);
  const gates = countGates(src);
  if (sites !== c.sites) v.push(`${path}: ${sites} send sites, expected ${c.sites} (classify the new one)`);
  if (c.kind === "contractor" && gates < c.minGates) {
    v.push(`${path}: ${gates} sms_opt_in gates for ${sites} contractor send sites (need >= ${c.minGates})`);
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

// ── Negative controls: the checker must FAIL on an ungated contractor send ──
const UNGATED = `
async function go(contractor) {
  await fetch(\`\${url}/functions/v1/send-sms\`, { method: "POST", body: "x" });
}`;
const GATED = `
async function go(contractor) {
  if (contractor.sms_opt_in !== true) return false;
  await fetch(\`\${url}/functions/v1/send-sms\`, { method: "POST", body: "x" });
}`;

Deno.test("negative control: a contractor send with no sms_opt_in gate is flagged", () => {
  const v = checkFile("x.ts", UNGATED, { kind: "contractor", sites: 1, minGates: 1 });
  assertEquals(v.length, 1);
  assert(v[0].includes("0 sms_opt_in gates"));
});
Deno.test("positive control: the gated shape passes", () => {
  assertEquals(checkFile("x.ts", GATED, { kind: "contractor", sites: 1, minGates: 1 }), []);
});
Deno.test("negative control: an unclassified extra send site is flagged", () => {
  const v = checkFile("x.ts", GATED + GATED, { kind: "contractor", sites: 1, minGates: 1 });
  assert(v.some((s) => s.includes("2 send sites, expected 1")));
});
