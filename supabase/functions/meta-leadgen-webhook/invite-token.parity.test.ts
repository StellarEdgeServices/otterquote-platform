// gh-2154 P-5r — the duplicated invite-token.ts module must not drift, same
// guard convention as partner-email-optout/optout-token.parity.test.ts.
// Run: deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/invite-token.parity.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const BEGIN = "// ─── BEGIN PARITY REGION";
const END = "// ─── END PARITY REGION";
const CANONICAL = "supabase/functions/partner-invite-accept/invite-token.ts";
const COPY = "supabase/functions/meta-leadgen-webhook/invite-token.ts";

function parityRegion(path: string): string {
  const src = Deno.readTextFileSync(path);
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert(start !== -1, `${path}: missing ${BEGIN}`);
  assert(end > start, `${path}: missing ${END} after the begin marker`);
  return src.slice(start, end);
}

Deno.test("the two invite-token.ts copies (partner-invite-accept / meta-leadgen-webhook) are identical inside the parity region", () => {
  const a = parityRegion(CANONICAL);
  const b = parityRegion(COPY);
  assertEquals(b, a);
  // NEGATIVE CONTROL — the comparison is not vacuous.
  assert(a.length > 1500, `parity region suspiciously small: ${a.length} bytes`);
  assert(a.includes("export async function signPartnerInviteToken"), "parity region must cover the signer");
  assert(a.includes("export async function verifyPartnerInviteToken"), "parity region must cover the verifier");
});

Deno.test("invite-token.ts: signed token round-trips through verify and is namespaced (not confusable with an opt-out token)", async () => {
  const mod = await import("./invite-token.ts");
  const token = await mod.signPartnerInviteToken("agent-123", "s3cret");
  const verified = await mod.verifyPartnerInviteToken(token, ["s3cret"]);
  assertEquals(verified, "agent-123");
  // A token signed under a different secret must not verify.
  const wrongSecret = await mod.verifyPartnerInviteToken(token, ["other-secret"]);
  assertEquals(wrongSecret, null);
});
