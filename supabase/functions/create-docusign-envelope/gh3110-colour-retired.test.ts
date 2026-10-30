// gh-3110 (option a, Dustin on #3145, 2026-10-30) -- the separate colour-confirmation
// envelope is RETIRED. Colour is signed on the Project Confirmation (D-155), so a claim
// produces exactly one envelope.
//
// Same harness as gh2105-colour-signature.test.ts: the real handleLegacyFlow and its helpers
// are extracted from index.ts as TEXT and run against a stateful fake of the claims row and a
// counting fake of BoldSign fetch(). NEGATIVE CONTROL: the same input against a copy of the
// source with the retirement guard removed (= main before this change) MINTS a colour
// envelope, so these tests fail on main and pass only with the guard.
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
      if (paren === 0) {
        bodyOpen = text.indexOf("{", j);
        break;
      }
    }
  }
  let depth = 0;
  for (let j = bodyOpen; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced: ${name}`);
}

function grabConstFrom(text: string, name: string): string {
  const m = text.match(new RegExp(`^const ${name} = .*$`, "m"));
  if (!m) throw new Error(`not found: const ${name}`);
  return m[0];
}

// ---- fakes ----

interface World {
  row: { id: string; color_confirmation_envelope_id: string | null; selected_contractor_id?: string | null; is_test?: boolean } | null;
  selectLookupError?: boolean;
  autoCalls?: number;
  sends: number;
  signLinks: number;
  alerts: number;
  failSend: boolean;
  failSignLink: boolean;
  fields: Record<string, string>;
  contractor?: { color_confirmation_template: unknown } | null;
  claimExtra?: Record<string, unknown>;
  templateReads?: string[];
}

function newWorld(over: Partial<World> = {}): World {
  return {
    row: { id: "claim-1", color_confirmation_envelope_id: null, selected_contractor_id: "ctr-1" },
    autoCalls: 0,
    sends: 0,
    signLinks: 0,
    alerts: 0,
    failSend: false,
    failSignLink: false,
    fields: { contractor_email: "pro@example-roofing.test", contractor_name: "Acme Roofing", customer_name: "H. Owner" },
    contractor: { color_confirmation_template: { "roofing/retail": { file_url: "ctr-1/pc_roofing_retail_1.pdf" } } },
    claimExtra: { trades: ["roofing"], funding_type: "retail" },
    templateReads: [],
    ...over,
  };
}

// Minimal PostgREST-shaped client over the single claims row.
function fakeSupabase(w: World) {
  function from(table: string) {
    if (table === "platform_alerts_log") {
      return { insert: () => { w.alerts++; return Promise.resolve({ error: null }); } };
    }
    if (table === "contractors") {
      const c: Record<string, unknown> = { select: () => c, eq: () => c, maybeSingle: () => Promise.resolve({ data: w.contractor ?? null, error: null }) };
      return c;
    }
    const filters: Array<[string, string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    const match = () => w.row && filters.every(([op, col, val]) => {
      const cur = (w.row as Record<string, unknown>)[col] ?? null;
      return op === "is" ? cur === null : cur === val;
    });
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: Record<string, unknown>) => { patch = p; return chain; },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return chain; },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return chain; },
      maybeSingle: () => w.selectLookupError ? Promise.resolve({ data: null, error: { message: "boom" } }) : Promise.resolve({ data: w.row && filters.every(([, c, v]) => (w.row as Record<string, unknown>)[c] === v || (v === null && ((w.row as Record<string, unknown>)[c] ?? null) === null)) ? { ...w.row, ...(w.claimExtra || {}) } : null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch && match()) {
          Object.assign(w.row as object, patch);
          return resolve({ data: [{ id: w.row!.id }], error: null });
        }
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
      if (w.failSend) return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom"), json: () => Promise.resolve({}) });
      w.sends++;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({ documentId: `doc-${w.sends}` }) });
    }
    if (u.includes("getEmbeddedSignLink")) {
      w.signLinks++;
      if (w.failSignLink) return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom"), json: () => Promise.resolve({}) });
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
    grabConstFrom(text, "FN_NAME"),
    `const WORLD_FIELDS = ${JSON.stringify(w.fields)};`,
    `function stripHomeownerPhone(f) { return f; }`,
    `async function autoPopulateFields() { globalThis.__autoCalls = (globalThis.__autoCalls || 0) + 1; return { fields: { ...WORLD_FIELDS }, claimData: null, contractorData: null }; }`,
    `async function getTemplateFromStorage() { globalThis.__legacyPathReads = (globalThis.__legacyPathReads || 0) + 1; return "QkFTRTY0"; }`,
    `async function getPcTemplateFromStorage(_s, fileUrl) { (globalThis.__tplReads = globalThis.__tplReads || []).push(fileUrl); return "QkFTRTY0"; }`,
    `async function preflightTemplateTags() {}`,
    `function getDocumentLabel() { return "Color Confirmation"; }`,
    `function boldSignHeaders(h) { return h || {}; }`,
    `async function waitForBoldSignDocumentReady() {}`,
    `async function sendGA4Event() {}`,
    // The real guard, with `export` stripped so it can sit in this module.
    guardSrc.replace(/export /g, ""),
    grabConstFrom(text, "COLOR_SLOT_PREFIX"),
    grabConstFrom(text, "COLOR_SLOT_STALE_MS"),
    grabFrom(text, "isColorSlotPlaceholder"),
    grabFrom(text, "colorSlotIsStale"),
    grabFrom(text, "claimColorEnvelopeSlot", true),
    grabFrom(text, "releaseColorEnvelopeSlot", true),
    grabFrom(text, "resumeColorConfirmation", true),
    grabFrom(text, "colorRefusal"),
    grabFrom(text, "resolveOperation"),
    grabFrom(text, "handleLegacyFlow", true),
    "export { handleLegacyFlow, claimColorEnvelopeSlot, releaseColorEnvelopeSlot, resolveOperation, colorSlotIsStale };",
  ].join("\n\n");
  // deno-lint-ignore no-explicit-any
  return await import(`data:application/typescript;n=${n++},` + encodeURIComponent(mod)) as any;
}

// Mirrors the colour lookup in the serve() handler (asserted present by the
// wiring tests below): a real id means resume, a placeholder does not.
function resolvedId(w: World) {
  const v = w.row?.color_confirmation_envelope_id ?? null;
  return v && !v.startsWith("pending:") ? v : null;
}

async function submit(m: { handleLegacyFlow: (...a: unknown[]) => Promise<Response> }, w: World, over: Record<string, unknown> = {}) {
  const body = {
    claim_id: "claim-1",
    contractor_id: "ctr-1",
    document_type: "color_confirmation",
    signer: { email: "owner@home.test", name: "H. Owner" },
    resolved_envelope_id: resolvedId(w),
    ...over,
  };
  return await m.handleLegacyFlow(fakeSupabase(w), body, {});
}

async function run<T>(w: World, text: string, fn: (m: Awaited<ReturnType<typeof load>>) => Promise<T>) {
  const restore = installFetch(w);
  try {
    return await fn(await load(text, w));
  } finally {
    restore();
  }
}


const GUARD = 'if (document_type === "color_confirmation") {\n    console.warn(`[${FN_NAME}] color_confirmation refused: the separate colour envelope is retired';

Deno.test("gh-3110: a fresh claim's colour request is refused 410, zero envelopes, zero slot claimed, zero template reads", async () => {
  const w = newWorld();
  (globalThis as any).__tplReads = []; (globalThis as any).__legacyPathReads = 0;
  await run(w, src, async (m) => {
    const res = await submit(m, w);
    assertEquals(res.status, 410);
    assertEquals((await res.json()).error, "color_envelope_retired");
  });
  assertEquals(w.sends, 0, "no BoldSign envelope");
  assertEquals(w.signLinks, 0);
  assertEquals(w.row!.color_confirmation_envelope_id, null, "no slot claimed on the claim row");
  assertEquals((globalThis as any).__tplReads, [], "no template read");
  assertEquals((globalThis as any).__legacyPathReads, 0);
});

Deno.test("gh-3110: repeated colour requests (the old double-click) still produce zero envelopes", async () => {
  const w = newWorld();
  await run(w, src, async (m) => {
    for (let i = 0; i < 5; i++) assertEquals((await submit(m, w)).status, 410);
  });
  assertEquals(w.sends, 0);
});

Deno.test("gh-3110: refused for every funding type and a contractor with no slot (no 422 template path any more)", async () => {
  for (const contractor of [{ color_confirmation_template: {} }, null]) {
    const w = newWorld({ contractor, claimExtra: { trades: ["roofing"], funding_type: "insurance" } });
    await run(w, src, async (m) => {
      assertEquals((await submit(m, w)).status, 410);
    });
    assertEquals(w.sends, 0);
  }
});

Deno.test("gh-3110: a colour envelope minted BEFORE this change is still resumed, free, never re-minted", async () => {
  const w = newWorld({ row: { id: "claim-1", color_confirmation_envelope_id: "doc-old", selected_contractor_id: "ctr-1" } });
  await run(w, src, async (m) => {
    const res = await submit(m, w);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.envelope_id, "doc-old");
    assertEquals(body.resumed, true);
  });
  assertEquals(w.sends, 0, "resume never reaches /v1/document/send");
});

