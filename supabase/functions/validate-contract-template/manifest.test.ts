// gh-1315 — the lifted manifest + scan. Same behaviour as the inline scan that
// lived in index.ts, plus the typographic-apostrophe fold found live.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

// ─────────────────────────────────────────────────────────────────────────────
// gh-1314 — BoldSign cannot create a document from a sign/init/date tag with a label.
// The manifest must demand the EMPTY-label form and the scan must reject the labeled one.
import { scanLabeledSignTags, tag } from "./manifest.ts";

// The pre-fix manifest, rebuilt as the negative control: identical anchors, labeled sign/date form.
const OLD_LABELS: Record<string, string> = {
  homeowner_signature: "Homeowner Signature",
  homeowner_signature_date: "Homeowner Sign Date",
  contractor_signature: "Contractor Signature",
  contractor_signature_date: "Contractor Sign Date",
};
// deno-lint-ignore no-explicit-any
function oldSlot(slot: any): any {
  return {
    ...slot,
    // deno-lint-ignore no-explicit-any
    required: slot.required.map((r: any) => {
      const m = /^\{\{(sign|date)\|(\d)\|\*\|\|(\w+)\}\}$/.exec(r.anchor);
      return m ? { ...r, anchor: `{{${m[1]}|${m[2]}|*|${OLD_LABELS[m[3]]}|${m[3]}}}` } : r;
    }),
  };
}

Deno.test("gh-1314 manifest: every sign/init/date anchor in every slot is the empty-label form; text anchors keep labels", () => {
  let signDate = 0, labeledText = 0;
  for (const trade of Object.keys(MANIFEST.trades)) {
    for (const funding of Object.keys(MANIFEST.trades[trade])) {
      // deno-lint-ignore no-explicit-any
      for (const r of MANIFEST.trades[trade][funding].required as any[]) {
        if (r.mechanism !== "boldsign_tag") continue;
        if (r.tabType === "sign" || r.tabType === "date" || r.tabType === "init") {
          signDate++;
          assert(/^\{\{(sign|date|init)\|[12]\|\*\|\|\w+\}\}$/.test(r.anchor), `${trade}/${funding}: ${r.anchor}`);
        } else if (/^\{\{text\|[12]\|\*\|[^|]+\|\w+\}\}$/.test(r.anchor)) {
          labeledText++;
        }
      }
    }
  }
  assert(signDate >= 32, `expected 32 sign/date anchors, saw ${signDate}`);
  assert(labeledText > 0, "text tags keep their labels");
  assertEquals(MANIFEST.trades.roofing.retail.required[2].anchor, "{{sign|1|*||contractor_signature}}");
});

Deno.test("gh-1314 manifest: a PDF carrying the empty-label sign/date tags passes all required anchors", () => {
  const slot = MANIFEST.trades.roofing.retail;
  // deno-lint-ignore no-explicit-any
  const text = slot.required.map((r: any) => r.anchor).join(" ");
  assertEquals(scanRequiredAnchors(text, slot).filter((a) => a.found).length, slot.requiredCount);
  assertEquals(scanLabeledSignTags(text), []);
});

Deno.test("gh-1314 manifest: the LABELED form is rejected, naming the tag (and the old manifest accepted it: negative control)", () => {
  const slot = MANIFEST.trades.roofing.retail;
  const old = oldSlot(slot);
  // deno-lint-ignore no-explicit-any
  const labeledText = old.required.map((r: any) => r.anchor).join(" ");
  assertStringIncludes(labeledText, "{{sign|1|*|Contractor Signature|contractor_signature}}");
  // CONTROL: the pre-fix manifest accepted this exact text 13/13 (the "13/13 but unsignable" state).
  assertEquals(scanRequiredAnchors(labeledText, old).filter((a) => a.found).length, old.requiredCount);
  // FIX: the new manifest does not find the 4 sign/date anchors in that text...
  const res = scanRequiredAnchors(labeledText, slot);
  assertEquals(res.filter((a) => !a.found).map((a) => a.anchor).sort(), [
    "{{date|1|*||contractor_signature_date}}",
    "{{date|2|*||homeowner_signature_date}}",
    "{{sign|1|*||contractor_signature}}",
    "{{sign|2|*||homeowner_signature}}",
  ]);
  // ...and names each labeled tag with the fix.
  const v = scanLabeledSignTags(labeledText);
  assertEquals(v.length, 4);
  assertEquals(v.map((x) => x.tag).sort(), [
    "{{date|1|*|Contractor Sign Date|contractor_signature_date}}",
    "{{date|2|*|Homeowner Sign Date|homeowner_signature_date}}",
    "{{sign|1|*|Contractor Signature|contractor_signature}}",
    "{{sign|2|*|Homeowner Signature|homeowner_signature}}",
  ]);
  assertStringIncludes(v[0].message, "{{sign|2|*||homeowner_signature}}");
});

Deno.test("gh-1314 manifest: a manual override cannot smuggle a labeled sign tag past the scan", () => {
  const slot = MANIFEST.trades.roofing.retail;
  const labeled = "{{sign|1|*|Contractor Signature|contractor_signature}}";
  // The override "finds" the anchor (it is present in the PDF text)...
  const res = scanRequiredAnchors(labeled, slot, { "{{sign|1|*||contractor_signature}}": labeled });
  assertEquals(res.find((a) => a.anchor === "{{sign|1|*||contractor_signature}}")!.found, true);
  // ...but the lint still flags it, and the validator ANDs allRequiredFound with "no labeled tags".
  assertEquals(scanLabeledSignTags(labeled).length, 1);
});

Deno.test("gh-1314 tag(): refuses a non-empty label for sign/init/date; text keeps its label", () => {
  assertEquals(tag("sign", 1, true, "", "contractor_signature"), "{{sign|1|*||contractor_signature}}");
  assertEquals(tag("text", 1, true, "Customer Name", "customer_name"), "{{text|1|*|Customer Name|customer_name}}");
  for (const t of ["sign", "init", "date"] as const) {
    let threw = false;
    try { tag(t, 1, true, "A Label", "x"); } catch (e) { threw = String((e as Error).message).includes("empty label"); }
    assert(threw, `${t} with a label must throw`);
  }
});
