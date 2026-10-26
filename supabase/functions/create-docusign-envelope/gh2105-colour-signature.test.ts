// gh-2105 (colour-signature repair, checklist D, E, F) -- behaviour tests for the
// colour addendum path of create-docusign-envelope.
//
// The EF calls serve() at the bottom and cannot be imported, so (as in
// rate-limit-split.test.ts and gh2105-zero-row-wiring.test.ts) the real
// functions are extracted from index.ts as TEXT and run against a stateful fake
// of the claims table and a counting fake of fetch(). Nothing here restates the
// logic under test: handleLegacyFlow, claimColorEnvelopeSlot,
// releaseColorEnvelopeSlot, resumeColorConfirmation and resolveOperation are the
// production source.
//
// NEGATIVE CONTROLS: each guarantee is also run against a copy of the source
// with that guard deliberately removed, and must FAIL there. A test that cannot
// fail proves nothing (the gh-1842 / gh-1738 lesson).
//
//   D  repeat submit mints once          control: conditional `.is(..., null)` removed
//   E  missing contractor email mints 0  control: the fail-closed guard removed
//   F  claim-slot zero-row surfaces      control: covered by the not_found case
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

// ---- D: one envelope per claim ----

Deno.test("D: a repeat submit mints once, then resumes the same document for free", async () => {
  const w = newWorld();
  await run(w, src, async (m) => {
    const first = await submit(m, w);
    assertEquals(first.status, 200);
    assertEquals((await first.json()).envelope_id, "doc-1");
    for (let i = 0; i < 4; i++) {
      const again = await submit(m, w);
      const body = await again.json();
      assertEquals(body.envelope_id, "doc-1");
      assertEquals(body.resumed, true);
    }
  });
  assertEquals(w.sends, 1, "five clicks, one BoldSign envelope");
  assertEquals(w.row!.color_confirmation_envelope_id, "doc-1");
});

Deno.test("D: two simultaneous first clicks mint once (conditional slot claim)", async () => {
  const w = newWorld();
  const statuses = await run(w, src, async (m) => {
    const res = await Promise.all([submit(m, w), submit(m, w)]);
    return res.map((r) => r.status).sort();
  });
  assertEquals(w.sends, 1);
  assertEquals(statuses, [200, 409]);
});

Deno.test("D negative control: without the conditional update, simultaneous clicks mint twice", async () => {
  const mutated = src.replace('.eq("id", claimId).is("color_confirmation_envelope_id", null).select("id")', '.eq("id", claimId).select("id")');
  assertNotEquals(mutated, src, "mutation must apply");
  const w = newWorld();
  await run(w, mutated, async (m) => {
    await Promise.all([submit(m, w), submit(m, w)]);
  });
  assertEquals(w.sends, 2, "the control must reproduce the double mint, or the test above proves nothing");
});

Deno.test("D: a failed send releases the slot so the next click can mint", async () => {
  const w = newWorld({ failSend: true });
  await run(w, src, async (m) => {
    let threw = false;
    try { await submit(m, w); } catch (_e) { threw = true; }
    assert(threw);
    assertEquals(w.row!.color_confirmation_envelope_id, null);
    w.failSend = false;
    const ok = await submit(m, w);
    assertEquals(ok.status, 200);
  });
  assertEquals(w.sends, 1);
});

Deno.test("D: a sign-link failure after the mint keeps the real id, so a retry resumes", async () => {
  const w = newWorld({ failSignLink: true });
  await run(w, src, async (m) => {
    let threw = false;
    try { await submit(m, w); } catch (_e) { threw = true; }
    assert(threw);
    assertEquals(w.row!.color_confirmation_envelope_id, "doc-1");
    w.failSignLink = false;
    const retry = await submit(m, w);
    assertEquals((await retry.json()).resumed, true);
  });
  assertEquals(w.sends, 1);
});

