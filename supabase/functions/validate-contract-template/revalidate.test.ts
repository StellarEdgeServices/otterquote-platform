// gh-1315 — the re-validation pass, driven with a fake Supabase client and a
// fake extractor so nothing here touches storage, env or the network.
//
// Fixture rows mirror production on 2026-09-04:
//   A  auto_validated, v2 result 13/13, PDF text carries only v2 anchors  -> v3 fails, manual_mapping_pending
//   B  auto_validated, no result, placeholder path that 404s              -> error, nothing written
//   C  auto_validated, no result, PDF is the v3 starter text              -> v3 passes, stays auto_validated
//   D  pending_validation, no result, v3 text minus the contract_price tag -> manual_mapping_pending, price missing
//   E  manual_validated, v3 result already                                -> skipped unless force
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MANIFEST } from "./manifest.ts";
import { isStale, nextStatus, revalidateTemplates } from "./revalidate.ts";
import { CONTRACT_PRICE_FIELD_ID, CURRENT_TEMPLATE_MANIFEST_VERSION } from "./template-validity.ts";

// deno-lint-ignore no-explicit-any
function v3Text(trade: string, funding: string, drop?: string): string {
  const slot = MANIFEST.trades[trade][funding];
  // deno-lint-ignore no-explicit-any
  return slot.required.map((r: any) => r.anchor).filter((a: string) => !drop || !a.endsWith(`|${drop}}}`)).join("\n") + "\nTERMS AND CONDITIONS\n";
}
const V2_TEXT = "/Customer/ /CustomerDate/ /Contractor/ /ContractorDate/ Name Address: Contract Price: Job Description: Shingle Type: Manufacturer's Warranty: Workmanship Warranty: Decking Per Sheet: Start Date:";

const v2Result = { manifestVersion: "v2", requiredCount: 13, requiredFoundCount: 13, allRequiredFound: true, anchors: [] };
const v3Good = { manifestVersion: "v3", requiredCount: 13, requiredFoundCount: 13, allRequiredFound: true, anchors: [] };

function fixtureRows() {
  return [
    { id: "A", contractor_id: "c1", trade: "roofing", funding_type: "retail", status: "auto_validated", pdf_storage_path: "c1/roofing/retail.pdf", validation_result: v2Result, manual_overrides: null },
    { id: "B", contractor_id: "c2", trade: "siding", funding_type: "retail", status: "auto_validated", pdf_storage_path: "ci-test/placeholder.pdf", validation_result: null, manual_overrides: null },
    { id: "C", contractor_id: "c2", trade: "roofing", funding_type: "insurance", status: "auto_validated", pdf_storage_path: "c2/roofing/insurance.pdf", validation_result: null, manual_overrides: null },
    { id: "D", contractor_id: "c3", trade: "roofing", funding_type: "retail", status: "pending_validation", pdf_storage_path: "c3/roofing/retail.pdf", validation_result: null, manual_overrides: null },
    { id: "E", contractor_id: "c4", trade: "roofing", funding_type: "retail", status: "manual_validated", pdf_storage_path: "c4/roofing/retail.pdf", validation_result: v3Good, manual_overrides: { x: "y" } },
  ];
}
const TEXT_BY_PATH: Record<string, string> = {
  "c1/roofing/retail.pdf": V2_TEXT,
  "c2/roofing/insurance.pdf": v3Text("roofing", "insurance"),
  "c3/roofing/retail.pdf": v3Text("roofing", "retail", "contract_price"),
  "c4/roofing/retail.pdf": v3Text("roofing", "retail"),
};

