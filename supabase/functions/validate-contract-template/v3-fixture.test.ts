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
// [gh-1315 / #1664] This file used to lift MANIFEST out of index.ts by string
// search + brace matching and dynamically import the slice via a data: URL,
// because index.ts calls Deno.serve(...) at module scope and the gh-422
// pure-unit lane runs with no --allow-net. #1664 removed the need for that
// hack: MANIFEST, the `tag` builder, the SignerIndex constants and the
// required-anchor scan now live in ./manifest.ts, and extractPdfText in
// ./pdf-text.ts — both pure, IO-free modules with no Deno.serve at module
// scope. The lift is now not just unnecessary but broken (`const MANIFEST` no
// longer appears in index.ts, so the slice was empty and the data: module
// exported nothing: "SyntaxError: Export 'MANIFEST' is not defined in module").
// Everything below imports the real repo functions directly — the same move
// #1664 already made in starter-template.test.ts and revalidate.test.ts — so
// there is nothing left in this file to drift out of sync with index.ts.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MANIFEST, scanRequiredAnchors } from "./manifest.ts";
import { extractPdfText } from "./pdf-text.ts";
import { fieldIdFromTag } from "./starter-template.ts";

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

  const results = scanRequiredAnchors(text, slot);
  const requiredFoundCount = results.filter((r) => r.found).length;
  const requiredCount = results.length;
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