Deno.test("D: slot states -- fresh placeholder is in flight, stale one is taken over, missing claim is not_found", async () => {
  const now = Date.now();
  await run(newWorld(), src, async (m) => {
    const fresh = newWorld({ row: { id: "claim-1", color_confirmation_envelope_id: `pending:${now - 1000}:u` } });
    assertEquals((await m.claimColorEnvelopeSlot(fakeSupabase(fresh), "claim-1", now, "n")).outcome, "in_flight");
    const stale = newWorld({ row: { id: "claim-1", color_confirmation_envelope_id: `pending:${now - 10 * 60 * 1000}:u` } });
    const took = await m.claimColorEnvelopeSlot(fakeSupabase(stale), "claim-1", now, "n");
    assertEquals(took.outcome, "claimed");
    assertEquals(stale.row!.color_confirmation_envelope_id, took.token);
    const done = newWorld({ row: { id: "claim-1", color_confirmation_envelope_id: "real-id" } });
    assertEquals((await m.claimColorEnvelopeSlot(fakeSupabase(done), "claim-1", now, "n")).outcome, "exists");
    const none = newWorld({ row: null });
    assertEquals((await m.claimColorEnvelopeSlot(fakeSupabase(none), "claim-1", now, "n")).outcome, "not_found");
  });
});

Deno.test("D: releasing only clears our own token, never a real id", async () => {
  const w = newWorld({ row: { id: "claim-1", color_confirmation_envelope_id: "real-id" } });
  await run(w, src, async (m) => {
    await m.releaseColorEnvelopeSlot(fakeSupabase(w), "claim-1", "pending:1:other");
  });
  assertEquals(w.row!.color_confirmation_envelope_id, "real-id");
});

Deno.test("D: a claim row that does not exist mints nothing and answers 404 (zero-row surfaces)", async () => {
  const w = newWorld({ row: null });
  await run(w, src, async (m) => {
    const res = await submit(m, w);
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error, "color_claim_not_found");
  });
  assertEquals(w.sends, 0);
});

Deno.test("D: resolveOperation sends a recorded colour envelope to the free resume budget", async () => {
  await run(newWorld(), src, (m) => {
    assertEquals(m.resolveOperation("color_confirmation", "doc-1"), "resume");
    assertEquals(m.resolveOperation("color_confirmation", null), "mint");
    return Promise.resolve();
  });
});

// ---- E: no invented counter-signer ----

for (const missing of ["contractor_email", "contractor_name"]) {
  Deno.test(`E: missing ${missing} refuses with 422 and mints zero`, async () => {
    const w = newWorld();
    delete w.fields[missing];
    await run(w, src, async (m) => {
      const res = await submit(m, w);
      assertEquals(res.status, 422);
      assertEquals((await res.json()).error, "color_contractor_identity_missing");
    });
    assertEquals(w.sends, 0);
    assertEquals(w.row!.color_confirmation_envelope_id, null);
  });
}

Deno.test("E negative control: with the guard removed the same input mints (to contractor@example.com)", async () => {
  const mutated = src.replace('document_type === "color_confirmation" && (!autoFields?.contractor_email || !autoFields?.contractor_name)', "false");
  assertNotEquals(mutated, src, "mutation must apply");
  const w = newWorld();
  delete w.fields.contractor_email;
  await run(w, mutated, async (m) => {
    await submit(m, w);
  });
  assertEquals(w.sends, 1, "the control must mint, or the E tests above prove nothing");
});

Deno.test("E: the legacy contractor@example.com fallback is unreachable for color_confirmation", () => {
  const legacy = grabFrom(src, "handleLegacyFlow", true);
  const refuse = legacy.indexOf("color_contractor_identity_missing");
  const fallback = legacy.indexOf('"contractor@example.com"');
  const send = legacy.indexOf("/v1/document/send");
  assert(refuse !== -1 && fallback !== -1 && send !== -1);
  assert(refuse < fallback && fallback < send, "the refusal must come before the fallback and the send");
});

// ---- wiring in the serve() handler (cannot be run directly) ----