// deno-lint-ignore no-explicit-any
function fakeSupabase(rows: any[]) {
  // deno-lint-ignore no-explicit-any
  const writes: any[] = [];
  const client = {
    writes,
    from(table: string) {
      if (table === "contractor_templates") {
        // deno-lint-ignore no-explicit-any
        let filtered: any[] = rows;
        const chain = {
          select() { return chain; },
          order() { return chain; },
          in(_col: string, ids: string[]) { filtered = rows.filter((r) => ids.includes(r.id)); return chain; },
          then(resolve: (v: unknown) => void) { resolve({ data: filtered, error: null }); },
          // deno-lint-ignore no-explicit-any
          update(patch: any) {
            return { eq(_col: string, id: string) { writes.push({ id, patch }); return Promise.resolve({ error: null }); } };
          },
        };
        return chain;
      }
      if (table === "contractors") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          maybeSingle() { return Promise.resolve({ data: { company_name: "Fixture Co", address_line1: null, address_city: null }, error: null }); },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from(_bucket: string) {
        return {
          download(path: string) {
            const text = TEXT_BY_PATH[path];
            if (!text) return Promise.resolve({ data: null, error: { message: "Object not found" } });
            const bytes = new TextEncoder().encode(text);
            return Promise.resolve({ data: { arrayBuffer: () => Promise.resolve(bytes.buffer) }, error: null });
          },
        };
      },
    },
  };
  return client;
}
const fakeExtract = (bytes: Uint8Array) => Promise.resolve(new TextDecoder().decode(bytes));
const fixedNow = () => new Date("2026-09-04T21:00:00.000Z");

Deno.test("isStale: null result and non-current version are stale; current is not", () => {
  assert(isStale({ validation_result: null }, "v3"));
  assert(isStale({}, "v3"));
  assert(isStale({ validation_result: { manifestVersion: "v2" } }, "v3"));
  assert(!isStale({ validation_result: { manifestVersion: "v3" } }, "v3"));
});

Deno.test("nextStatus: the D-199 state machine, verbatim from the fresh path", () => {
  assertEquals(nextStatus(true, undefined), "auto_validated");
  assertEquals(nextStatus(true, null), "auto_validated");
  assertEquals(nextStatus(true, { a: "b" }), "manual_validated");
  assertEquals(nextStatus(false, { a: "b" }), "manual_mapping_pending");
  assertEquals(nextStatus(false, undefined), "manual_mapping_pending");
});

Deno.test("dry run: reports every stale row, writes nothing, names the field that fails", async () => {
  const sb = fakeSupabase(fixtureRows());
  const r = await revalidateTemplates({ supabase: sb, dryRun: true, extractPdfText: fakeExtract, now: fixedNow });
  assertEquals(r.dryRun, true);
  assertEquals(r.currentManifestVersion, CURRENT_TEMPLATE_MANIFEST_VERSION);
  assertEquals(r.scanned, 5);
  assertEquals(r.stale, 4, "E carries a current result and is skipped");
  assertEquals(r.written, 0);
  assertEquals(sb.writes.length, 0, "dry run must not write");
  assertEquals(r.rows.map((x) => x.id), ["A", "B", "C", "D"]);

  const A = r.rows[0];
  assertEquals(A.before, { status: "auto_validated", manifestVersion: "v2", usable: false, code: "manifest_version_stale" });
  assertEquals(A.after?.status, "manual_mapping_pending");
  assertEquals(A.after?.requiredFoundCount, 2, "of v2's 13 anchors only the two label_text warranty labels survive under v3; no boldsign_tag is satisfied");
  assertEquals(A.after?.contract_price_found, false);
  assertEquals(A.after?.usable, false);
  assertEquals(A.status_would_change, true);
  assert(A.after!.missing.includes("Total contract amount"));

  const B = r.rows[1];
  assertEquals(B.after, null);
  assertStringIncludes(B.error!, "PDF not found in storage (ci-test/placeholder.pdf)");
  assertEquals(B.before.code, "validation_result_missing");

  const C = r.rows[2];
  assertEquals(C.after?.status, "auto_validated");
  assertEquals(C.after?.allRequiredFound, true);
  assertEquals(C.after?.contract_price_found, true);
  assertEquals(C.after?.usable, true);
  assertEquals(C.status_would_change, false, "status is unchanged; only the artefact was missing");

  const D = r.rows[3];
  assertEquals(D.after?.status, "manual_mapping_pending");
  assertEquals(D.after?.contract_price_found, false);
  assertEquals(D.after?.requiredFoundCount, D.after!.requiredCount! - 1);
  assertEquals(D.after?.missing, ["Total contract amount"]);
  assertEquals(D.status_would_change, true);

  assertEquals(r.wouldPass, 1);
  assertEquals(r.wouldFail, 2);
  assertEquals(r.errors, 1);
});

