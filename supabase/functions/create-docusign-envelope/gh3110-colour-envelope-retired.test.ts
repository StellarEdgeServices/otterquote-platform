// gh-3110 / D-393 (amended 2026-10-30, Dustin on #3145: "(a) Retire it (Recommended)").
//
// The separate colour envelope is retired: a homeowner signs ONE document, the Project
// Confirmation, and the colour is on it (shingle_color / drip_edge_color, D-058/D-155).
// Before this change the colour step minted its own envelope from the SAME contractor slot
// (contractors.color_confirmation_template[<trade>/<funding_type>]) the Project Confirmation
// reads, so one claim got two envelopes from one template key.
//
// As in gh2105-colour-signature.test.ts, the EF calls serve() and cannot be imported, so the
// real handleLegacyFlow (and the helpers it calls) are extracted from index.ts as TEXT and run
// against a fake claims row and a counting fake of fetch(). Nothing here restates the logic.
//
// NEGATIVE CONTROL: `preRetirement` is index.ts with ONLY the gh-3110 handleLegacyFlow guard
// removed, which is exactly the colour path on main before this PR. The same fresh-claim
// submission must mint a colour envelope there (from the PC's own slot) or the tests above it
// prove nothing. Run against origin/main's index.ts this whole file fails (the retirement
// tests mint, and the guard-strip precondition does not apply).
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const guardSrc = await Deno.readTextFile(new URL("../_shared/zero-row-update-guard.ts", import.meta.url));

const RETIRE_GUARD = `  if (document_type === "color_confirmation") {
    return colorRefusal(410, "color_envelope_retired", corsHeaders);
  }
`;
const preRetirement = src.replace(RETIRE_GUARD, "");

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

interface World {
  row: { id: string; color_confirmation_envelope_id: string | null; selected_contractor_id: string | null } | null;
  sends: number;
  signLinks: number;
  slotWrites: number;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    row: { id: "claim-1", color_confirmation_envelope_id: null, selected_contractor_id: "ctr-1" },
    sends: 0,
    signLinks: 0,
    slotWrites: 0,
    ...over,
  };
}

// The roofing/retail is_test shape the closes-on proof uses: the contractor has ONE slot,
// roofing/retail, and it is the Project Confirmation template.
const CONTRACTOR = { color_confirmation_template: { "roofing/retail": { file_url: "ctr-1/pc_roofing_retail_1.pdf" } } };
const CLAIM_EXTRA = { trades: ["roofing"], funding_type: "retail", is_test: true };

