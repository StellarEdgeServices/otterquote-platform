// gh-3287 (D-407 6/8) -- Project Confirmation and colour envelopes are retired.
//
// A request for a `color_confirmation` or `project_confirmation` envelope must answer 410 and create
// nothing: no claim read, no slot claim, no template read, no rate-limit spend, no BoldSign call.
// Contract envelopes (contract / contractor_sign / homeowner_sign) are NOT touched.
//
// Replaces gh2105-colour-signature.test.ts, whose 21 behaviour tests all exercised the colour MINT path
// that D-407 removes (they passed on main only because main still minted).
//
// The EF calls serve() at the bottom and cannot be imported, so (as in rate-limit-split.test.ts) the real
// functions are extracted from index.ts as TEXT and run against fakes. Every guarantee also runs against a
// copy of the source with the guard removed and must FAIL there (negative controls).
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const guardSrc = await Deno.readTextFile(new URL("../_shared/zero-row-update-guard.ts", import.meta.url));

function grabFrom(text: string, name: string, isAsync = false): string {
  const decl = `${isAsync ? "async " : ""}function ${name}(`;
  const start = text.indexOf(decl);
  if (start === -1) throw new Error(`not found: ${decl}`);
  let paren = 0;
  let bodyOpen = -1;
  for (let j = start + decl.length - 1; j < text.length; j++) {
    if (text[j] === "(") paren++;
    else if (text[j] === ")") {
      paren--;
      if (paren === 0) { bodyOpen = text.indexOf("{", j); break; }
    }
  }
  let depth = 0;
  for (let j = bodyOpen; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (depth === 0) return text.slice(start, j + 1); }
  }
  throw new Error(`unbalanced: ${name}`);
}
function grabConst(text: string, name: string): string {
  const m = text.match(new RegExp(`^const ${name} = .*$`, "m"));
  if (!m) throw new Error(`not found: const ${name}`);
  return m[0];
}
function grabBlockConst(text: string, name: string): string {
  const start = text.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`not found: const ${name}`);
  return text.slice(start, text.indexOf("};", start) + 2);
}

interface World {
  row: { id: string; color_confirmation_envelope_id: string | null; selected_contractor_id: string | null };
  sends: number;
  signLinks: number;
  fromCalls: string[];
  templateReads: string[];
}
function newWorld(): World {
  return { row: { id: "claim-1", color_confirmation_envelope_id: null, selected_contractor_id: "ctr-1" }, sends: 0, signLinks: 0, fromCalls: [], templateReads: [] };
}

// Records every table touched. Mirrors the PostgREST chain shape the colour mint path used.
function fakeSupabase(w: World) {
  function from(table: string) {
    w.fromCalls.push(table);
    if (table === "platform_alerts_log") return { insert: () => Promise.resolve({ error: null }) };
    if (table === "contractors") {
      const c: Record<string, unknown> = { select: () => c, eq: () => c, maybeSingle: () => Promise.resolve({ data: { color_confirmation_template: { "roofing/retail": { file_url: "ctr-1/pc_roofing_retail_1.pdf" } } }, error: null }) };
      return c;
    }
    const filters: Array<[string, string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    const match = () => filters.every(([op, col, val]) => {
      const cur = (w.row as Record<string, unknown>)[col] ?? null;
      return op === "is" ? cur === null : cur === val;
    });
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: Record<string, unknown>) => { patch = p; return chain; },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return chain; },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return chain; },
      maybeSingle: () => Promise.resolve({ data: { ...w.row, trades: ["roofing"], funding_type: "retail" }, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch && match()) { Object.assign(w.row, patch); return resolve({ data: [{ id: w.row.id }], error: null }); }
        return resolve({ data: [], error: null });
      },
    };
    return chain;
  }
  return { from };
}

function installFetch(w: World) {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    const u = String(url);
    if (u.includes("/v1/document/send")) {
      w.sends++;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({ documentId: `doc-${w.sends}` }) });
    }
    if (u.includes("getEmbeddedSignLink")) {
      w.signLinks++;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({ signLink: "https://sign.test/x" }) });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

