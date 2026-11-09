// gh-3287 (D-407 6/8): the webhook keeps recognising Project Confirmation / colour envelopes that
// already exist, and never lets them into a contract branch. It also creates no envelope of any kind.
// Run: deno test -A supabase/functions/docusign-webhook/envelope-kind.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { classifyEnvelope } from "./envelope-kind.ts";

const claim = { docusign_envelope_id: "doc-contract", color_confirmation_envelope_id: "doc-colour", project_confirmation_envelope_id: "doc-pc" };

Deno.test("a contract envelope is the contract", () => {
  assertEquals(classifyEnvelope(claim, "doc-contract"), "contract");
});

Deno.test("an existing colour envelope is handled as retired history, not as the contract", () => {
  assertEquals(classifyEnvelope(claim, "doc-colour"), "retired_color_confirmation");
});

Deno.test("an existing Project Confirmation envelope is handled as retired history, not as the contract", () => {
  assertEquals(classifyEnvelope(claim, "doc-pc"), "retired_project_confirmation");
});

Deno.test("contract wins when one id sits in several columns (a signed contract still completes)", () => {
  assertEquals(classifyEnvelope({ ...claim, color_confirmation_envelope_id: "doc-contract", project_confirmation_envelope_id: "doc-contract" }, "doc-contract"), "contract");
});

Deno.test("null pointers (post-D-407 claims) never match a null/undefined envelope id", () => {
  const post = { docusign_envelope_id: "doc-contract", color_confirmation_envelope_id: null, project_confirmation_envelope_id: null };
  assertEquals(classifyEnvelope(post, "doc-contract"), "contract");
  assertEquals(classifyEnvelope(post, null), "unmatched");
  assertEquals(classifyEnvelope(post, undefined), "unmatched");
  assertEquals(classifyEnvelope({ docusign_envelope_id: null }, "x"), "unmatched");
  assertEquals(classifyEnvelope(null, "x"), "unmatched");
});

Deno.test("an id in no column is unmatched", () => {
  assertEquals(classifyEnvelope(claim, "doc-other"), "unmatched");
});

// ---- wiring in index.ts (serve() runs at import time, so read it as text) ----
const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

Deno.test("wiring: index.ts derives isContract / isColorConfirmation / isProjectConfirmation from classifyEnvelope", () => {
  assert(code.includes("const envelopeKind = classifyEnvelope(claim, envelopeId);"));
  assert(code.includes('const isContract = envelopeKind === "contract";'));
  assert(code.includes('envelopeKind === "retired_color_confirmation"'));
  assert(code.includes('envelopeKind === "retired_project_confirmation"'));
});

Deno.test("wiring: an unmatched envelope answers 200 and returns before any claim write or contract branch", () => {
  const unmatched = code.indexOf('if (envelopeKind === "unmatched") {');
  assert(unmatched !== -1);
  const body = code.slice(unmatched, unmatched + 500);
  assert(body.includes("status: 200") && body.includes("return new Response("));
  assert(unmatched < code.indexOf("const updateData: Record<string, any> = {};"));
  assert(unmatched < code.indexOf("if (isContract) {"));
});

Deno.test("wiring: retired envelopes only ever write their own history column, inside the completed branch, after the contract branch", () => {
  const colour = code.indexOf("} else if (isColorConfirmation) {");
  const pc = code.indexOf("} else if (isProjectConfirmation) {");
  const completed = code.indexOf('if (status === "completed") {');
  const contractBranch = code.indexOf("if (isContract) {", completed);
  assert(completed < contractBranch && contractBranch < colour && colour < pc);
  assert(code.slice(colour, pc).includes("updateData.color_confirmed_at"));
  assert(!/updateData\.(contract_signed|status|contract_signed_at)/.test(code.slice(colour, code.indexOf('} else if (status === "declined")', pc))));
});

Deno.test("wiring: the webhook creates no envelope (no BoldSign send, no create-docusign-envelope call)", () => {
  assert(!code.includes("/v1/document/send"), "the webhook must not send documents");
  assert(!code.includes("create-docusign-envelope"), "the webhook must not call the envelope function");
  // create-payment-intent / create-invoice are the post-signature charge and invoice calls, not envelopes.
  assert(!/functions\/v1\/create-(docusign|envelope|boldsign)/.test(code), "the webhook must not call an envelope-creating function");
});
