// gh-3867 (second PR) -- two more ways a caller could create or redirect a contract envelope.
//
// (a) The legacy `contract` action (handleLegacyFlow) only checked that the caller owns the claim and
//     never checked the contractor against the claim's selected contractor. Nothing in the repo sends
//     document_type "contract", so it is refused like a retired action: 410, before any claim lookup,
//     rate-limit spend or BoldSign call. contractor_sign / homeowner_sign are unaffected.
// (b) Where the envelope is recorded, the quote pointer was written by the request's quote_id alone. A
//     quote_id that does not belong to this claim AND this contractor must not be written.
//
// The EF calls serve() at the bottom and cannot be imported, so (as in gh3287-retired-envelopes.test.ts)
// the real code is extracted from index.ts as TEXT and run against fakes: the serve() callback for (a),
// and the quoteUpdateFilter statement for (b). Run against unfixed main, both (a) and (b) fail.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// ---------- (a) serve(): document_type "contract" ----------
function grabServeCallback(text: string): string {
  const start = text.indexOf("serve(async (req)=>{");
  if (start === -1) throw new Error("serve callback not found");
  const end = text.lastIndexOf("});");
  return text.slice(start, end + 3).replace("serve(async (req)=>{", "export const handler = (async (req)=>{").replace(/\}\);$/, "});");
}

interface World {
  legacyCalls: number;
  rateLimitSpends: number;
  claimsReads: number;
  contractorSignCalls: number;
  homeownerSignCalls: number;
}
const newWorld = (): World => ({ legacyCalls: 0, rateLimitSpends: 0, claimsReads: 0, contractorSignCalls: 0, homeownerSignCalls: 0 });

// deno-lint-ignore no-explicit-any
function fakeSupabase(w: World): any {
  return {
    auth: { getUser: (jwt: string) => Promise.resolve({ data: { user: { id: jwt, email: `${jwt}@x.test` } }, error: null }) },
    rpc: () => { w.rateLimitSpends++; return Promise.resolve({ data: { allowed: true }, error: null }); },
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const f: Record<string, any> = {};
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => { f[c] = v; return chain; },
        maybeSingle: () => {
          if (table === "contractors") return Promise.resolve({ data: { id: "ctr-sel", email: "sel@example-roofing.test", company_name: "Selected Roofing", user_id: "user-sel" }, error: null });
          if (table === "claims") { w.claimsReads++; return Promise.resolve({ data: { selected_contractor_id: "ctr-sel", user_id: "user-homeowner" }, error: null }); }
          return Promise.resolve({ data: null, error: null });
        },
        single: () => chain.maybeSingle(),
      };
      return chain;
    },
  };
}

function loadServe(w: World) {
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
    // The real colorRefusal, so the 410 shape is the production one.
    src.slice(src.indexOf("function colorRefusal("), src.indexOf("\n}\n", src.indexOf("function colorRefusal(")) + 3),
    `function resolveOperation(t, id) { return id ? "resume" : "mint"; }`,
    `function rateLimitKeyFor(op) { return "rk-" + op; }`,
    `async function findExistingEnvelopeId() { return null; }`,
    `async function handleContractorSign() { globalThis.__w.contractorSignCalls++; return new Response("{}", { status: 200 }); }`,
    `async function handleHomeownerSign() { globalThis.__w.homeownerSignCalls++; return new Response("{}", { status: 200 }); }`,
    `async function handleLegacyFlow() { globalThis.__w.legacyCalls++; return new Response("{}", { status: 200 }); }`,
    `function createClient() { return globalThis.__fakeSupabase; }`,
    grabServeCallback(src),
  ].join("\n\n");
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__w = w;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__fakeSupabase = fakeSupabase(w);
  return import("data:application/typescript;base64," + btoa(unescape(encodeURIComponent(mod))) + "#" + Math.random());
}

function call(mod: { handler: (r: Request) => Promise<Response> }, asUser: string, documentType: string) {
  return mod.handler(new Request("https://fn.test/", {
    method: "POST",
    headers: { Authorization: `Bearer ${asUser}`, "Content-Type": "application/json" },
    body: JSON.stringify({ claim_id: "claim-1", document_type: documentType, contractor_id: "ctr-sel", quote_id: "q-1" }),
  }));
}

