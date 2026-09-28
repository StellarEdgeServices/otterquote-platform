// gh-2154 P-5r — invite-email.ts pure-function tests. Run:
// deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildInviteEmail, buildReminderEmail, inviteTargetPage, isInviteEmailEnabled } from "./invite-email.ts";

const OPT_OUT_URL = "https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/partner-email-optout?t=real.sig";

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
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(!email.subject.includes("not yet approved"));
  assert(!email.text.includes("not yet approved"));
  assert(!email.html.includes("not yet approved"));
});

// gh-2154 P-5 go-live item 1 supersedes this: the unsubscribe URL is no
// longer a placeholder -- it is the real, caller-supplied optOutUrl (see
// the "footer's unsubscribe link is the REAL caller-supplied optOutUrl"
// test below).

Deno.test("buildInviteEmail: approved subject line, with the partner's first name", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assertEquals(email.subject, "You're almost in, Jamie — finish your Otter Quotes signup");
});

Deno.test("buildInviteEmail: falls back to 'there' when first_name is empty, same convention as send-partner-onboarding", () => {
  const email = buildInviteEmail("", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assertEquals(email.subject, "You're almost in, there — finish your Otter Quotes signup");
});

Deno.test("buildInviteEmail: RE-2 benefit line (realtor angle)", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(email.text.includes("after an inspection, or before a listing goes live"));
});

Deno.test("buildInviteEmail: INS-2 benefit line (insurance angle)", () => {
  const email = buildInviteEmail("Jamie", "insurance_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(email.text.includes("instead of the first door-knocker who shows up"));
});

Deno.test("buildInviteEmail: HI-2 benefit line (inspector angle) -- no fee/bonus/earnings words anywhere (D-333)", () => {
  const email = buildInviteEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(email.text.includes("a link to competing contractor bids, not just a business card"));
  for (const forbidden of ["$", "earn", "bonus", "commission", "payout"]) {
    assert(!email.text.toLowerCase().includes(forbidden.toLowerCase()), `HI-2 invite must not contain "${forbidden}"`);
    assert(!email.html.toLowerCase().includes(forbidden.toLowerCase()), `HI-2 invite must not contain "${forbidden}"`);
  }
});

Deno.test("buildInviteEmail: HI-2 omits 'as a referral partner' and 'gets you your referral link' (no fee-bearing referral role for inspectors, D-333)", () => {
  const hi = buildInviteEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(!hi.text.includes("as a referral partner"));
  assert(!hi.text.includes("gets you your referral link"));
  const re = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(re.text.includes("as a referral partner"));
  assert(re.text.includes("gets you your referral link"));
});

Deno.test("buildInviteEmail: CTA text is 'Finish My Signup', per the approved draft", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(email.text.includes("Finish My Signup"));
  assert(email.html.includes(">Finish My Signup<"));
});

Deno.test("buildInviteEmail: links to the dedicated partner-invite.html accept page with ?token=", () => {
  const email = buildInviteEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(email.text.includes("https://otterquote.com/partner-invite.html?token=tok.sig"));
});

Deno.test("buildInviteEmail: the D-237 postal address is present in both text and html", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(email.text.includes("3410 N High School Rd"));
  assert(email.html.includes("3410 N High School Rd"));
});

Deno.test("buildInviteEmail: approved D-237 footer sentence and support contact present", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=tok-out");
  assert(email.text.includes("Otter Quotes is a service of Stellar Edge Services LLC"));
  assert(email.text.includes("support@otterquote.com"));
  assert(email.text.includes("(317) 501-9215"));
});

// gh-2154 P-5 go-live (item 1): the unsubscribe link is now a real,
// caller-supplied URL, not the "[UNSUBSCRIBE_URL -- not yet wired]"
// placeholder this file used to carry.

Deno.test("buildInviteEmail: the footer's unsubscribe link is the REAL caller-supplied optOutUrl -- no placeholder text remains", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(email.text.includes(OPT_OUT_URL));
  assert(!email.text.includes("not yet wired"));
  assert(!email.text.includes("UNSUBSCRIBE_URL"));
});

Deno.test("buildInviteEmail: the HTML footer wraps the real optOutUrl in a clickable <a>, matching send-partner-onboarding's own anchor pattern", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(email.html.includes(`<a href="${OPT_OUT_URL}" style="color:inherit;">${OPT_OUT_URL}</a>`));
});

