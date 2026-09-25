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

Deno.test("inviteTargetPage: every agent_type routes to the one dedicated partner-invite.html accept page", () => {
  assertEquals(inviteTargetPage("re_agent"), "partner-invite.html");
  assertEquals(inviteTargetPage("insurance_agent"), "partner-invite.html");
  assertEquals(inviteTargetPage("home_inspector"), "partner-invite.html");
  assertEquals(inviteTargetPage("adjuster"), "partner-invite.html");
  assertEquals(inviteTargetPage("other"), "partner-invite.html");
});

Deno.test("inviteTargetPage: unknown agent_type also routes to partner-invite.html", () => {
  assertEquals(inviteTargetPage("something_unexpected"), "partner-invite.html");
});

// gh-2154 P-5 go-live: Dustin approved this copy verbatim (#2154 comment
// 5837072371, draft ceo69-p5-invite-copy-20260925.md). It must no longer
// carry the "not yet approved" placeholder markers.

Deno.test("buildInviteEmail: approved copy carries no 'not yet approved' placeholder markers", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(!email.subject.includes("not yet approved"));
  assert(!email.text.includes("not yet approved"));
  assert(!email.html.includes("not yet approved"));
});

Deno.test("buildInviteEmail: the ONE remaining placeholder is the unsubscribe URL, not wired to a real opt-out link yet", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("[UNSUBSCRIBE_URL -- opt-out link not yet wired]"));
  assert(email.html.includes("UNSUBSCRIBE_URL -- opt-out link not yet wired"));
});

Deno.test("buildInviteEmail: approved subject line, with the partner's first name", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assertEquals(email.subject, "You're almost in, Jamie — finish your Otter Quotes signup");
});

Deno.test("buildInviteEmail: falls back to 'there' when first_name is empty, same convention as send-partner-onboarding", () => {
  const email = buildInviteEmail("", "re_agent", "https://otterquote.com", "tok.sig");
  assertEquals(email.subject, "You're almost in, there — finish your Otter Quotes signup");
});

Deno.test("buildInviteEmail: RE-2 benefit line (realtor angle)", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("after an inspection, or before a listing goes live"));
});

Deno.test("buildInviteEmail: INS-2 benefit line (insurance angle)", () => {
  const email = buildInviteEmail("Jamie", "insurance_agent", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("instead of the first door-knocker who shows up"));
});

Deno.test("buildInviteEmail: HI-2 benefit line (inspector angle) -- no fee/bonus/earnings words anywhere (D-333)", () => {
  const email = buildInviteEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("a link to competing contractor bids, not just a business card"));
  for (const forbidden of ["$", "earn", "bonus", "commission", "payout"]) {
    assert(!email.text.toLowerCase().includes(forbidden.toLowerCase()), `HI-2 invite must not contain "${forbidden}"`);
    assert(!email.html.toLowerCase().includes(forbidden.toLowerCase()), `HI-2 invite must not contain "${forbidden}"`);
  }
});

Deno.test("buildInviteEmail: HI-2 omits 'as a referral partner' and 'gets you your referral link' (no fee-bearing referral role for inspectors, D-333)", () => {
  const hi = buildInviteEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig");
  assert(!hi.text.includes("as a referral partner"));
  assert(!hi.text.includes("gets you your referral link"));
  const re = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(re.text.includes("as a referral partner"));
  assert(re.text.includes("gets you your referral link"));
});

Deno.test("buildInviteEmail: CTA text is 'Finish My Signup', per the approved draft", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("Finish My Signup"));
  assert(email.html.includes(">Finish My Signup<"));
});

Deno.test("buildInviteEmail: links to the dedicated partner-invite.html accept page with ?token=", () => {
  const email = buildInviteEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("https://otterquote.com/partner-invite.html?token=tok.sig"));
});

Deno.test("buildInviteEmail: the D-237 postal address is present in both text and html", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("3410 N High School Rd"));
  assert(email.html.includes("3410 N High School Rd"));
});

Deno.test("buildInviteEmail: approved D-237 footer sentence and support contact present", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig");
  assert(email.text.includes("Otter Quotes is a service of Stellar Edge Services LLC"));
  assert(email.text.includes("support@otterquote.com"));
  assert(email.text.includes("(317) 501-9215"));
});
