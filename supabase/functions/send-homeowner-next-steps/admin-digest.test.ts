// gh-1933 — unit tests for the stalled-homeowner admin digest's pure logic.
// Run: deno test supabase/functions/send-homeowner-next-steps/admin-digest.test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  ADMIN_DIGEST_EMAIL,
  ADMIN_DIGEST_NOTIFICATION_TYPE,
  buildAdminDigestEmail,
  daysStalled,
  filterNotYetDigestedToday,
  maskEmail,
  type StalledCandidate,
  utcDayStartIso,
} from "./admin-digest.ts";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

function candidate(over: Partial<StalledCandidate> = {}): StalledCandidate {
  return {
    claimId: "c1",
    userId: "u1",
    email: "nick@example.com",
    createdAtIso: "2026-09-12T12:00:00.000Z", // exactly 3 days before NOW
    ...over,
  };
}

Deno.test("maskEmail: masks the local part, keeps the domain", () => {
  assertEquals(maskEmail("nick@example.com"), "n***@example.com");
});

Deno.test("maskEmail: no usable address -> placeholder, never throws", () => {
  assertEquals(maskEmail(""), "(no email)");
  assertEquals(maskEmail("not-an-email"), "(no email)");
});

Deno.test("utcDayStartIso: midnight UTC of the given day", () => {
  assertEquals(utcDayStartIso(NOW), "2026-09-15T00:00:00.000Z");
});

Deno.test("daysStalled: whole days between created_at and now", () => {
  assertEquals(daysStalled("2026-09-12T12:00:00.000Z", NOW), 3);
});

Deno.test("daysStalled: malformed timestamp fails closed to 0, never NaN or negative", () => {
  assertEquals(daysStalled("not-a-date", NOW), 0);
  assertEquals(daysStalled("2026-09-20T00:00:00.000Z", NOW), 0); // future timestamp
});

Deno.test("filterNotYetDigestedToday: excludes only claims already digested today", () => {
  const candidates = [candidate({ claimId: "a" }), candidate({ claimId: "b" }), candidate({ claimId: "c" })];
  const already = new Set(["b"]);
  const out = filterNotYetDigestedToday(candidates, already);
  assertEquals(out.map((c) => c.claimId), ["a", "c"]);
});

Deno.test("NEGATIVE CONTROL — a claim digested today does not appear again the same day", () => {
  const candidates = [candidate({ claimId: "already-sent" })];
  const already = new Set(["already-sent"]);
  const out = filterNotYetDigestedToday(candidates, already);
  assertEquals(out.length, 0);
});

Deno.test("filterNotYetDigestedToday: an empty already-digested set excludes nothing", () => {
  const candidates = [candidate({ claimId: "x" }), candidate({ claimId: "y" })];
  const out = filterNotYetDigestedToday(candidates, new Set());
  assertEquals(out.length, 2);
});

Deno.test("buildAdminDigestEmail: singular wording for exactly one homeowner", () => {
  const { subject, textBody } = buildAdminDigestEmail(
    [candidate({ email: "nick@example.com" })],
    "https://otterquote.com/admin-homeowners.html",
    NOW,
  );
  assertEquals(subject, "[OtterQuote] 1 homeowner stalled at documents_needed");
  assert(textBody.includes("1 homeowner is stuck"), textBody);
});

Deno.test("buildAdminDigestEmail: plural wording for more than one homeowner", () => {
  const { subject, textBody } = buildAdminDigestEmail(
    [candidate({ claimId: "c1" }), candidate({ claimId: "c2" })],
    "https://otterquote.com/admin-homeowners.html",
    NOW,
  );
  assertEquals(subject, "[OtterQuote] 2 homeowners stalled at documents_needed");
  assert(textBody.includes("2 homeowners are stuck"), textBody);
});

Deno.test("buildAdminDigestEmail: lists masked email, claim id and days stalled — never the real email", () => {
  const { textBody, htmlBody, rows } = buildAdminDigestEmail(
    [candidate({ claimId: "claim-123", email: "george@hotmail.com", createdAtIso: "2026-09-12T12:00:00.000Z" })],
    "https://otterquote.com/admin-homeowners.html",
    NOW,
  );
  assertEquals(rows, [{ claimId: "claim-123", maskedEmail: "g***@hotmail.com", daysStalled: 3, isChecklistCompleteStage: false }]);
  assert(textBody.includes("g***@hotmail.com"), textBody);
  assert(textBody.includes("claim-123"), textBody);
  assert(textBody.includes("3d"), textBody);
  assert(htmlBody.includes("g***@hotmail.com"), htmlBody);
  assert(!textBody.includes("george@hotmail.com"), "real email must never appear in the digest");
  assert(!htmlBody.includes("george@hotmail.com"), "real email must never appear in the digest");
});

