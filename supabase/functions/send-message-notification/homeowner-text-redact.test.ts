// gh-2559 / D-390 (LEGAL-READ 6256212786 L1): the e-mail preview the selected contractor receives when the redaction rpc fails.
// Tests the LOCAL copy this function actually deploys, end to end through the preview and the e-mail text template.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { homeownerTextForContractor } from "./homeowner-text-redact.ts";
import { messageNotificationText } from "./templates.ts";

const failing = (kind: "error" | "throw" | "nodata") => ({
  rpc: () => {
    if (kind === "throw") throw new Error("network down");
    return Promise.resolve(kind === "error" ? { data: null, error: { message: "boom" } } : { data: null, error: null });
  },
});

Deno.test("redaction failure: the contractor-bound preview is [removed] (success-path token), with no fee or Notes wording", async () => {
  for (const kind of ["error", "throw", "nodata"] as const) {
    const body = (await homeownerTextForContractor(failing(kind), "call me 317-555-0142 or a@b.com", false)) ?? "";
    const preview = body.substring(0, 200);
    assertEquals(preview, "[removed]");
    assert(!/317|a@b\.com|fee|notes|withheld/i.test(preview));
    const text = messageNotificationText("Pat", "the homeowner", preview, body.length > 200, "https://x.invalid");
    assertStringIncludes(text, '"[removed]"');
    assert(!text.includes("317"));
  }
});

Deno.test("success path unchanged: the rpc's redacted text is the preview", async () => {
  const ok = { rpc: () => Promise.resolve({ data: "call me [removed]", error: null }) };
  assertEquals(await homeownerTextForContractor(ok, "call me 317-555-0142", false), "call me [removed]");
});