Deno.test("(a) document_type 'contract' from the claim owner is refused 410 and creates nothing", async () => {
  const w = newWorld();
  const res = await call(await loadServe(w), "user-homeowner", "contract");
  assertEquals(res.status, 410);
  assertEquals((await res.json()).error, "contract_envelope_retired");
  assertEquals(w.legacyCalls, 0, "handleLegacyFlow (the only 'contract' mint path) not reached");
  assertEquals(w.rateLimitSpends, 0, "no rate-limit spend");
  assertEquals(w.claimsReads, 0, "no claim read");
});

Deno.test("(a2) contractor_sign by the selected contractor and homeowner_sign by the owner are unaffected", async () => {
  const w = newWorld();
  const mod = await loadServe(w);
  assertEquals((await call(mod, "user-sel", "contractor_sign")).status, 200);
  assertEquals((await call(mod, "user-homeowner", "homeowner_sign")).status, 200);
  assertEquals(w.contractorSignCalls, 1);
  assertEquals(w.homeownerSignCalls, 1);
});

// ---------- (b) quote pointer write ----------
function grabQuotePointerStatement(text: string): string {
  const start = text.indexOf("const quoteUpdateFilter = quote_id ?");
  if (start === -1) throw new Error("quoteUpdateFilter statement not found");
  const end = text.indexOf("const { error: quoteUpdateError", start);
  if (end === -1) throw new Error("quoteUpdateError line not found");
  return text.slice(start, end);
}

interface QuoteRow { id: string; claim_id: string; contractor_id: string; docusign_envelope_id: string | null }

// deno-lint-ignore no-explicit-any
function fakeQuotes(rows: QuoteRow[]): any {
  return {
    from() {
      // deno-lint-ignore no-explicit-any
      const filters: Array<[string, any]> = [];
      let patch: Partial<QuoteRow> | null = null;
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        update: (p: Partial<QuoteRow>) => { patch = p; return chain; },
        // deno-lint-ignore no-explicit-any
        eq: (c: string, v: any) => { filters.push([c, v]); return chain; },
        select: () => chain,
        // deno-lint-ignore no-explicit-any
        then: (resolve: (v: any) => void) => {
          const hit = rows.filter((r) => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v));
          for (const r of hit) Object.assign(r, patch);
          return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
        },
      };
      return chain;
    },
  };
}

async function writePointer(rows: QuoteRow[], quoteId: string, claimId: string, contractorId: string) {
  const mod = [
    "// @ts-nocheck",
    `export async function run(supabase, quote_id, claim_id, contractor_id, envelopeId) {`,
    grabQuotePointerStatement(src),
    `  return await quoteUpdateFilter;`,
    `}`,
  ].join("\n");
  const m = await import("data:application/typescript;base64," + btoa(unescape(encodeURIComponent(mod))) + "#" + Math.random());
  return await m.run(fakeQuotes(rows), quoteId, claimId, contractorId, "env-new");
}

const quotes = (): QuoteRow[] => [
  { id: "q-A", claim_id: "claim-A", contractor_id: "ctr-1", docusign_envelope_id: null },
  { id: "q-B", claim_id: "claim-B", contractor_id: "ctr-1", docusign_envelope_id: null },
];

Deno.test("(b) a quote_id from ANOTHER claim is not written (selected on claim B, quote from claim A)", async () => {
  const rows = quotes();
  const res = await writePointer(rows, "q-A", "claim-B", "ctr-1");
  assertEquals(res.data.length, 0, "zero rows written");
  assertEquals(rows[0].docusign_envelope_id, null, "claim A's quote pointer untouched");
});

Deno.test("(b2) a quote_id that belongs to a different contractor is not written", async () => {
  const rows = quotes();
  const res = await writePointer(rows, "q-B", "claim-B", "ctr-2");
  assertEquals(res.data.length, 0);
  assertEquals(rows[1].docusign_envelope_id, null);
});

Deno.test("(b3) the contractor's own quote on this claim is still written", async () => {
  const rows = quotes();
  const res = await writePointer(rows, "q-B", "claim-B", "ctr-1");
  assertEquals(res.data.length, 1);
  assertEquals(rows[1].docusign_envelope_id, "env-new");
  assertEquals(rows[0].docusign_envelope_id, null);
});