function fakeSupabase(w: World) {
  function from(table: string) {
    if (table === "platform_alerts_log") return { insert: () => Promise.resolve({ error: null }) };
    if (table === "contractors") {
      const c: Record<string, unknown> = { select: () => c, eq: () => c, maybeSingle: () => Promise.resolve({ data: CONTRACTOR, error: null }) };
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
      maybeSingle: () => Promise.resolve({ data: w.row ? { ...w.row, ...CLAIM_EXTRA } : null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch && match()) {
          w.slotWrites++;
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
async function load(text: string) {
  const mod = [
    "// @ts-nocheck",
    `const Deno = { env: { get: () => undefined } };`,
    `const BOLDSIGN_API_BASE = "https://boldsign.test/api";`,
    grabConstFrom(text, "FN_NAME"),
    `function stripHomeownerPhone(f) { return f; }`,
    `async function autoPopulateFields() { return { fields: { contractor_email: "pro@example-roofing.test", contractor_name: "Acme Roofing", customer_name: "H. Owner" }, claimData: null, contractorData: null }; }`,
    `async function getTemplateFromStorage() { return "QkFTRTY0"; }`,
    `async function getPcTemplateFromStorage(_s, fileUrl) { (globalThis.__gh3110TplReads = globalThis.__gh3110TplReads || []).push(fileUrl); return "QkFTRTY0"; }`,
    `async function preflightTemplateTags() {}`,
    `function getDocumentLabel() { return "Color Confirmation"; }`,
    `function boldSignHeaders(h) { return h || {}; }`,
    `async function waitForBoldSignDocumentReady() {}`,
    `async function sendGA4Event() {}`,
    guardSrc.replace(/export /g, ""),
    grabConstFrom(text, "COLOR_SLOT_PREFIX"),
    grabConstFrom(text, "COLOR_SLOT_STALE_MS"),
    grabFrom(text, "isColorSlotPlaceholder"),
    grabFrom(text, "colorSlotIsStale"),
    grabFrom(text, "claimColorEnvelopeSlot", true),
    grabFrom(text, "releaseColorEnvelopeSlot", true),
    grabFrom(text, "resumeColorConfirmation", true),
    grabFrom(text, "colorRefusal"),
    grabFrom(text, "handleLegacyFlow", true),
    "export { handleLegacyFlow };",
  ].join("\n\n");
  // deno-lint-ignore no-explicit-any
  return await import(`data:application/typescript;gh3110=${n++},` + encodeURIComponent(mod)) as any;
}

function resolvedId(w: World) {
  const v = w.row?.color_confirmation_envelope_id ?? null;
  return v && !v.startsWith("pending:") ? v : null;
}

async function colourSubmit(text: string, w: World, over: Record<string, unknown> = {}) {
  const restore = installFetch(w);
  try {
    const m = await load(text);
    return await m.handleLegacyFlow(fakeSupabase(w), {
      claim_id: "claim-1",
      contractor_id: "ctr-1",
      document_type: "color_confirmation",
      signer: { email: "owner@home.test", name: "H. Owner" },
      resolved_envelope_id: resolvedId(w),
      ...over,
    }, {});
  } finally {
    restore();
  }
}

// ---- retirement (real source) ----

Deno.test("gh-3110: a fresh roofing/retail claim gets 410 color_envelope_retired, no slot claimed, no template read, nothing sent", async () => {
  const w = newWorld();
  (globalThis as any).__gh3110TplReads = [];
  const res = await colourSubmit(src, w);
  assertEquals(res.status, 410);
  assertEquals((await res.json()).error, "color_envelope_retired");
  assertEquals(w.sends, 0, "no BoldSign colour envelope");
  assertEquals(w.slotWrites, 0, "no claims write at all");
  assertEquals(w.row!.color_confirmation_envelope_id, null, "color_confirmation_envelope_id stays NULL");
  assertEquals((globalThis as any).__gh3110TplReads, [], "the PC template slot is not read for a colour envelope");
});

Deno.test("gh-3110: repeated colour submits never mint", async () => {
  const w = newWorld();
  for (let i = 0; i < 5; i++) assertEquals((await colourSubmit(src, w)).status, 410);
  assertEquals(w.sends, 0);
  assertEquals(w.row!.color_confirmation_envelope_id, null);
});

Deno.test("gh-3110: a colour envelope minted before the change still resumes (history kept), without a new send", async () => {
  const w = newWorld({ row: { id: "claim-1", color_confirmation_envelope_id: "doc-historic", selected_contractor_id: "ctr-1" } });
  const res = await colourSubmit(src, w);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.envelope_id, "doc-historic");
  assertEquals(body.resumed, true);
  assertEquals(w.sends, 0);
});

Deno.test("gh-3110: the selected-contractor check still runs first (wrong contractor is 403, not 410)", async () => {
  const w = newWorld();
  const res = await colourSubmit(src, w, { contractor_id: "ctr-OTHER" });
  assertEquals(res.status, 403);
  assertEquals(w.sends, 0);
});

// ---- negative control: the pre-retirement colour path (main before this PR) ----

Deno.test("gh-3110 NEGATIVE CONTROL: without the retirement guard the same claim mints a colour envelope from the PC's own slot", async () => {
  assertNotEquals(preRetirement, src, "the retirement guard must be present in handleLegacyFlow to strip");
  const w = newWorld();
  (globalThis as any).__gh3110TplReads = [];
  const res = await colourSubmit(preRetirement, w);
  assertEquals(res.status, 200);
  assertEquals(w.sends, 1, "the control must mint, or the 410 tests above prove nothing");
  assertEquals(w.row!.color_confirmation_envelope_id, "doc-1");
  assertEquals((globalThis as any).__gh3110TplReads, ["ctr-1/pc_roofing_retail_1.pdf"], "the colour envelope reads the SAME roofing/retail slot as the Project Confirmation");
});

// ---- wiring in serve() (cannot be run directly) ----

Deno.test("gh-3110 wiring: serve refuses an unminted colour request before the rate-limit RPC (no mint budget spent)", () => {
  const lookup = src.indexOf('if (document_type === "color_confirmation") {\n      // gh-2105 (D)');
  const refuse = src.indexOf('if (!resolvedEnvelopeId) return colorRefusal(410, "color_envelope_retired", corsHeaders);');
  const rate = src.indexOf('supabase.rpc("check_rate_limit"');
  assert(lookup !== -1 && refuse !== -1 && rate !== -1);
  assert(lookup < refuse && refuse < rate);
});

Deno.test("gh-3110 wiring: the guard in handleLegacyFlow sits after the resume and before any template read, slot claim or send", () => {
  const legacy = grabFrom(src, "handleLegacyFlow", true);
  const resume = legacy.indexOf("return await resumeColorConfirmation(");
  const guard = legacy.indexOf(RETIRE_GUARD);
  assert(resume !== -1 && guard !== -1);
  assert(resume < guard);
  for (const later of ["autoPopulateFields(", "selectPcTemplateSlot(", "claimColorEnvelopeSlot(supabase", "/v1/document/send"]) {
    const at = legacy.indexOf(later);
    assert(at !== -1 && guard < at, `guard must precede ${later}`);
  }
});

Deno.test("gh-3110: the Project Confirmation envelope is the one that carries the colour (shingle_color, drip_edge_color)", () => {
  const auto = grabFrom(src, "autoPopulateFields", true);
  const pcBranch = auto.slice(auto.indexOf('documentType === "project_confirmation" && claimData?.project_confirmation'));
  assert(pcBranch.includes('shingle_color: pc.shingleColor || ""'));
  assert(pcBranch.includes('drip_edge_color: pc.dripEdgeColor || ""'));
});