let n = 0;
async function load(text: string, w: World) {
  const mod = [
    "// @ts-nocheck",
    `const Deno = { env: { get: () => undefined } };`,
    `const BOLDSIGN_API_BASE = "https://boldsign.test/api";`,
    grabConst(text, "FN_NAME"),
    `function stripHomeownerPhone(f) { return f; }`,
    `async function autoPopulateFields() { return { fields: { contractor_email: "pro@example-roofing.test", contractor_name: "Acme Roofing", customer_name: "H. Owner" }, claimData: null, contractorData: null }; }`,
    `async function getTemplateFromStorage() { globalThis.__legacyReads = (globalThis.__legacyReads || 0) + 1; return "QkFTRTY0"; }`,
    `async function getPcTemplateFromStorage(_s, fileUrl) { (globalThis.__tplReads = globalThis.__tplReads || []).push(fileUrl); return "QkFTRTY0"; }`,
    `async function preflightTemplateTags() {}`,
    `function getDocumentLabel() { return "Doc"; }`,
    `function boldSignHeaders(h) { return h || {}; }`,
    `async function waitForBoldSignDocumentReady() {}`,
    `async function sendGA4Event() {}`,
    guardSrc.replace(/export /g, ""),
    grabConst(text, "COLOR_SLOT_PREFIX"),
    grabConst(text, "COLOR_SLOT_STALE_MS"),
    grabFrom(text, "isColorSlotPlaceholder"),
    grabFrom(text, "colorSlotIsStale"),
    grabFrom(text, "claimColorEnvelopeSlot", true),
    grabFrom(text, "releaseColorEnvelopeSlot", true),
    grabFrom(text, "resumeColorConfirmation", true),
    grabFrom(text, "colorRefusal"),
    grabFrom(text, "resolveOperation"),
    // Present on the fixed source; absent on main (main has no retired-type guard).
    text.includes("function retiredEnvelopeRefusal(") ? grabBlockConst(text, "RETIRED_ENVELOPE_CODES") : "",
    text.includes("function retiredEnvelopeRefusal(") ? grabFrom(text, "retiredEnvelopeRefusal") : "",
    grabFrom(text, "handleLegacyFlow", true),
    `export { handleLegacyFlow${text.includes("function retiredEnvelopeRefusal(") ? ", retiredEnvelopeRefusal" : ""} };`,
  ].join("\n\n");
  // deno-lint-ignore no-explicit-any
  return await import(`data:application/typescript;n=${n++},` + encodeURIComponent(mod)) as any;
}

async function run<T>(w: World, text: string, fn: (m: Awaited<ReturnType<typeof load>>) => Promise<T>) {
  (globalThis as any).__legacyReads = 0;
  (globalThis as any).__tplReads = [];
  const restore = installFetch(w);
  try { return await fn(await load(text, w)); } finally { restore(); }
}

function body(documentType: string, over: Record<string, unknown> = {}) {
  return {
    claim_id: "claim-1",
    contractor_id: "ctr-1",
    document_type: documentType,
    signer: { email: "owner@home.test", name: "H. Owner" },
    resolved_envelope_id: null,
    ...over,
  };
}
const created = (w: World) => w.sends + w.signLinks + (w.row.color_confirmation_envelope_id ? 1 : 0) + w.fromCalls.length + (globalThis as any).__tplReads.length + (globalThis as any).__legacyReads;

// ---- the refusal helper ----

Deno.test("retired: colour -> 410 color_envelope_retired; PC -> 410 project_confirmation_retired", async () => {
  const w = newWorld();
  await run(w, src, (m) => {
    return (async () => {
      const c = m.retiredEnvelopeRefusal("color_confirmation", {});
      assertEquals(c.status, 410);
      assertEquals((await c.json()).error, "color_envelope_retired");
      const p = m.retiredEnvelopeRefusal("project_confirmation", {});
      assertEquals(p.status, 410);
      assertEquals((await p.json()).error, "project_confirmation_retired");
    })();
  });
});

