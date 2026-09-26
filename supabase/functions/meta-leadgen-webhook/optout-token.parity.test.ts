// gh-2154 P-5 go-live — the duplicated optout token module must not drift,
// same guard convention partner-email-optout/optout-token.parity.test.ts
// already uses against send-partner-onboarding/optout.ts.
// Run: deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/optout-token.parity.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const BEGIN = "// ─── BEGIN PARITY REGION";
const END = "// ─── END PARITY REGION";
const CANONICAL = "supabase/functions/partner-email-optout/optout-token.ts";
const COPY = "supabase/functions/meta-leadgen-webhook/optout.ts";

function parityRegion(path: string): string {
  const src = Deno.readTextFileSync(path);
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert(start !== -1, `${path}: missing ${BEGIN}`);
  assert(end > start, `${path}: missing ${END} after the begin marker`);
  return src.slice(start, end);
}

Deno.test("the optout token mechanism (partner-email-optout / meta-leadgen-webhook copy) is identical inside the parity region", () => {
  const a = parityRegion(CANONICAL);
  const b = parityRegion(COPY);
  assertEquals(b, a);
  // NEGATIVE CONTROL — the comparison is not vacuous.
  assert(a.length > 1500, `parity region suspiciously small: ${a.length} bytes`);
  assert(a.includes("export async function signPartnerOptOutToken"), "parity region must cover the signer");
  assert(a.includes("export async function verifyPartnerOptOutToken"), "parity region must cover the verifier");
  assert(
    Deno.readTextFileSync(CANONICAL) !== Deno.readTextFileSync(COPY),
    "the two files should differ in their headers (canonical vs copy)",
  );
});

Deno.test("meta-leadgen-webhook's copy signs/verifies with the SAME env var names as P-4 (PARTNER_ONBOARDING_OPTOUT_SECRET) -- deliberately not a new invite-specific secret", async () => {
  const mod = await import("./optout.ts");
  assertEquals(mod.PARTNER_OPTOUT_SECRET_ENV, "PARTNER_ONBOARDING_OPTOUT_SECRET");
  const token = await mod.signPartnerOptOutToken("agent-456", "s3cret");
  const verified = await mod.verifyPartnerOptOutToken(token, ["s3cret"]);
  assertEquals(verified, "agent-456");
});

Deno.test("meta-leadgen-webhook's copy builds a URL pointed at the SAME partner-email-optout endpoint P-4 uses, not a new one", async () => {
  const mod = await import("./optout.ts");
  const url = mod.buildPartnerOptOutUrl("https://x.supabase.co/functions/v1", "tok.sig");
  assertEquals(url, "https://x.supabase.co/functions/v1/partner-email-optout?t=tok.sig");
});
