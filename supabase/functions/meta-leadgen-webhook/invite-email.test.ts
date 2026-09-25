// gh-2154 P-5r — invite-email.ts pure-function tests. Run:
// deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildInviteEmail, inviteTargetPage, isInviteEmailEnabled } from "./invite-email.ts";

Deno.test("isInviteEmailEnabled: defaults OFF -- undefined/unset is disabled", () => {
  assertEquals(isInviteEmailEnabled(undefined), false);
});

Deno.test("isInviteEmailEnabled: only the exact string 'true' enables sending", () => {
  assertEquals(isInviteEmailEnabled("true"), true);
  assertEquals(isInviteEmailEnabled("True"), false);
  assertEquals(isInviteEmailEnabled("1"), false);
  assertEquals(isInviteEmailEnabled("yes"), false);
  assertEquals(isInviteEmailEnabled(""), false);
});

Deno.test("inviteTargetPage: routes each allowlist agent_type to its own partner page", () => {
  assertEquals(inviteTargetPage("re_agent"), "partner-re.html");
  assertEquals(inviteTargetPage("insurance_agent"), "partner-insurance.html");
  assertEquals(inviteTargetPage("home_inspector"), "partner-inspectors.html");
  assertEquals(inviteTargetPage("adjuster"), "partner-adjusters.html");
  assertEquals(inviteTargetPage("other"), "partner-other.html");
});

Deno.test("inviteTargetPage: unknown agent_type falls back to partner-other.html", () => {
  assertEquals(inviteTargetPage("something_unexpected"), "partner-other.html");
});

Deno.test("buildInviteEmail: copy is clearly marked as an unapproved placeholder", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(email.subject.includes("PLACEHOLDER"));
  assert(email.text.includes("PLACEHOLDER"));
  assert(email.html.includes("PLACEHOLDER"));
});

Deno.test("buildInviteEmail: links to the agent-type-specific partner page with the invite token", () => {
  const email = buildInviteEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("https://otterquote.com/partner-inspectors.html?invite=tok.sig"));
});

Deno.test("buildInviteEmail: the D-237 postal address is present in both text and html", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("3410 N High School Rd"));
  assert(email.html.includes("3410 N High School Rd"));
});
