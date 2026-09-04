// gh-1315 — the lifted manifest + scan. Same behaviour as the inline scan that
// lived in index.ts, plus the typographic-apostrophe fold found live.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MANIFEST, manifestSlotFor, normalizeForScan, scanOptionalAnchors, scanRequiredAnchors } from "./manifest.ts";
import { CURRENT_TEMPLATE_MANIFEST_VERSION } from "./template-validity.ts";

Deno.test("manifest: version comes from the shared constant; every slot's requiredCount matches its required list", () => {
  assertEquals(MANIFEST.version, CURRENT_TEMPLATE_MANIFEST_VERSION);
  for (const trade of Object.keys(MANIFEST.trades)) {
    for (const funding of Object.keys(MANIFEST.trades[trade])) {
      const slot = MANIFEST.trades[trade][funding];
      assertEquals(slot.required.length, slot.requiredCount, `${trade}/${funding}`);
      assertEquals(manifestSlotFor(trade.toUpperCase(), funding), slot, "lookup is case-insensitive");
    }
  }
  assertEquals(manifestSlotFor("roofing", "cash"), null);
});

Deno.test("scan: literal match, string override honoured only when present in the PDF, boolean override rejected", () => {
  const slot = MANIFEST.trades.roofing.retail;
  // deno-lint-ignore no-explicit-any
  const text = slot.required.map((r: any) => r.anchor).filter((a: string) => !a.startsWith("Workmanship")).join(" ") + " Labor Guarantee:";
  const plain = scanRequiredAnchors(text, slot);
  assertEquals(plain.filter((a) => a.found).length, slot.requiredCount - 1);
  const overridden = scanRequiredAnchors(text, slot, { "Workmanship Warranty:": "Labor Guarantee:" });
  assertEquals(overridden.filter((a) => a.found).length, slot.requiredCount);
  const w = overridden.find((a) => a.anchor === "Workmanship Warranty:")!;
  assertEquals(w.manualOverride, true);
  assertEquals(w.manualOverrideValue, "Labor Guarantee:");
  const bogus = scanRequiredAnchors(text, slot, { "Workmanship Warranty:": true });
  assertEquals(bogus.find((a) => a.anchor === "Workmanship Warranty:")!.found, false);
  const absent = scanRequiredAnchors(text, slot, { "Workmanship Warranty:": "Not In Document:" });
  assertEquals(absent.find((a) => a.anchor === "Workmanship Warranty:")!.found, false);
});

Deno.test("scan: a Word-style typographic apostrophe in \"Manufacturer’s Warranty:\" now matches (the live 12/13 template)", () => {
  const slot = MANIFEST.trades.roofing.retail;
  // deno-lint-ignore no-explicit-any
  const text = slot.required.map((r: any) => r.anchor).join(" ").replace("Manufacturer's", "Manufacturer’s");
  assert(text.includes("’"));
  const res = scanRequiredAnchors(text, slot);
  assertEquals(res.filter((a) => a.found).length, slot.requiredCount);
  assertEquals(normalizeForScan("“Owner’s” x"), "\"Owner's\" x");
});

Deno.test("scan: optional anchors are reported but never affect the required count", () => {
  const slot = MANIFEST.trades.roofing.retail;
  const opt = scanOptionalAnchors("Phone Email: nothing else", slot);
  assertEquals(opt.filter((o) => o.found).map((o) => o.anchor), ["Phone", "Email:"]);
});

Deno.test("scan: case-sensitive per manifest anchorOptions", () => {
  assertEquals(MANIFEST.anchorOptions.caseSensitive, true);
  const slot = MANIFEST.trades.gutters.retail;
  assertEquals(scanRequiredAnchors("linear feet: 120", slot).find((a) => a.anchor === "Linear Feet:")!.found, false);
  assertEquals(scanRequiredAnchors("Linear Feet: 120", slot).find((a) => a.anchor === "Linear Feet:")!.found, true);
});