Deno.test("buildInviteEmail: two different partners' optOutUrl values never collide -- the link is per-recipient, not a shared constant", () => {
  const a = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=aaa");
  const b = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", "https://x/optout?t=bbb");
  assert(a.text.includes("t=aaa") && !a.text.includes("t=bbb"));
  assert(b.text.includes("t=bbb") && !b.text.includes("t=aaa"));
});

// ── buildReminderEmail (48h reminder, item 2) ────────────────────────────────

Deno.test("buildReminderEmail: RE-2/INS-2 subject is 'your Otter Quotes referral link is waiting'", () => {
  const re = buildReminderEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assertEquals(re.subject, "Reminder: your Otter Quotes referral link is waiting");
  const ins = buildReminderEmail("Jamie", "insurance_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assertEquals(ins.subject, "Reminder: your Otter Quotes referral link is waiting");
});

Deno.test("buildReminderEmail: HI-2 subject differs -- 'your Otter Quotes account is waiting' (no referral-fee link, D-333)", () => {
  const hi = buildReminderEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assertEquals(hi.subject, "Reminder: your Otter Quotes account is waiting");
});

Deno.test("buildReminderEmail: body is the approved reminder sentence verbatim, with the real link and footer", () => {
  const email = buildReminderEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(email.text.includes("Hi Jamie, you started joining Otter Quotes as a referral partner but haven't finished yet."));
  assert(email.text.includes("Finish My Signup: https://otterquote.com/partner-invite.html?token=tok.sig"));
  assert(email.text.includes(OPT_OUT_URL));
});

Deno.test("buildReminderEmail: HI-2 body omits 'as a referral partner', same as the initial invite (D-333)", () => {
  const hi = buildReminderEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(!hi.text.includes("as a referral partner"));
  assert(hi.text.includes("Hi Jamie, you started joining Otter Quotes but haven't finished yet."));
});

Deno.test("buildReminderEmail: falls back to 'there' when first_name is empty", () => {
  const email = buildReminderEmail("", "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(email.text.includes("Hi there,"));
});

Deno.test("buildReminderEmail: carries no fee/bonus/earnings language for HI-2 (D-333)", () => {
  const hi = buildReminderEmail("Jamie", "home_inspector", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  for (const forbidden of ["$", "earn", "bonus", "commission", "payout"]) {
    assert(!hi.text.toLowerCase().includes(forbidden.toLowerCase()));
    assert(!hi.html.toLowerCase().includes(forbidden.toLowerCase()));
  }
});

// ── REVIEW FAIL 5841303507 must-fix 3: HTML injection via first_name ───────
// first_name is attacker-controlled (anyone can submit the Meta lead
// form) and was interpolated into the HTML body unescaped.

Deno.test("buildInviteEmail: NEGATIVE CONTROL -- an attacker-supplied first_name is HTML-escaped in the HTML body, not injected raw", () => {
  const evil = '<script>alert(1)</script>"quote\'s';
  const email = buildInviteEmail(evil, "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(!email.html.includes("<script>alert(1)</script>"), "must-fix 3: raw <script> must never reach the HTML body");
  assert(
    email.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;quote&#39;s"),
    "the escaped form must be present instead",
  );
  // The plain-text body has no markup to inject into -- unescaped is correct there.
  assert(email.text.includes(evil));
});

Deno.test("buildReminderEmail: NEGATIVE CONTROL -- an attacker-supplied first_name is HTML-escaped in the HTML body, not injected raw", () => {
  const evil = '<img src=x onerror=alert(1)>';
  const email = buildReminderEmail(evil, "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(!email.html.includes("<img src=x onerror=alert(1)>"), "must-fix 3: raw <img onerror> must never reach the HTML body");
  assert(email.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert(email.text.includes(evil));
});

// ── REVIEW FAIL 5841303507 must-fix 5: approved preheaders were missing ───

Deno.test("buildInviteEmail: carries the Dustin-approved Email-1 preheader as a hidden preview span (ceo69-p5-invite-copy-20260925.md)", () => {
  const email = buildInviteEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(
    email.html.includes(
      '<span style="display:none;max-height:0;overflow:hidden;">You asked to join on Facebook/Instagram. Finish in about 60 seconds — your details are already filled in.</span>',
    ),
  );
});

Deno.test("buildReminderEmail: carries the Dustin-approved reminder preheader as a hidden preview span", () => {
  const email = buildReminderEmail("Jamie", "re_agent", "https://otterquote.com", "tok.sig", OPT_OUT_URL);
  assert(
    email.html.includes(
      '<span style="display:none;max-height:0;overflow:hidden;">You started signing up — it only takes about 60 seconds to finish.</span>',
    ),
  );
});
