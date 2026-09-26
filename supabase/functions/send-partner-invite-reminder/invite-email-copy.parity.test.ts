// gh-2154 P-5 go-live — the duplicated invite-email copy (footer, switch,
// routing, and the initial-invite + 48h-reminder builders) must not drift
// from meta-leadgen-webhook/invite-email.ts's own PARITY REGION.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-partner-invite-reminder/invite-email-copy.parity.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const BEGIN = "// ─── BEGIN PARITY REGION";
const END = "// ─── END PARITY REGION";
const CANONICAL = "supabase/functions/meta-leadgen-webhook/invite-email.ts";
const COPY = "supabase/functions/send-partner-invite-reminder/invite-email-copy.ts";

function parityRegion(path: string): string {
  const src = Deno.readTextFileSync(path);
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert(start !== -1, `${path}: missing ${BEGIN}`);
  assert(end > start, `${path}: missing ${END} after the begin marker`);
  return src.slice(start, end);
}

Deno.test("invite-email copy (meta-leadgen-webhook / send-partner-invite-reminder) is identical inside the parity region", () => {
  const a = parityRegion(CANONICAL);
  const b = parityRegion(COPY);
  assertEquals(b, a);
  assert(a.length > 5000, `parity region suspiciously small: ${a.length} bytes`);
  assert(a.includes("export function buildReminderEmail"), "parity region must cover the reminder builder");
  assert(a.includes("export function buildInviteEmail"), "parity region must cover the invite builder");
});

Deno.test("send-partner-invite-reminder's copy of buildReminderEmail produces the same Dustin-approved copy as meta-leadgen-webhook's", async () => {
  const mod = await import("./invite-email-copy.ts");
  const email = mod.buildReminderEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok2");
  assertEquals(email.subject, "Reminder: your Otter Quotes referral link is waiting");
  assert(email.text.includes("Finish My Signup"));
  assert(email.text.includes("https://x/optout?t=tok2"));
});
