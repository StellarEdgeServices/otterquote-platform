// gh-1759 — the evidence call must carry TEXT only. Observed failure on production
// 2026-10-07: Stripe answered "No such file_upload: 'TRANSACTION RECORD ...'" because
// prose was sent in file-typed evidence fields. See dispute-evidence-fields.ts.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  assembleTextEvidence,
  FILE_TYPED_EVIDENCE_FIELDS,
  fileTypedKeysIn,
  PRODUCT_DESCRIPTION_MAX,
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
  // Stripe: product_description and uncategorized_text are each maxLength 20000 (150000 is the combined limit).
  assertEquals(UNCATEGORIZED_TEXT_MAX, 20_000);
  assertEquals(PRODUCT_DESCRIPTION_MAX, 20_000);
  const ev = assembleTextEvidence({
    ...sample,
    productDescription: "p".repeat(PRODUCT_DESCRIPTION_MAX + 5000),
    serviceDocumentation: "x".repeat(UNCATEGORIZED_TEXT_MAX + 5000),
  });
  assertEquals(ev["evidence[uncategorized_text]"].length, 20_000);
  assertEquals(ev["evidence[product_description]"].length, 20_000);
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
  // gate 2 is untouched: submit is still decided via maySubmitFinalEvidence, now reached
  // through applySubmitDecision (gh-2794 gate 3 wraps it)
  assert(/(maySubmitFinalEvidence\(\{|applySubmitDecision\()/.test(src));
});

Deno.test("gh-1759: a livemode=false dispute never reaches createClickUpTask (Ben, comment 6069379782)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const guard = src.indexOf("if (event.livemode === false) {");
  const call = src.indexOf("await createClickUpTask({");
  assert(guard !== -1 && call !== -1, "guard and call must both exist");
  assert(guard < call, "the livemode check must come before the ClickUp call");
  // the call must sit in the branch after the guard (else-if chain), not before it
  assert(/\} else if \(!clickupKey\) \{/.test(src), "ClickUp call must be in the else chain of the livemode guard");
});

Deno.test("gh-1759 REVIEW-FIX: evidence prose carries no vendor name, no 'homeowner pays nothing', no measurements-in-fee, no net-new build, no invented email terms", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = src.indexOf("function buildEvidencePayload");
  const end = src.indexOf("maySubmitFinalEvidence({", start);
  const body = src.slice(start, end);
  for (const bad of ["DocuSign", "BoldSign", "pays nothing", "measurements", "net-new build for Mark", "Mark Complete dashboard flow", "within 24 hours", "rescission link", "reference to the invoice", "was sent upon bid submission"]) {
    assert(!body.includes(bad), `buildEvidencePayload still contains: ${bad}`);
  }
  // fallback branch must not claim an email was sent
  const fb = body.slice(body.indexOf(": \"Fee acceptance record could not be retrieved"));
  assert(!/email/i.test(fb.slice(0, 120)), "fallback must say nothing about an email");
});
