// [#1313 Part A, 2026-08-28] Cover for the three detectors and the two
// generated artifacts.
//
// The generator tests assert the thing that actually matters and is the issue's
// own close condition: every marker the validator requires for a slot is
// present in the extracted text of the PDF this file produces. They run the
// SAME scan the Edge Function runs (a case-sensitive substring test against
// pdfjs-extracted text), so a starter that passes here passes in production for
// the same reason.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import {
  buildExecutionPagePdf,
  appendExecutionPage,
  detectFilledProposal,
  describeMissingMarkers,
  cancellationNoticeState,
  fieldIdFromTag,
  type ManifestRequirement,
} from "./starter-template.ts";

// ─── the real v3 manifest and the Edge Function's own extractor ─────────────
// [gh-1315] Both now live in importable modules (manifest.ts, pdf-text.ts), so
// the source-slicing trick this test used to lift MANIFEST out of index.ts is
// gone: this test and the deployed validator import the same objects.
import { MANIFEST } from "./manifest.ts";
import { extractPdfText } from "./pdf-text.ts";

const SLOTS: Array<[string, string]> = [
  ["roofing", "retail"], ["roofing", "insurance"],
  ["siding", "retail"], ["siding", "insurance"],
  ["gutters", "retail"], ["windows", "retail"],
];

for (const [trade, funding] of SLOTS) {
  const slot = MANIFEST.trades?.[trade]?.[funding];
  if (!slot) continue;
  Deno.test(`starter ${trade}/${funding} carries every required marker`, async () => {
    const pdf = await buildExecutionPagePdf({
      trade, fundingType: funding,
      requirements: slot.required as ManifestRequirement[],
      companyName: "Indy Rooftops, LLC", standalone: true,
      manifestVersion: MANIFEST.version,
    });
    const text = await extractPdfText(pdf);
    const missing = (slot.required as ManifestRequirement[]).filter((r) => !text.includes(r.anchor));
    assertEquals(missing.map((m) => m.anchor), [], `${trade}/${funding} starter is missing markers`);
    assertEquals(slot.required.length, slot.requiredCount);
  });
}

Deno.test("the assisted path appends a tagged page and keeps every page of the contractor's own document", async () => {
  // Stand-in for Indy Rooftops' twelve-page filled proposal.
  const own = await PDFDocument.create();
  const font = await own.embedFont(StandardFonts.Helvetica);
  const p1 = own.addPage([612, 792]);
  p1.drawText("INDY ROOFTOPS, LLC - PROPOSAL", { x: 54, y: 720, size: 12, font });
  p1.drawText("Total Due  $544.78", { x: 54, y: 700, size: 10, font });
  p1.drawText("Mitchel Dotson: ______  Date: ______", { x: 54, y: 680, size: 10, font });
  for (let i = 0; i < 4; i++) {
    own.addPage([612, 792]).drawText("Indiana Terms and Conditions (cont.)", { x: 54, y: 720, size: 10, font });
  }
  const ownBytes = await own.save();

  const slot = MANIFEST.trades.roofing.retail;
  const tagged = await appendExecutionPage(ownBytes.slice(), {
    trade: "roofing", fundingType: "retail",
    requirements: slot.required, companyName: null, manifestVersion: MANIFEST.version,
  });

  assertEquals((await PDFDocument.load(tagged.slice())).getPageCount(), 6);
  const text = await extractPdfText(tagged);
  const missing = (slot.required as ManifestRequirement[]).filter((r) => !text.includes(r.anchor));
  assertEquals(missing.map((m) => m.anchor), []);
  // "we also aren't taking terms out, either" — his pages survive verbatim.
  assert(text.includes("Total Due"));
  assert(text.includes("Mitchel Dotson"));
  assert(text.includes("Indiana Terms and Conditions"));
});

