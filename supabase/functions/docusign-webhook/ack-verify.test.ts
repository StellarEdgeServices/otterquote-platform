// Deno unit tests for the BoldSign D-269 acknowledgment backstop.
// Run: deno test supabase/functions/docusign-webhook/ack-verify.test.ts
//
// [D-274 / #631] Replaces the DocuSign signHere/checkbox tab tests with tests
// against BoldSign's formFields shape (GET /v1/document/properties).

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { evaluateAcknowledgment, ACK_FIELD_ID } from "./ack-verify.ts";

Deno.test("satisfied — field present with truthy value", () => {
  const result = evaluateAcknowledgment([
    { clientUserId: "homeowner_1", formFields: [{ id: ACK_FIELD_ID, value: "signed" }] },
  ]);
  assertEquals(result.state, "satisfied");
});

Deno.test("satisfied — field present with status indicating completion, empty value", () => {
  const result = evaluateAcknowledgment([
    { clientUserId: "homeowner_1", formFields: [{ id: ACK_FIELD_ID, value: null, status: "Completed" }] },
  ]);
  assertEquals(result.state, "satisfied");
});

Deno.test("defect — field present but neither value nor status indicates completion", () => {
  const result = evaluateAcknowledgment([
    { clientUserId: "homeowner_1", formFields: [{ id: ACK_FIELD_ID, value: null, status: "NotCompleted" }] },
  ]);
  assertEquals(result.state, "defect");
  if (result.state === "defect") assertEquals(result.via, "field");
});

Deno.test("defect (field_missing) — formFields data present but no matching id anywhere", () => {
  const result = evaluateAcknowledgment([
    { clientUserId: "homeowner_1", formFields: [{ id: "some_other_field", value: "x" }] },
    { clientUserId: "contractor_1", formFields: [{ id: "another_field", value: "y" }] },
  ]);
  assertEquals(result.state, "defect");
  if (result.state === "defect") assertEquals(result.via, "field_missing");
});

Deno.test("indeterminate — no signer carries any formFields data", () => {
  const result = evaluateAcknowledgment([
    { clientUserId: "homeowner_1" },
    { clientUserId: "contractor_1", formFields: [] },
  ]);
  assertEquals(result.state, "indeterminate");
});

Deno.test("indeterminate — empty signers array", () => {
  const result = evaluateAcknowledgment([]);
  assertEquals(result.state, "indeterminate");
});

Deno.test("satisfied — field found on a non-first signer", () => {
  const result = evaluateAcknowledgment([
    { clientUserId: "contractor_1", formFields: [{ id: "contract_price", value: "$1,000" }] },
    { clientUserId: "homeowner_1", formFields: [{ id: ACK_FIELD_ID, value: "signed" }] },
  ]);
  assertEquals(result.state, "satisfied");
});

Deno.test("defect — multiple matching-id entries, one unsatisfied", () => {
  // Should not realistically happen (FieldID is documented as required-unique
  // by BoldSign) but the evaluator must not silently ignore a second entry.
  const result = evaluateAcknowledgment([
    { clientUserId: "homeowner_1", formFields: [{ id: ACK_FIELD_ID, value: "signed" }] },
    { clientUserId: "contractor_1", formFields: [{ id: ACK_FIELD_ID, value: null }] },
  ]);
  assertEquals(result.state, "defect");
});
