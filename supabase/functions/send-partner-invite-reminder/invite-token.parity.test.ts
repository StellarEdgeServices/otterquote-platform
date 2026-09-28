// gh-2154 P-5 go-live — the duplicated invite-token.ts module must not
// drift, same guard convention as the other invite-token.parity.test.ts
// copies (partner-invite-accept / meta-leadgen-webhook).
// Run: deno test --allow-read=supabase/functions supabase/functions/send-partner-invite-reminder/invite-token.parity.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const BEGIN = "// ─── BEGIN PARITY REGION";
const END = "// ─── END PARITY REGION";
const CANONICAL = "supabase/functions/partner-invite-accept/invite-token.ts";
const COPY = "supabase/functions/send-partner-invite-reminder/invite-token.ts";

function parityRegion(path: string): string {
  const src = Deno.readTextFileSync(path);
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert(start !== -1, `${path}: missing ${BEGIN}`);
  assert(end > start, `${path}: missing ${END} after the begin marker`);
  return src.slice(start, end);
}

Deno.test("the invite-token.ts copies (partner-invite-accept / send-partner-invite-reminder) are identical inside the parity region", () => {
  const a = parityRegion(CANONICAL);
  const b = parityRegion(COPY);
  assertEquals(b, a);
  assert(a.length > 1500, `parity region suspiciously small: ${a.length} bytes`);
});

Deno.test("send-partner-invite-reminder's copy signs a reminder-link token the same way meta-leadgen-webhook's invite email does", async () => {
  const mod = await import("./invite-token.ts");
  const token = await mod.signPartnerInviteToken("agent-999", "s3cret");
  const verified = await mod.verifyPartnerInviteToken(token, ["s3cret"]);
  assertEquals(verified, "agent-999");
});
