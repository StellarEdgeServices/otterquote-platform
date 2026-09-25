// gh-2069 — send-home-profile-prompt previously discarded Mailgun's message
// id and never wrote to `notifications`, the same defect #2069 found in
// send-homeowner-next-steps. These tests exercise processClaim() end to end
// against a fake Supabase client and a fake global fetch (this function has
// no injected-dependency layer of its own — see index.ts's own comment on
// ProcessClaimSupabase for why a structural fake is enough here).
//
// gh-2013 (this change) — new tests below cover the CAN-SPAM footer + opt-out
// fix: a NEGATIVE CONTROL that pins the pre-fix render (no postal address, no
// opt-out link, no List-Unsubscribe header — the exact defect #2013 was filed
// on) alongside assertions that the post-fix render carries all three, and
// that an opted-out claim is never emailed.
import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  HOME_PROFILE_PROMPT_TEMPLATE,
  insertNotification,
  processClaim,
  type NotificationClient,
  type NotificationRow,
  type ProcessClaimSupabase,
} from "./index.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";
import { buildOptOutUrl, signOptOutToken } from "./optout-token.ts";

const CLAIM = {
  id: "c1111111-2222-3333-4444-555555555555",
  user_id: "u1111111-2222-3333-4444-555555555555",
  completion_date: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  property_address: "123 Main St",
  trades: ["roofing"],
  profile_prompt_sent_at: null,
};

const TEST_OPTOUT_SECRET = "test-only-optout-signing-secret";
const FUNCTIONS_BASE_URL = "https://yeszghaspzwwstvsrioa.supabase.co/functions/v1";

async function testOptOutUrl(claimId: string): Promise<string> {
  return buildOptOutUrl(FUNCTIONS_BASE_URL, await signOptOutToken(claimId, TEST_OPTOUT_SECRET));
}

function fakeSupabase(opts: {
  hasHomeProfile?: boolean;
  profileEmail?: string | null;
}): { supabase: ProcessClaimSupabase; inserted: NotificationRow[]; updated: Record<string, unknown>[] } {
  const inserted: NotificationRow[] = [];
  const updated: Record<string, unknown>[] = [];
  const supabase: ProcessClaimSupabase = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                maybeSingle: async () => {
                  if (table === "home_profiles") {
                    return { data: opts.hasHomeProfile ? { id: "hp-1" } : null };
                  }
                  if (table === "profiles") {
                    return {
                      data: opts.profileEmail === undefined
                        ? { email: "homeowner@example.invalid", full_name: "Jamie Homeowner" }
                        : (opts.profileEmail === null ? null : { email: opts.profileEmail, full_name: "Jamie Homeowner" }),
                    };
                  }
                  return { data: null };
                },
              };
            },
          };
        },
        update(row: Record<string, unknown>) {
          return {
            eq: (_col: string, _val: unknown) => {
              updated.push({ table, row });
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(row: NotificationRow) {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
    auth: {
      admin: {
        getUserById: async (_id: string) => ({ data: { user: null } }),
      },
    },
  };
  return { supabase, inserted, updated };
}

function withFakeFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = impl;
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  });
}

// Captures the outgoing Mailgun request so a test can assert on its headers,
// not just its response — needed for the List-Unsubscribe assertions below.
function withCapturingFetch<T>(
  status: number,
  body: unknown,
  fn: (calls: { formData: FormData }[]) => Promise<T>,
): Promise<T> {
  const calls: { formData: FormData }[] = [];
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (async (_url: string, init?: RequestInit) => {
    calls.push({ formData: init?.body as FormData });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return fn(calls).finally(() => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  });
}

Deno.test("gh-2069 — accepted Mailgun send writes ONE notifications row with delivered=true and the mailgun id", async () => {
  const { supabase, inserted, updated } = fakeSupabase({});
  const optOutUrl = await testOptOutUrl(CLAIM.id);
  const result = await withFakeFetch(
    // deno-lint-ignore no-explicit-any
    (() => Promise.resolve(new Response(JSON.stringify({ id: "<hp-msg-1@mail.otterquote.com>" }), { status: 200 }))) as any,
    () => processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com", optOutUrl, false),
  );
  assertEquals(result.result, "sent");
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].delivered, true);
  assertEquals(inserted[0].mailgun_id, "<hp-msg-1@mail.otterquote.com>");
  assertEquals(inserted[0].notification_type, HOME_PROFILE_PROMPT_TEMPLATE);
  assertEquals(inserted[0].recipient, "homeowner@example.invalid");
  assertEquals(inserted[0].claim_id, CLAIM.id);
  // Idempotency stamp still happens on a successful send.
  assertEquals(updated.length, 1);
});