Deno.test("buildAdminDigestEmail: dashboard link is present in both bodies", () => {
  const url = "https://otterquote.com/admin-homeowners.html";
  const { textBody, htmlBody } = buildAdminDigestEmail([candidate()], url, NOW);
  assert(textBody.includes(url), textBody);
  assert(htmlBody.includes(`href="${url}"`), htmlBody);
});

Deno.test("NEGATIVE CONTROL — an empty candidate list still builds a well-formed (zero-row) email rather than throwing", () => {
  const { subject, rows } = buildAdminDigestEmail([], "https://otterquote.com/admin-homeowners.html", NOW);
  assertEquals(subject, "[OtterQuote] 0 homeowners stalled at documents_needed");
  assertEquals(rows.length, 0);
});

// ── gh-2219 (PR #2219 REVIEW: FAIL M2) — checklist-complete rows get their
// own line, and the existing '48h' sentence stays byte-identical ──────────

Deno.test("buildAdminDigestEmail: a '48h'-only digest (no checklist-complete rows) is unchanged byte-for-byte from the pre-gh-2219 shape", () => {
  const { textBody, htmlBody } = buildAdminDigestEmail(
    [candidate({ claimId: "claim-123", email: "george@hotmail.com", createdAtIso: "2026-09-12T12:00:00.000Z" })],
    "https://otterquote.com/admin-homeowners.html",
    NOW,
  );
  assertEquals(
    textBody,
    [
      "1 homeowner is stuck at documents_needed for 48+ hours, with no measurements, no Hover order, and no activity recorded on their account since the claim was created.",
      "",
      "- g***@hotmail.com | claim claim-123 | stalled 3d",
      "",
      "Open the admin dashboard:",
      "https://otterquote.com/admin-homeowners.html",
    ].join("\n"),
  );
  assert(!textBody.toLowerCase().includes("checklist"), textBody);
  assert(!htmlBody.toLowerCase().includes("checklist"), htmlBody);
});

Deno.test("buildAdminDigestEmail: a checklist-complete row gets its OWN line, not the '48h' stalled/no-activity sentence", () => {
  const { textBody, htmlBody, rows } = buildAdminDigestEmail(
    [
      candidate({ claimId: "claim-48h", email: "george@hotmail.com" }),
      candidate({
        claimId: "claim-cc",
        email: "nick@example.com",
        createdAtIso: "2026-09-15T10:00:00.000Z", // 2h before NOW
        isChecklistCompleteStage: true,
      }),
    ],
    "https://otterquote.com/admin-homeowners.html",
    NOW,
  );
  assertEquals(rows.find((r) => r.claimId === "claim-cc")?.isChecklistCompleteStage, true);
  assertEquals(rows.find((r) => r.claimId === "claim-48h")?.isChecklistCompleteStage, false);

  // The '48h' row's sentence is exactly the pre-gh-2219 wording, unaffected
  // by the checklist-complete row's presence.
  assert(
    textBody.includes(
      "1 homeowner is stuck at documents_needed for 48+ hours, with no measurements, no Hover order, and no activity recorded on their account since the claim was created.",
    ),
    textBody,
  );
  // The checklist-complete row gets its own sentence instead of that one.
  assert(textBody.includes("1 homeowner has completed the checklist, not yet submitted for bids."), textBody);
  assert(textBody.includes("- n***@example.com | claim claim-cc | checklist complete 0d ago"), textBody);
  assert(htmlBody.includes("has completed the checklist, not yet submitted for bids."), htmlBody);
  assert(htmlBody.includes("n***@example.com"), htmlBody);
  // Never claim a checklist-complete row is "stalled" or has "no activity".
  assert(!textBody.includes("claim claim-cc | stalled"), textBody);
});

Deno.test("buildAdminDigestEmail: all-checklist-complete digest omits the '48h' sentence's claim about no activity for those rows (0-count stalled sentence still present, describing zero '48h' rows)", () => {
  const { textBody } = buildAdminDigestEmail(
    [candidate({ claimId: "claim-cc", isChecklistCompleteStage: true })],
    "https://otterquote.com/admin-homeowners.html",
    NOW,
  );
  assert(textBody.includes("0 homeowners are stuck at documents_needed for 48+ hours"), textBody);
  assert(textBody.includes("1 homeowner has completed the checklist, not yet submitted for bids."), textBody);
});

Deno.test("constants: recipient and notification_type match this repo's admin-digest conventions", () => {
  assertEquals(ADMIN_DIGEST_EMAIL, "dustinstohler1@gmail.com");
  assertEquals(ADMIN_DIGEST_NOTIFICATION_TYPE, "admin_stalled_homeowner_digest");
});
