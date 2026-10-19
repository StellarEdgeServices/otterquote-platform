// gh-2559 / D-390: when the homeowner's typed text is redacted for the selected contractor, and that it fails closed. The patterns themselves are
// proved in Postgres (supabase/tests/gh2559_d390_redact_proof.sql); here the rpc is a fake that records what it was asked.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { homeownerTextForContractor, REMOVED_TOKEN, redactContactOrRefuse, RedactionUnavailableError } from "./homeowner-text-redact.ts";

function fake(result: { data: unknown; error: unknown } | "throw") {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (result === "throw") throw new Error("network down");
        return Promise.resolve(result as { data: unknown; error: unknown });
      },
    },
  };
}

Deno.test("fee collected: the text goes through as typed and the rpc is not called", async () => {
  const f = fake({ data: "SHOULD NOT BE USED", error: null });
  assertEquals(await homeownerTextForContractor(f.client, "call 317-555-0142", true), "call 317-555-0142");
  assertEquals(f.calls.length, 0);
});

Deno.test("fee not collected: the redacted text from d390_redact_contact is returned", async () => {
  const f = fake({ data: "call [removed]", error: null });
  assertEquals(await homeownerTextForContractor(f.client, "call 317-555-0142", false), "call [removed]");
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].fn, "d390_redact_contact");
  assertEquals(f.calls[0].args.p_text, "call 317-555-0142");
});

Deno.test("anything that is not exactly true redacts (the column is nullable)", async () => {
  // deno-lint-ignore no-explicit-any
  for (const flag of [false, null, undefined, "true", 1] as any[]) {
    const f = fake({ data: "[removed]", error: null });
    assertEquals(await homeownerTextForContractor(f.client, "x@y.com", flag), "[removed]", String(flag));
    assertEquals(f.calls.length, 1);
  }
});

const FAILURES = [{ data: null, error: { message: "boom" } }, { data: null, error: null }, { data: 42, error: null }, "throw" as const];

Deno.test("NEGATIVE CONTROL (e-mail preview): a failing rpc gives the success-path token [removed], never the typed text, never any fee or Notes wording", async () => {
  assertEquals(REMOVED_TOKEN, "[removed]");
  for (const r of FAILURES) {
    const f = fake(r);
    const out = await homeownerTextForContractor(f.client, "call 317-555-0142", false);
    assertEquals(out, "[removed]");
    assert(!String(out).includes("317"));
    assert(!/fee|notes|withheld/i.test(String(out)), "no fee reference and never the word Notes");
  }
});

Deno.test("NEGATIVE CONTROL (Scope of Work): a failing rpc REFUSES with RedactionUnavailableError; nothing is returned to print", async () => {
  for (const r of FAILURES) {
    const f = fake(r);
    const err = await assertRejects(() => redactContactOrRefuse(f.client, "call 317-555-0142", false), RedactionUnavailableError);
    assertEquals((err as RedactionUnavailableError).code, "d390_redaction_unavailable");
    assert(!String((err as Error).message).includes("317"), "the refusal reason never carries the typed text");
  }
});

Deno.test("refusal path does not trigger when the fee is collected, or the text is empty (no rpc, no refusal)", async () => {
  const f = fake("throw");
  assertEquals(await redactContactOrRefuse(f.client, "call 317-555-0142", true), "call 317-555-0142");
  assertEquals(await redactContactOrRefuse(f.client, "", false), "");
  assertEquals(await redactContactOrRefuse(f.client, null, false), null);
  assertEquals(f.calls.length, 0);
});

Deno.test("empty and null text are passed through without a call", async () => {
  const f = fake({ data: "x", error: null });
  assertEquals(await homeownerTextForContractor(f.client, null, false), null);
  assertEquals(await homeownerTextForContractor(f.client, undefined, false), null);
  assertEquals(await homeownerTextForContractor(f.client, "", false), "");
  assertEquals(f.calls.length, 0);
});

Deno.test("text is capped at 2000 characters before the rpc (same cap as the bidder view)", async () => {
  const f = fake({ data: "ok", error: null });
  await homeownerTextForContractor(f.client, "a".repeat(5000), false);
  assertEquals(String(f.calls[0].args.p_text).length, 2000);
});

Deno.test("wiring: the Scope of Work refuses on a redaction failure and the notification e-mail uses the helper; the local copy matches", async () => {
  const sow = await Deno.readTextFile(new URL("../create-docusign-envelope/index.ts", import.meta.url));
  assertStringIncludes(sow, "homeownerNotes: d390SowNotes");
  assert(!sow.includes("homeownerNotes: claimData?.homeowner_notes"), "the SOW must not print claims.homeowner_notes directly");
  assertStringIncludes(sow, "claimData?.platform_fee_charged === true");
  assert(!sow.includes("WITHHELD_TEXT") && !/Notes withheld/.test(sow), "no marker constant or marker wording in the Scope of Work path");
  // the four free-text project_confirmation keys are all wrapped (the form saves projectNotes/exclusions; the SOW reads homeownerNotes/workNotBeingDone)
  for (const k of ["homeownerNotes", "workNotBeingDone", "projectNotes", "exclusions"]) {
    assertStringIncludes(sow, `${k}: redactSowTextOrRefuse(claimData.project_confirmation.${k} ?? null, d390FeeCollected)`);
  }
  // refusal: the SOW try/catch rethrows RedactionUnavailableError BEFORE the "non-fatal, continuing without SOW" branch, and the handler maps it to 503
  const catchAt = sow.indexOf("} catch (sowErr) {");
  const rethrowAt = sow.indexOf("if (sowErr instanceof RedactionUnavailableError)", catchAt);
  const nonFatalAt = sow.indexOf("Retail SOW PDF generation failed (non-fatal", catchAt);
  assert(catchAt > 0 && rethrowAt > catchAt && rethrowAt < nonFatalAt, "rethrow must come before the non-fatal branch");
  assertStringIncludes(sow.slice(rethrowAt, nonFatalAt), "throw sowErr");
  assert(sow.indexOf("error instanceof RedactionUnavailableError", sow.indexOf("create-docusign-envelope error:")) > 0, "the handler maps the refusal");
  const sendAt = sow.indexOf('console.log("Creating BoldSign document (contractor_sign)")');
  assert(sendAt > rethrowAt, "the refusal is raised before the contractor_sign envelope is sent");
  const msg = await Deno.readTextFile(new URL("../send-message-notification/index.ts", import.meta.url));
  assertStringIncludes(msg, "homeownerTextForContractor(supabase, message.body, claim.platform_fee_charged === true)");
  assertStringIncludes(msg, "platform_fee_charged\n        ),");
  const contractorBranch = msg.slice(msg.indexOf("// Send email to contractor."), msg.indexOf("// Sender is contractor, find the homeowner"));
  assert(!contractorBranch.includes("message.body.substring"), "the contractor-bound preview must be built from the redacted body");
  const shared = await Deno.readTextFile(new URL("./homeowner-text-redact.ts", import.meta.url));
  const local = await Deno.readTextFile(new URL("../send-message-notification/homeowner-text-redact.ts", import.meta.url));
  assertEquals(local.split("\n").slice(1).join("\n"), shared);
  assert(!shared.includes("WITHHELD_TEXT") && !/Notes withheld/.test(shared));
});