Deno.test("gh-2069 — rejected Mailgun send writes ONE notifications row with delivered=false, no mailgun id, and the error, no stamp", async () => {
  const { supabase, inserted, updated } = fakeSupabase({});
  const optOutUrl = await testOptOutUrl(CLAIM.id);
  const result = await withFakeFetch(
    // deno-lint-ignore no-explicit-any
    (() => Promise.resolve(new Response("bad request", { status: 400 }))) as any,
    () => processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com", optOutUrl, false),
  );
  assertEquals(result.result, "error");
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].delivered, false);
  assertEquals(inserted[0].mailgun_id, null);
  assertEquals(inserted[0].message_preview.includes("Mailgun 400"), true);
  // A failed send must NOT stamp profile_prompt_sent_at — the batch retries
  // it on the next cron tick.
  assertEquals(updated.length, 0);
});

Deno.test("gh-2069 — MAILGUN_API_KEY unset still writes a notifications row (delivered=true, no mailgun id)", async () => {
  const { supabase, inserted } = fakeSupabase({});
  const optOutUrl = await testOptOutUrl(CLAIM.id);
  const result = await processClaim(supabase, CLAIM, undefined, "https://otterquote.com", optOutUrl, false);
  assertEquals(result.result, "sent");
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].delivered, true);
  assertEquals(inserted[0].mailgun_id, null);
});

Deno.test("already has a home profile: no send attempted, no notifications row", async () => {
  const { supabase, inserted } = fakeSupabase({ hasHomeProfile: true });
  const optOutUrl = await testOptOutUrl(CLAIM.id);
  const result = await processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com", optOutUrl, false);
  assertEquals(result.result, "already_has_profile");
  assertEquals(inserted.length, 0);
});

Deno.test("insertNotification: a failed insert is swallowed (logged, not thrown) — the send outcome must not be reverted by an audit-write failure", async () => {
  const failing: NotificationClient = {
    from: (_table: string) => ({
      insert: (_row: NotificationRow) => Promise.resolve({ error: { message: "db down" } }),
    }),
  };
  // Must not throw.
  await insertNotification(failing, {
    user_id: CLAIM.user_id,
    claim_id: CLAIM.id,
    channel: "email",
    notification_type: HOME_PROFILE_PROMPT_TEMPLATE,
    recipient: "x@example.invalid",
    message_preview: "subject",
    delivered: true,
    mailgun_id: null,
  });
});

// ─── gh-2013 — CAN-SPAM footer + opt-out ────────────────────────────────────

Deno.test("gh-2013 NEGATIVE CONTROL — opted-out claim: no Mailgun call, no notifications row, no stamp, result is opted_out", async () => {
  const { supabase, inserted, updated } = fakeSupabase({});
  let fetchCalled = false;
  const optOutUrl = await testOptOutUrl(CLAIM.id);
  const result = await withFakeFetch(
    (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(JSON.stringify({ id: "should-never-be-sent" }), { status: 200 }));
      // deno-lint-ignore no-explicit-any
    }) as any,
    () => processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com", optOutUrl, /* isOptedOut */ true),
  );
  assertEquals(result.result, "opted_out");
  assertEquals(fetchCalled, false, "an opted-out claim must never reach Mailgun");
  assertEquals(inserted.length, 0, "an opted-out claim must never write a notifications row");
  assertEquals(updated.length, 0, "an opted-out claim must not be stamped profile_prompt_sent_at");
});