Deno.test("write mode: writes validation_result + status through the same state machine; erroring rows are left alone", async () => {
  const sb = fakeSupabase(fixtureRows());
  const r = await revalidateTemplates({ supabase: sb, dryRun: false, extractPdfText: fakeExtract, now: fixedNow });
  assertEquals(r.written, 3);
  assertEquals(sb.writes.map((w) => w.id), ["A", "C", "D"], "B (404) is never written");
  const wA = sb.writes[0].patch;
  assertEquals(wA.status, "manual_mapping_pending");
  assertEquals(wA.validation_result.manifestVersion, "v3");
  assertEquals(wA.validation_result.revalidated, { from: "v2", at: "2026-09-04T21:00:00.000Z" });
  assertEquals(wA.validation_result.validatedAt, "2026-09-04T21:00:00.000Z");
  assertEquals(Object.keys(wA).sort(), ["status", "validation_result"], "manual_overrides is never rewritten by revalidation");
  const wC = sb.writes[1].patch;
  assertEquals(wC.status, "auto_validated");
  assertEquals(wC.validation_result.allRequiredFound, true);
  // deno-lint-ignore no-explicit-any
  const priceAnchor = wC.validation_result.anchors.find((a: any) => String(a.anchor).endsWith(`|${CONTRACT_PRICE_FIELD_ID}}}`));
  assertEquals(priceAnchor.found, true);
  assertEquals(r.rows.find((x) => x.id === "C")!.written, true);
  assertEquals(r.rows.find((x) => x.id === "B")!.written, false);
});

Deno.test("write mode honours stored manual_overrides for the status verdict (manual_validated), never invents them", async () => {
  const rows = fixtureRows().map((x) => x.id === "C" ? { ...x, manual_overrides: { "anything": "TERMS AND CONDITIONS" } } : x);
  const sb = fakeSupabase(rows);
  const r = await revalidateTemplates({ supabase: sb, dryRun: false, extractPdfText: fakeExtract, now: fixedNow });
  assertEquals(r.rows.find((x) => x.id === "C")!.after?.status, "manual_validated");
});

Deno.test("force: a row with a current result is re-scanned too; template_ids restricts the pass", async () => {
  const sb = fakeSupabase(fixtureRows());
  const r = await revalidateTemplates({ supabase: sb, dryRun: true, force: true, templateIds: ["E"], extractPdfText: fakeExtract, now: fixedNow });
  assertEquals(r.scanned, 1);
  assertEquals(r.stale, 1);
  assertEquals(r.rows[0].id, "E");
  assertEquals(r.rows[0].after?.status, "manual_validated", "E carries manual_overrides");
  assertEquals(r.rows[0].after?.usable, true);
});

Deno.test("a parse failure is reported per row and does not abort the pass", async () => {
  const sb = fakeSupabase(fixtureRows());
  const throwingExtract = (bytes: Uint8Array) => {
    if (new TextDecoder().decode(bytes) === V2_TEXT) return Promise.reject(new Error("No PDF header found"));
    return fakeExtract(bytes);
  };
  const r = await revalidateTemplates({ supabase: sb, dryRun: false, extractPdfText: throwingExtract, now: fixedNow });
  assertStringIncludes(r.rows[0].error!, "Failed to parse PDF");
  assertEquals(r.rows[0].written, false);
  assertEquals(r.written, 2);
  assertEquals(r.errors, 2);
});