Deno.test("filled-proposal detection fires on a priced proposal", () => {
  const v = detectFilledProposal(
    "INDY ROOFTOPS PROPOSAL Customer: Mitchel Dotson 5001 N County Road 1000 E, Brownsburg " +
    "Tear off 24.85 SQ Shingles 27.34 SQ Ice and water 186.33 LF Materials $312.40 Total Due $544.78",
    { companyName: "Indy Rooftops, LLC", addressLine1: "9 W Main St", addressCity: "Zionsville" },
  );
  assertEquals(v.detected, true);
  assert(v.signals.some((s) => s.kind === "money"));
  assert(v.signals.some((s) => s.kind === "address"));
  assert(v.signals.some((s) => s.kind === "quantities"));
});

Deno.test("the contractor's OWN letterhead address never accuses him", () => {
  // The street regex stops at the street-type token, so the hit reads
  // "5001 N County Road" while the stored address reads "5001 N County Road
  // 1000 E". A one-way includes() missed that on the first run.
  const text = "INDY ROOFTOPS 5001 N County Road 1000 E, Brownsburg IN. Decking $______ per sheet.";
  const v = detectFilledProposal(text, { addressLine1: "5001 N County Road 1000 E", addressCity: "Brownsburg" });
  assertEquals(v.signals.filter((s) => s.kind === "address").length, 0);
});

Deno.test("a genuine blank starter does not trip the detector", async () => {
  const pdf = await buildExecutionPagePdf({
    trade: "roofing", fundingType: "retail",
    requirements: MANIFEST.trades.roofing.retail.required,
    companyName: "Indy Rooftops, LLC", standalone: true, manifestVersion: MANIFEST.version,
  });
  const v = detectFilledProposal(await extractPdfText(pdf), { companyName: "Indy Rooftops, LLC" });
  assertEquals(v.detected, false);
  assertEquals(v.signals, []);
});

Deno.test("one signal alone is not enough to call something a filled proposal", () => {
  // A fee schedule printed in a blank template is one money signal and must not
  // be enough on its own: a false accusation here means a contractor who cannot
  // onboard at all.
  assertEquals(detectFilledProposal("Permit fee $150.00 Dumpster fee $400.00").detected, false);
});

Deno.test("the starter's own placeholder is never mistaken for a Notice of Cancellation", async () => {
  const pdf = await buildExecutionPagePdf({
    trade: "roofing", fundingType: "retail",
    requirements: MANIFEST.trades.roofing.retail.required,
    companyName: null, standalone: true, manifestVersion: MANIFEST.version,
  });
  // The placeholder block contains the phrase, so a bare phrase test reported
  // "present" and would have told a contractor his notice was fine when the
  // document held an instruction to write one.
  assertEquals(cancellationNoticeState(await extractPdfText(pdf)), "placeholder");
  assertEquals(cancellationNoticeState("... your NOTICE OF CANCELLATION ... you may cancel ..."), "present");
  assertEquals(cancellationNoticeState("Terms and conditions only."), "absent");
});

Deno.test("every missing marker comes back with a name, a place and something to paste", () => {
  const slot = MANIFEST.trades.roofing.retail;
  // deno-lint-ignore no-explicit-any
  const zero = (slot.required as any[]).map((r) => ({ anchor: r.anchor, mechanism: r.mechanism, found: false, field: r.field }));
  const described = describeMissingMarkers(zero);
  assertEquals(described.length, slot.required.length);
  for (const d of described) {
    assert(d.name.length > 0, "every marker has a human name");
    assert(d.where.length > 0, "every marker says where it belongs");
    assert(d.why.length > 0, "every marker says why it is needed");
    assertEquals(d.example, d.anchor, "the example is the literal string to paste");
    // Nothing may fall back to the raw tag as its display name — that is the
    // exact failure #1313 was filed about.
    assert(!d.name.startsWith("{{"), `raw tag leaked as a name: ${d.name}`);
  }
  assertEquals(describeMissingMarkers(zero.map((z) => ({ ...z, found: true }))), []);
});

Deno.test("field ids parse out of tags, and label_text markers have none", () => {
  assertEquals(fieldIdFromTag("{{text|1|*|Contract Price|contract_price}}"), "contract_price");
  assertEquals(fieldIdFromTag("{{sign|2|*|Homeowner Signature|homeowner_signature}}"), "homeowner_signature");
  assertEquals(fieldIdFromTag("Manufacturer's Warranty:"), null);
});
