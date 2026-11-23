// gh-3867 -- a contractor who is NOT the claim's selected contractor must not be able to create the
// contract envelope through `contractor_sign`.
//
// The EF calls serve() at the bottom and cannot be imported, so (as in gh3287-retired-envelopes.test.ts)
// the real serve() callback is extracted from index.ts as TEXT and run against fakes. The fakes stand in
// for Supabase and for the downstream handlers; handleContractorSign is the only place that creates a
// BoldSign document, so "creates nothing" is observed as: handleContractorSign never called, no
// envelope lookup, no rate-limit spend.
//
// Run the same file against the pre-fix index.ts (main) to see the negative control: (a) fails there.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function grabServeCallback(text: string): string {
  const start = text.indexOf("serve(async (req)=>{");
  if (start === -1) throw new Error("serve callback not found");
  const end = text.lastIndexOf("});");
  if (end === -1 || end < start) throw new Error("serve callback end not found");
  return text.slice(start, end + 3).replace("serve(async (req)=>{", "export const handler = (async (req)=>{").replace(/\}\);$/, "});");
}

interface World {
  mints: number;
  envelopeLookups: number;
  rateLimitSpends: number;
  claimsReads: number;
  selected: string | null;
}

function load(w: World) {
  const mod = [
    "// @ts-nocheck",
    `const FN_NAME = "create-docusign-envelope";`,
    `const CURRENT_TEMPLATE_MANIFEST_VERSION = 1;`,
    `class TemplateNotUsableError extends Error {}`,
    `class LabeledSignTagError extends Error {}`,
    `class RedactionUnavailableError extends Error {}`,
    `class DocumentTooLargeError extends Error {}`,
    `const Deno = { env: { get: (k) => (k === "BOLDSIGN_API" ? "test-key" : undefined) } };`,
    `function buildCorsHeaders() { return {}; }`,
    `function getServiceRoleKey() { return "k"; }`,
    `function retiredEnvelopeRefusal() { return null; }`,
    `function resolveOperation(t, id) { return id ? "resume" : "mint"; }`,
    `function rateLimitKeyFor(op) { return "rk-" + op; }`,
    `async function findExistingEnvelopeId() { globalThis.__w.envelopeLookups++; return null; }`,
    `async function handleContractorSign() { globalThis.__w.mints++; return new Response(JSON.stringify({ envelope_id: "env-1" }), { status: 200 }); }`,
    `async function handleHomeownerSign() { return new Response("{}", { status: 200 }); }`,
    `async function handleLegacyFlow() { return new Response("{}", { status: 200 }); }`,
    `function createClient() { return globalThis.__fakeSupabase; }`,
    grabServeCallback(src),
  ].join("\n\n");
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__w = w;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__fakeSupabase = fakeSupabase(w);
  const url = "data:application/typescript;base64," + btoa(unescape(encodeURIComponent(mod)));
  return import(url + "#" + Math.random());
}

// Two contractors quote on the same claim; ctr-sel owns user-sel, ctr-other owns user-other.
function fakeSupabase(w: World) {
  const contractors: Record<string, { id: string; email: string; company_name: string; user_id: string }> = {
    "ctr-sel": { id: "ctr-sel", email: "sel@example-roofing.test", company_name: "Selected Roofing", user_id: "user-sel" },
    "ctr-other": { id: "ctr-other", email: "other@example-roofing.test", company_name: "Other Roofing", user_id: "user-other" },
  };
  return {
    auth: { getUser: (jwt: string) => Promise.resolve({ data: { user: { id: jwt, email: `${jwt}@x.test` } }, error: null }) },
    rpc: () => { w.rateLimitSpends++; return Promise.resolve({ data: { allowed: true }, error: null }); },
    from(table: string) {
      const f: Record<string, unknown> = {};
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => { f[c] = v; return chain; },
        maybeSingle: () => {
          if (table === "contractors") {
            const row = contractors[f.id as string];
            return Promise.resolve({ data: row && row.user_id === f.user_id ? row : null, error: null });
          }
          if (table === "claims") {
            w.claimsReads++;
            return Promise.resolve({ data: { selected_contractor_id: w.selected, user_id: "user-homeowner" }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        single: () => chain.maybeSingle(),
      };
      return chain;
    },
  };
}

function call(mod: { handler: (r: Request) => Promise<Response> }, asUser: string, contractorId: string) {
  return mod.handler(new Request("https://fn.test/", {
    method: "POST",
    headers: { Authorization: `Bearer ${asUser}`, "Content-Type": "application/json" },
    body: JSON.stringify({ claim_id: "claim-1", document_type: "contractor_sign", contractor_id: contractorId, quote_id: "q-1" }),
  }));
}

Deno.test("(a) contractor_sign by a NON-selected contractor is refused 403 and creates nothing", async () => {
  const w: World = { mints: 0, envelopeLookups: 0, rateLimitSpends: 0, claimsReads: 0, selected: "ctr-sel" };
  const mod = await load(w);
  const res = await call(mod, "user-other", "ctr-other");
  assertEquals(res.status, 403);
  assertEquals(w.mints, 0, "no envelope created");
  assertEquals(w.envelopeLookups, 0, "no envelope lookup");
  assertEquals(w.rateLimitSpends, 0, "no rate-limit spend");
});

Deno.test("(a2) contractor_sign when the claim has no selected contractor is refused 403 and creates nothing", async () => {
  const w: World = { mints: 0, envelopeLookups: 0, rateLimitSpends: 0, claimsReads: 0, selected: null };
  const mod = await load(w);
  const res = await call(mod, "user-other", "ctr-other");
  assertEquals(res.status, 403);
  assertEquals(w.mints, 0);
});

Deno.test("(b) contractor_sign by the SELECTED contractor still proceeds", async () => {
  const w: World = { mints: 0, envelopeLookups: 0, rateLimitSpends: 0, claimsReads: 0, selected: "ctr-sel" };
  const mod = await load(w);
  const res = await call(mod, "user-sel", "ctr-sel");
  assertEquals(res.status, 200);
  assertEquals(w.mints, 1, "selected contractor's envelope is created");
  assertEquals(w.rateLimitSpends, 1);
});

Deno.test("(c) a caller who does not own the contractor_id is still refused 403 (existing check unchanged)", async () => {
  const w: World = { mints: 0, envelopeLookups: 0, rateLimitSpends: 0, claimsReads: 0, selected: "ctr-sel" };
  const mod = await load(w);
  const res = await call(mod, "user-other", "ctr-sel");
  assertEquals(res.status, 403);
  assertEquals(w.mints, 0);
});
