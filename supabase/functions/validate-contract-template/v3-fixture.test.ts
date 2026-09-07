// [gh-1761, closes on artifact for #1315 RUN 27] Regression guard for the v3
// roofing/retail manifest.
//
// Until this test existed, `contractor_templates` held 12 rows and 0 had ever
// validated under the v3 manifest (D-274, `MANIFEST.version === "v3"`) — no
// document of any kind (production, fixture or test) had been shown to
// satisfy the v3 roofing/retail manifest in full. The fixture committed
// alongside this test (`./__fixtures__/otterquote-v3-reference-roofing-retail.pdf`,
// built deterministically by `./__fixtures__/build_template.py`) is that
// document. This test is the guard the manifest never had: bump
// MANIFEST.trades.roofing.retail.required (add, remove, or edit an anchor)
// and this test fails until a satisfying document exists again. Before this
// test, the manifest could be bumped to anything and nothing would notice.
//
// Does NOT import index.ts directly. index.ts calls Deno.serve(...) at
// module scope (needs --allow-net to bind) and Deno.env.get(...) inside the
// handler (needs --allow-env), but the gh-422 pure-unit lane runs
// `deno test --allow-read=supabase/functions supabase/functions/` with
// neither flag (see .github/workflows/e2e-tests.yml and this directory's
// guard-order.test.ts header for the fuller rationale). So, following the
// exact technique starter-template.test.ts already established for this
// same constraint:
//   - MANIFEST is lifted OUT of index.ts by locating its literal source
//     (string search + brace-depth matching) and dynamically importing that
//     slice via a data: URL — the real manifest, never a hand-copied value.
//   - extractPdfText is index.ts's own function, duplicated verbatim below
//     (byte-for-byte the same body as index.ts's extractPdfText) because it
//     is not exported and index.ts cannot be imported under this constraint.
//     This is NOT scan.mjs's offline replica from `In Flight/gh1315-cto27/`
//     — that script was a diagnosis-only tool built separately (documented on
//     #1761) and is not read or exercised anywhere in this file.
//   - fieldIdFromTag is imported directly from ./starter-template.ts — a real,
//     exported repo function, not a copy. (#1761's Work section names this
//     function "fieldIdFromAnchor"; no function of that name exists anywhere
//     in the repo. fieldIdFromTag is the real, already-exported equivalent —
//     it parses a BoldSign field id out of a `{{...}}` tag string, which is
//     exactly what the issue asks this test to prove for contract_price.)
// The required-anchor scan itself (`text.includes(anchor)`) is reproduced
// below as a tiny local helper mirroring index.ts's inline `.map()` scan in
// its Deno.serve handler verbatim — there is no standalone
// `scanRequiredAnchors` function anywhere in the repo to import (the scan is
// inline request-handling logic, not a function), so none can be imported by
// name; the predicate it reproduces is exactly index.ts's own.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as pdfjsLib from "npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs";
import "npm:pdfjs-dist@4.0.379/legacy/build/pdf.worker.mjs";
import { fieldIdFromTag } from "./starter-template.ts";

// ─── the real v3 manifest, lifted out of index.ts (same technique as starter-template.test.ts) ───
const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const tagFn = src.slice(src.indexOf("function tag("), src.indexOf("const CONTRACTOR_IDX"));
const mStart = src.indexOf("const MANIFEST: any = {");
let depth = 0, mEnd = -1;
for (let i = src.indexOf("{", mStart); i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { mEnd = i + 1; break; } }
}
const modSrc = tagFn + "\nconst CONTRACTOR_IDX = 1;\nconst HOMEOWNER_IDX = 2;\n" +
  src.slice(mStart, mEnd) + ";\nexport { MANIFEST };\n";
// deno-lint-ignore no-explicit-any
const { MANIFEST } = await import("data:application/typescript," + encodeURIComponent(modSrc)) as any;

// ─── index.ts's own extractPdfText, duplicated verbatim (see file header) ───
async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  // deno-lint-ignore no-explicit-any
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = "";
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(), isEvalSupported: false, disableFontFace: true }).promise;
  let full = "";
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    // deno-lint-ignore no-explicit-any
    full += tc.items.map((it: any) => it.str ?? "").join(" ") + "\n";
  }
  return full;
}

// ─── index.ts's own required-anchor scan, reproduced verbatim (see file header) ───
function scanRequiredAnchors(
  text: string,
  required: Array<{ anchor: string }>,
): { requiredFoundCount: number; requiredCount: number } {
  const requiredFoundCount = required.filter((r) => text.includes(r.anchor)).length;
  return { requiredFoundCount, requiredCount: required.length };
}

const FIXTURE_PDF_URL = new URL(
  "./__fixtures__/otterquote-v3-reference-roofing-retail.pdf",
  import.meta.url,
);

Deno.test("v3 roofing/retail fixture: every required anchor is found by the repo's own extractor + manifest (13/13)", async () => {
  const pdfBytes = await Deno.readFile(FIXTURE_PDF_URL);
  const text = await extractPdfText(pdfBytes);
  const slot = MANIFEST.trades.roofing.retail;

  assertEquals(
    slot.requiredCount,
    13,
    "roofing/retail requiredCount drifted from 13 — this test's premise (and #1761's) needs updating",
  );

  const { requiredFoundCount, requiredCount } = scanRequiredAnchors(text, slot.required);
  assertEquals(
    requiredFoundCount,
    requiredCount,
    `fixture no longer satisfies every required v3 roofing/retail anchor (${requiredFoundCount}/${requiredCount} found) — ` +
      `the manifest changed without a satisfying document; see #1761`,
  );
});

Deno.test("v3 roofing/retail fixture: the found contract_price anchor resolves to field id 'contract_price' via fieldIdFromTag", async () => {
  const pdfBytes = await Deno.readFile(FIXTURE_PDF_URL);
  const text = await extractPdfText(pdfBytes);
  const slot = MANIFEST.trades.roofing.retail;

  // deno-lint-ignore no-explicit-any
  const priceReq = (slot.required as any[]).find((r) => fieldIdFromTag(r.anchor) === "contract_price");
  if (!priceReq) {
    throw new Error(
      "no required anchor in the v3 roofing/retail manifest resolves to field id 'contract_price' via fieldIdFromTag",
    );
  }
  assertEquals(text.includes(priceReq.anchor), true, "contract_price anchor not found in fixture text");
  assertEquals(fieldIdFromTag(priceReq.anchor), "contract_price");
});