Deno.test("wiring: the serve handler looks up the colour envelope before the rate limit and fails closed", () => {
  const lookup = src.indexOf('if (document_type === "color_confirmation") {\n      // gh-2105 (D)');
  const operation = src.indexOf("const operation = resolveOperation(document_type, resolvedEnvelopeId);");
  const rate = src.indexOf('supabase.rpc("check_rate_limit"');
  assert(lookup !== -1 && operation !== -1 && rate !== -1);
  assert(lookup < operation && operation < rate);
  assert(src.slice(lookup, operation).includes("color_envelope_lookup_failed"), "a failed lookup must refuse, not mint");
  assert(src.slice(lookup, operation).includes("isColorSlotPlaceholder"), "an in-flight placeholder is not an envelope id");
});

Deno.test("wiring: the resume path never reaches /v1/document/send", () => {
  assert(!grabFrom(src, "resumeColorConfirmation", true).includes("/v1/document/send"));
});

// ---- review 6325420063 item 2: the counter-signer is the SELECTED contractor ----

Deno.test("selected contractor: a caller-named contractor_id that is not claims.selected_contractor_id is refused 403 and mints zero", async () => {
  const w = newWorld();
  await run(w, src, async (m) => {
    const res = await submit(m, w, { contractor_id: "ctr-OTHER" });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).error, "color_contractor_not_selected");
  });
  assertEquals(w.sends, 0);
  assertEquals(w.row!.color_confirmation_envelope_id, null);
});

Deno.test("selected contractor: a claim with no selected contractor is refused 403 and mints zero", async () => {
  const w = newWorld();
  w.row!.selected_contractor_id = null;
  await run(w, src, async (m) => {
    assertEquals((await submit(m, w)).status, 403);
  });
  assertEquals(w.sends, 0);
});

Deno.test("selected contractor: a failed lookup fails closed (503), mints zero", async () => {
  const w = newWorld({ selectLookupError: true });
  await run(w, src, async (m) => {
    const res = await submit(m, w);
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, "color_contractor_lookup_failed");
  });
  assertEquals(w.sends, 0);
});

Deno.test("selected contractor: the matching contractor still mints once (positive control)", async () => {
  const w = newWorld();
  await run(w, src, async (m) => {
    assertEquals((await submit(m, w)).status, 200);
  });
  assertEquals(w.sends, 1);
});

Deno.test("selected contractor negative control: with the check removed a wrong contractor mints", async () => {
  const mutated = src.replace('selRow.selected_contractor_id !== contractor_id', "false").replace("!selRow.selected_contractor_id ||", "");
  assertNotEquals(mutated, src, "mutation must apply");
  const w = newWorld();
  await run(w, mutated, async (m) => {
    await submit(m, w, { contractor_id: "ctr-OTHER" });
  });
  assertEquals(w.sends, 1, "the control must mint, or the 403 tests above prove nothing");
});

Deno.test("caller fields: a body naming the contractor email/name is ignored, the server-built fields are used", async () => {
  const w = newWorld();
  delete w.fields.contractor_email; // server side has no email on file
  await run(w, src, async (m) => {
    const res = await submit(m, w, { fields: { contractor_email: "attacker@evil.test", contractor_name: "Evil Co" } });
    assertEquals(res.status, 422, "the caller's email must not satisfy the identity guard");
  });
  assertEquals(w.sends, 0);
  assertEquals((globalThis as any).__autoCalls >= 1, true, "fields must be auto-populated server-side");
});

Deno.test("caller fields negative control: with the always-auto-populate condition removed the attacker email mints", async () => {
  const mutated = src.replace('document_type === "color_confirmation" || !providedFields', "!providedFields");
  assertNotEquals(mutated, src, "mutation must apply");
  const w = newWorld();
  delete w.fields.contractor_email;
  await run(w, mutated, async (m) => {
    await submit(m, w, { fields: { contractor_email: "attacker@evil.test", contractor_name: "Evil Co" } });
  });
  assertEquals(w.sends, 1, "the control must mint, or the ignore-fields test above proves nothing");
});

// ---- gh-3093: the colour template comes from contractors.color_confirmation_template[trade/funding] ----