Deno.test("retired: contract document types are NOT refused (and prototype keys are not mistaken for retired types)", async () => {
  await run(newWorld(), src, (m) => {
    for (const t of ["contract", "contractor_sign", "homeowner_sign", undefined, null, "", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assertEquals(m.retiredEnvelopeRefusal(t as string, {}), null, `must not refuse ${String(t)}`);
    }
    return Promise.resolve();
  });
});

// ---- handleLegacyFlow: a fully mintable request creates nothing ----

for (const [docType, code] of [["color_confirmation", "color_envelope_retired"], ["project_confirmation", "project_confirmation_retired"]] as const) {
  Deno.test(`retired: ${docType} -> 410 ${code}; zero sends, zero reads, zero claim writes`, async () => {
    const w = newWorld();
    await run(w, src, async (m) => {
      const res = await m.handleLegacyFlow(fakeSupabase(w), body(docType), {});
      assertEquals(res.status, 410);
      assertEquals((await res.json()).error, code);
    });
    assertEquals(w.sends, 0, "no BoldSign document");
    assertEquals(w.signLinks, 0, "no sign link");
    assertEquals(w.fromCalls, [], "no table read or written");
    assertEquals(w.row.color_confirmation_envelope_id, null, "no envelope slot claimed");
    assertEquals((globalThis as any).__tplReads, [], "no template read");
    assertEquals((globalThis as any).__legacyReads, 0, "no fixed-path template read");
  });
}

Deno.test("retired: a colour envelope id already recorded on the claim is not resumed either (410, nothing created)", async () => {
  const w = newWorld();
  w.row.color_confirmation_envelope_id = "doc-existing";
  await run(w, src, async (m) => {
    const res = await m.handleLegacyFlow(fakeSupabase(w), body("color_confirmation", { resolved_envelope_id: "doc-existing" }), {});
    assertEquals(res.status, 410);
  });
  assertEquals(w.sends + w.signLinks, 0);
  assertEquals(w.row.color_confirmation_envelope_id, "doc-existing", "history is left as it was");
});

Deno.test("retired: repeat clicks still create nothing", async () => {
  const w = newWorld();
  await run(w, src, async (m) => {
    for (let i = 0; i < 5; i++) assertEquals((await m.handleLegacyFlow(fakeSupabase(w), body("color_confirmation"), {})).status, 410);
  });
  assertEquals(created(w), 0);
});

Deno.test("negative control: with the guard removed the same colour request mints a BoldSign document", async () => {
  const mutated = src.replace("if (retiredLegacy) return retiredLegacy;", "");
  assertNotEquals(mutated, src, "mutation must apply");
  const w = newWorld();
  await run(w, mutated, async (m) => {
    const res = await m.handleLegacyFlow(fakeSupabase(w), body("color_confirmation"), {});
    assertEquals(res.status, 200);
  });
  assertEquals(w.sends, 1, "the control must mint, or the 410 tests above prove nothing");
});

// ---- wiring in serve() (cannot be run directly) ----

Deno.test("wiring: serve() refuses retired types after type validation and BEFORE ownership lookup, rate limit and dispatch", () => {
  const valid = src.indexOf("const validDocTypes = [");
  const guard = src.indexOf("const retiredResponse = retiredEnvelopeRefusal(document_type, corsHeaders);");
  const owner = src.indexOf('"Forbidden: caller does not own this claim"');
  const claimsRead = src.indexOf('.from("claims").select("user_id").eq("id", claim_id)');
  const rate = src.indexOf('supabase.rpc("check_rate_limit"');
  const dispatch = src.indexOf("switch(document_type){");
  for (const [k, v] of Object.entries({ valid, guard, owner, claimsRead, rate, dispatch })) assert(v !== -1, `anchor missing: ${k}`);
  assert(valid < guard && guard < claimsRead && guard < owner && guard < rate && guard < dispatch, "refusal must precede every read, the rate limit and the dispatch");
  assert(src.slice(guard, guard + 400).includes("return retiredResponse;"));
  assertEquals(src.split("const retiredResponse = retiredEnvelopeRefusal(").length - 1, 1, "exactly one serve() call site");
});

Deno.test("wiring: both retired types stay in validDocTypes so a stale client gets 410, not 400", () => {
  const list = src.slice(src.indexOf("const validDocTypes = ["), src.indexOf("];", src.indexOf("const validDocTypes = [")));
  assert(list.includes('"color_confirmation"') && list.includes('"project_confirmation"'));
});

Deno.test("wiring: handleLegacyFlow refuses before the colour lookups, the slot claim and the send", () => {
  const legacy = grabFrom(src, "handleLegacyFlow", true);
  const guard = legacy.indexOf("retiredEnvelopeRefusal(document_type, corsHeaders)");
  assert(guard !== -1);
  for (const later of ['.from("claims")', "claimColorEnvelopeSlot(supabase", "/v1/document/send", "resumeColorConfirmation(", "getTemplateFromStorage("]) {
    assert(guard < legacy.indexOf(later), `guard must come before ${later}`);
  }
});

Deno.test("wiring: the contract paths do not depend on the retired helpers", () => {
  for (const fn of ["handleContractorSign", "handleHomeownerSign"]) {
    const body = grabFrom(src, fn, true);
    assert(!body.includes("retiredEnvelopeRefusal") && !body.includes("color_confirmation"), `${fn} must stay independent of the retired types`);
  }
});