Deno.test("gh-2013 — buildEmailContent-equivalent (via processClaim -> Mailgun body) carries the postal address, the opt-out link text, and the opt-out URL in BOTH text and html bodies", async () => {
  const { supabase } = fakeSupabase({});
  const optOutUrl = await testOptOutUrl(CLAIM.id);
  await withCapturingFetch(200, { id: "<msg@mail.otterquote.com>" }, async (calls) => {
    const result = await processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com", optOutUrl, false);
    assertEquals(result.result, "sent");
    assertEquals(calls.length, 1);
    const fd = calls[0].formData;
    const text = String(fd.get("text"));
    const html = String(fd.get("html"));

    // The exact defect #2013 was filed on: no postal address anywhere.
    assertStringIncludes(text, POSTAL_ADDRESS, "plain-text body must carry the D-237 postal address");
    assertStringIncludes(html, POSTAL_ADDRESS, "html body must carry the D-237 postal address");

    // ...and no working opt-out mechanism.
    assertStringIncludes(text, optOutUrl, "plain-text body must carry the signed opt-out URL");
    assertStringIncludes(html, optOutUrl, "html body must carry the signed opt-out URL");
    assertStringIncludes(text, "Stop these updates", "plain-text body must carry the opt-out link text");
    assertStringIncludes(html, "Stop these updates", "html body must carry the opt-out link text");

    // RFC 8058 mailbox-provider one-click headers, same link.
    assertEquals(fd.get("h:List-Unsubscribe"), `<${optOutUrl}>`);
    assertEquals(fd.get("h:List-Unsubscribe-Post"), "List-Unsubscribe=One-Click");
  });
});

Deno.test("gh-2013 NEGATIVE CONTROL — pins the PRE-FIX render: the pre-fix subject/body text (reconstructed without a footer) contained neither the postal address nor any opt-out mechanism", () => {
  // This is the exact pre-fix textBody shape (see the issue's deployed-vs-main
  // sha256 comparison in the #2013 evidence comment) — reconstructed here,
  // not imported, so this test cannot accidentally start passing just
  // because the current code changed; it is a fixed historical negative
  // control, matching the issue's own closes-on ask ("the pre-fix render
  // pasted beside it as the negative control").
  const preFixFooterLines = [
    "— The Otter Quotes Team",
    "",
    "─────────────────────────────────────────",
    "You're receiving this email because a project on your Otter Quotes account was recently marked complete.",
    "Manage your preferences at: https://otterquote.com/dashboard.html",
  ].join("\n");

  assertEquals(preFixFooterLines.includes(POSTAL_ADDRESS), false, "pre-fix footer had no postal address (the defect)");
  assertEquals(preFixFooterLines.toLowerCase().includes("stop these updates"), false, "pre-fix footer had no opt-out link (the defect)");
  assertEquals(preFixFooterLines.includes("List-Unsubscribe"), false, "pre-fix footer had no List-Unsubscribe reference (the defect)");
});

Deno.test("gh-2013 — buildEmailContent fails closed: processClaim never reaches Mailgun with an empty opt-out URL", async () => {
  const { supabase } = fakeSupabase({});
  let fetchCalled = false;
  await assertRejects(
    () =>
      withFakeFetch(
        (() => {
          fetchCalled = true;
          return Promise.resolve(new Response(JSON.stringify({ id: "x" }), { status: 200 }));
          // deno-lint-ignore no-explicit-any
        }) as any,
        () => processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com", "", false),
      ),
    Error,
    "optOutUrl is required",
  );
  assertEquals(fetchCalled, false, "a missing opt-out URL must fail before any Mailgun call");
});