Deno.test("gh-3093: slot present -> that slot's template is used, once, and the envelope is minted", async () => {
  const w = newWorld({ contractor: { color_confirmation_template: {
    "roofing/retail": { file_url: "ctr-1/pc_roofing_retail_111.pdf" },
    "roofing/insurance": { file_url: "ctr-1/pc_roofing_insurance_222.pdf" },
  } }, claimExtra: { trades: ["Roofing"], funding_type: "insurance" } });
  (globalThis as any).__tplReads = []; (globalThis as any).__legacyPathReads = 0;
  await run(w, src, async (m) => {
    assertEquals((await submit(m, w)).status, 200);
  });
  assertEquals((globalThis as any).__tplReads, ["ctr-1/pc_roofing_insurance_222.pdf"]);
  assertEquals((globalThis as any).__legacyPathReads, 0, "the fixed <id>/color_confirmation.pdf path must not be read");
  assertEquals(w.sends, 1);
});

Deno.test("gh-3093: slot absent -> 422 color_template_missing, nothing claimed, nothing sent (fail closed)", async () => {
  const w = newWorld({ contractor: { color_confirmation_template: {} } });
  (globalThis as any).__tplReads = []; (globalThis as any).__legacyPathReads = 0;
  await run(w, src, async (m) => {
    const res = await submit(m, w);
    assertEquals(res.status, 422);
    assertEquals((await res.json()).error, "color_template_missing");
  });
  assertEquals(w.sends, 0);
  assertEquals(w.row!.color_confirmation_envelope_id, null, "no envelope slot may be claimed");
  assertEquals((globalThis as any).__tplReads, []);
  assertEquals((globalThis as any).__legacyPathReads, 0);
});

Deno.test("gh-3093: null template column and missing contractor row also refuse", async () => {
  for (const contractor of [{ color_confirmation_template: null }, null]) {
    const w = newWorld({ contractor });
    await run(w, src, async (m) => {
      const res = await submit(m, w);
      assertEquals(res.status, 422);
      assertEquals((await res.json()).error, "color_template_missing");
    });
    assertEquals(w.sends, 0);
  }
});

Deno.test("gh-3093: exact key only -- a roofing/insurance slot does NOT serve a roofing/retail claim, nor another trade", async () => {
  for (const [tpl, extra] of [
    [{ "roofing/insurance": { file_url: "ctr-1/pc_roofing_insurance_222.pdf" } }, { trades: ["roofing"], funding_type: "retail" }],
    [{ "roofing/retail": { file_url: "ctr-1/pc_roofing_retail_111.pdf" } }, { trades: ["siding"], funding_type: "retail" }],
    [{ "roofing/retail": { file_url: "" } }, { trades: ["roofing"], funding_type: "retail" }],
  ] as const) {
    const w = newWorld({ contractor: { color_confirmation_template: tpl }, claimExtra: extra });
    (globalThis as any).__tplReads = [];
    await run(w, src, async (m) => {
      const res = await submit(m, w);
      assertEquals(res.status, 422);
    });
    assertEquals(w.sends, 0);
    assertEquals((globalThis as any).__tplReads, []);
  }
});

Deno.test("gh-3093 negative control: with the guard removed a slot-less contractor mints", async () => {
  const mutated = src.replace("const colorSlot =", "let colorSlot =").replace("if (!colorSlot?.file_url) {", 'colorSlot = colorSlot || { file_url: "platform-default.pdf" }; if (false) {');
  assertNotEquals(mutated, src, "mutation must apply");
  const w = newWorld({ contractor: { color_confirmation_template: {} } });
  await run(w, mutated, async (m) => {
    await submit(m, w);
  });
  assertEquals(w.sends, 1, "the control must mint, or the fail-closed test above proves nothing");
});

Deno.test("gh-3093: the slot refusal sits before the slot claim and the send", () => {
  const legacy = grabFrom(src, "handleLegacyFlow", true);
  const refuse = legacy.indexOf("color_template_missing");
  assert(refuse !== -1);
  assert(refuse < legacy.indexOf("claimColorEnvelopeSlot(supabase"));
  assert(refuse < legacy.indexOf("/v1/document/send"));
});