Deno.test("gh-3110: the selected-contractor 403 still precedes the retirement refusal", async () => {
  const w = newWorld();
  await run(w, src, async (m) => {
    assertEquals((await submit(m, w, { contractor_id: "ctr-OTHER" })).status, 403);
  });
});

Deno.test("gh-3110 NEGATIVE CONTROL (= main before the change): with the guard removed the same fresh-claim request mints a colour envelope", async () => {
  assert(src.includes(GUARD), "guard text present in the real source");
  const mutated = src.replace(GUARD, "if (false) {\n    console.warn(`[${FN_NAME}] color_confirmation refused: the separate colour envelope is retired");
  assertNotEquals(mutated, src, "mutation must apply");
  const w = newWorld();
  await run(w, mutated, async (m) => {
    assertEquals((await submit(m, w)).status, 200);
  });
  assertEquals(w.sends, 1, "without the guard a colour envelope is minted; the tests above prove nothing otherwise");
  assertEquals(w.row!.color_confirmation_envelope_id, "doc-1");
});

Deno.test("gh-3110 wiring: the guard is colour-only, sits after the resume and before the slot claim, template read and send", () => {
  const legacy = grabFrom(src, "handleLegacyFlow", true);
  const guard = legacy.indexOf("color_envelope_retired");
  assert(guard !== -1);
  assert(legacy.lastIndexOf('if (document_type === "color_confirmation") {', guard) > legacy.indexOf("resumeColorConfirmation("), "after the resume");
  assert(guard < legacy.indexOf("claimColorEnvelopeSlot(supabase"));
  assert(guard < legacy.indexOf("getPcTemplateFromStorage"));
  assert(guard < legacy.indexOf("/v1/document/send"));
  // project_confirmation (the one remaining envelope, which carries shingle_color / drip_edge_color) is untouched.
  assert(legacy.includes('document_type === "project_confirmation"'));
  assert(src.includes("shingle_color"), "the PC branch still fills the colour tags");
  assert(src.includes("drip_edge_color"));
});
