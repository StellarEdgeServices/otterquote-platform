// gh-1759 — the evidence call must carry TEXT only. Observed failure on production
// 2026-10-07: Stripe answered "No such file_upload: 'TRANSACTION RECORD ...'" because
// prose was sent in file-typed evidence fields. See dispute-evidence-fields.ts.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  assembleTextEvidence,
  FILE_TYPED_EVIDENCE_FIELDS,
  fileTypedKeysIn,
  UNCATEGORIZED_TEXT_MAX,
} from "./dispute-evidence-fields.ts";

const sample = {
  productDescription: "Otter Quotes platform fee.",
  serviceDocumentation: "TRANSACTION RECORD — Otter Quotes Platform Fee\nDispute ID: dp_1",
  customerCommunication: "Bid confirmation email sent. Invoice URL (D-215 Layer 3): https://x.test/inv",
};

Deno.test("gh-1759: assembled evidence contains no file-typed key", () => {
  const ev = assembleTextEvidence(sample);
  assertEquals(fileTypedKeysIn(ev), []);
  assertEquals(Object.keys(ev).sort(), ["evidence[product_description]", "evidence[uncategorized_text]"]);
});

Deno.test("gh-1759: the prose reaches Stripe, in the text field", () => {
  const ev = assembleTextEvidence(sample);
  assert(ev["evidence[uncategorized_text]"].includes("TRANSACTION RECORD — Otter Quotes Platform Fee"));
  assert(ev["evidence[uncategorized_text]"].includes("https://x.test/inv"));
});

Deno.test("gh-1759: text is clipped to Stripe's limit rather than rejected", () => {
  const ev = assembleTextEvidence({ ...sample, serviceDocumentation: "x".repeat(UNCATEGORIZED_TEXT_MAX + 5000) });
  assertEquals(ev["evidence[uncategorized_text]"].length, UNCATEGORIZED_TEXT_MAX);
});

Deno.test("gh-1759 NEGATIVE CONTROL: the pre-fix payload shape is detected as file-typed", () => {
  const preFix = {
    "evidence[product_description]": "a",
    "evidence[service_documentation]": "TRANSACTION RECORD ...",
    "evidence[customer_communication]": "b",
    "evidence[receipt]": "https://x.test/inv",
  };
  assertEquals(fileTypedKeysIn(preFix).sort(), [
    "evidence[customer_communication]",
    "evidence[receipt]",
    "evidence[service_documentation]",
  ]);
  assert(FILE_TYPED_EVIDENCE_FIELDS.has("service_documentation"));
});

Deno.test("gh-1759: index.ts builds its evidence through assembleTextEvidence and names no file field", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(/assembleTextEvidence\(\{/.test(src), "buildEvidencePayload must use assembleTextEvidence");
  for (const f of FILE_TYPED_EVIDENCE_FIELDS) {
    assert(
      !src.includes(`"evidence[${f}]"`),
      `index.ts sets evidence[${f}], a Stripe FILE field; prose/URLs are rejected there`,
    );
  }
  // gate 2 is untouched: submit still set only via maySubmitFinalEvidence
  assert(/maySubmitFinalEvidence\(\{/.test(src));
});
