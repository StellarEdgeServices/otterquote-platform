// Deno unit tests for the D-269 (#550) acknowledgment backstop evaluation.
// Run: deno test supabase/functions/docusign-webhook/ack-verify.test.ts
//
// Regression contract (issue #550 AC): an unchecked/unsigned
// otterquote_acknowledgment must NOT evaluate as satisfied — the webhook
// halts the clean contract_signed/charge path on any "defect" verdict.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { ACK_TAB_LABEL, evaluateAcknowledgment } from "./ack-verify.ts";

const signer = (tabs?: Record<string, unknown>) => ({
  clientUserId: "homeowner_1",
  status: "completed",
  ...(tabs ? { tabs } : {}),
});

Deno.test("signHere ack signed → satisfied (D-123 current envelopes)", () => {
  const ev = evaluateAcknowledgment([
    signer({ signHereTabs: [{ tabLabel: ACK_TAB_LABEL, status: "signed" }] }),
  ]);
  assertEquals(ev.state, "satisfied");
  assertEquals((ev as { via: string }).via, "signhere");
});

Deno.test("signHere ack NOT signed → defect (the D-269 invariant)", () => {
  const ev = evaluateAcknowledgment([
    signer({ signHereTabs: [{ tabLabel: ACK_TAB_LABEL, status: "active" }] }),
  ]);
  assertEquals(ev.state, "defect");
  assertEquals((ev as { via: string }).via, "signhere");
});

Deno.test("signHere ack with absent status → defect, not satisfied", () => {
  const ev = evaluateAcknowledgment([
    signer({ signHereTabs: [{ tabLabel: ACK_TAB_LABEL }] }),
  ]);
  assertEquals(ev.state, "defect");
});

Deno.test("anchor stamped the tab twice — one unsigned → defect (all must be signed)", () => {
  const ev = evaluateAcknowledgment([
    signer({
      signHereTabs: [
        { tabLabel: ACK_TAB_LABEL, status: "signed" },
        { tabLabel: ACK_TAB_LABEL, status: "active" },
      ],
    }),
  ]);
  assertEquals(ev.state, "defect");
});

Deno.test("legacy checkbox ack selected=true → satisfied (pre-D-123 envelopes)", () => {
  const ev = evaluateAcknowledgment([
    signer({ checkboxTabs: [{ tabLabel: ACK_TAB_LABEL, selected: "true" }] }),
  ]);
  assertEquals(ev.state, "satisfied");
  assertEquals((ev as { via: string }).via, "checkbox");
});

Deno.test("legacy checkbox ack selected=false → defect (the 2026-05-20 incident shape)", () => {
  const ev = evaluateAcknowledgment([
    signer({ checkboxTabs: [{ tabLabel: ACK_TAB_LABEL, selected: "false" }] }),
  ]);
  assertEquals(ev.state, "defect");
  assertEquals((ev as { via: string }).via, "checkbox");
});

Deno.test("tab data present but no ack tab anywhere → defect (tab_missing)", () => {
  const ev = evaluateAcknowledgment([
    signer({ signHereTabs: [{ tabLabel: "cancellation_acknowledgment_signature", status: "signed" }] }),
    { clientUserId: "contractor_1", tabs: { signHereTabs: [] } },
  ]);
  assertEquals(ev.state, "defect");
  assertEquals((ev as { via: string }).via, "tab_missing");
});

Deno.test("no tab data on any signer → indeterminate (caller queries the API)", () => {
  const ev = evaluateAcknowledgment([signer(), { clientUserId: "contractor_1" }]);
  assertEquals(ev.state, "indeterminate");
});

Deno.test("empty/absent signers → indeterminate", () => {
  assertEquals(evaluateAcknowledgment([]).state, "indeterminate");
  assertEquals(evaluateAcknowledgment(undefined as unknown as unknown[]).state, "indeterminate");
});

Deno.test("ack on a different signer still counts (signer-agnostic scan)", () => {
  const ev = evaluateAcknowledgment([
    { clientUserId: "contractor_1", tabs: { signHereTabs: [] } },
    signer({ signHereTabs: [{ tabLabel: ACK_TAB_LABEL, status: "signed" }] }),
  ]);
  assertEquals(ev.state, "satisfied");
});

Deno.test("mixed: unrelated checkbox checked but ack signHere unsigned → defect", () => {
  const ev = evaluateAcknowledgment([
    signer({
      checkboxTabs: [{ tabLabel: "some_other_box", selected: "true" }],
      signHereTabs: [{ tabLabel: ACK_TAB_LABEL, status: "declined" }],
    }),
  ]);
  assertEquals(ev.state, "defect");
});
