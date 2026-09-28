// gh-2154 P-5 go-live — the duplicated optout token module must not drift,
// same guard convention as the other optout-token.parity.test.ts copies.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-partner-invite-reminder/optout-token.parity.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const BEGIN = "// ─── BEGIN PARITY REGION";
const END = "// ─── END PARITY REGION";
const CANONICAL = "supabase/functions/partner-email-optout/optout-token.ts";
const COPY = "supabase/functions/send-partner-invite-reminder/optout.ts";

function parityRegion(path: string): string {
  const src = Deno.readTextFileSync(path);
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert(start !== -1, `${path}: missing ${BEGIN}`);
  assert(end > start, `${path}: missing ${END} after the begin marker`);
  return src.slice(start, end);
}

Deno.test("the optout token mechanism (partner-email-optout / send-partner-invite-reminder copy) is identical inside the parity region", () => {
  const a = parityRegion(CANONICAL);
  const b = parityRegion(COPY);
  assertEquals(b, a);
  assert(a.length > 1500, `parity region suspiciously small: ${a.length} bytes`);
  assert(a.includes("export async function signPartnerOptOutToken"), "parity region must cover the signer");
  assert(a.includes("export async function verifyPartnerOptOutToken"), "parity region must cover the verifier");
});

Deno.test("send-partner-invite-reminder's copy signs/verifies with the SAME env var names as P-4", async () => {
  const mod = await import("./optout.ts");
  assertEquals(mod.PARTNER_OPTOUT_SECRET_ENV, "PARTNER_ONBOARDING_OPTOUT_SECRET");
  const token = await mod.signPartnerOptOutToken("agent-789", "s3cret");
  const verified = await mod.verifyPartnerOptOutToken(token, ["s3cret"]);
  assertEquals(verified, "agent-789");
});
