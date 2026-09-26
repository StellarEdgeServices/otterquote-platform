// gh-2069 — send-home-profile-prompt previously discarded Mailgun's message
// id and never wrote to `notifications`, the same defect #2069 found in
// send-homeowner-next-steps. These tests exercise processClaim() end to end
// against a fake Supabase client and a fake global fetch (this function has
// no injected-dependency layer of its own — see index.ts's own comment on
// ProcessClaimSupabase for why a structural fake is enough here).
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  HOME_PROFILE_PROMPT_TEMPLATE,
  insertNotification,
  processClaim,
  type NotificationClient,
  type NotificationRow,
  type ProcessClaimSupabase,
} from "./index.ts";

const CLAIM = {
  id: "c1111111-2222-3333-4444-555555555555",
  user_id: "u1111111-2222-3333-4444-555555555555",
  completion_date: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  property_address: "123 Main St",
  trades: ["roofing"],
  profile_prompt_sent_at: null,
};

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

Deno.test("gh-2069 — accepted Mailgun send writes ONE notifications row with delivered=true and the mailgun id", async () => {
  const { supabase, inserted, updated } = fakeSupabase({});
  const result = await withFakeFetch(
    // deno-lint-ignore no-explicit-any
    (() => Promise.resolve(new Response(JSON.stringify({ id: "<hp-msg-1@mail.otterquote.com>" }), { status: 200 }))) as any,
    () => processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com"),
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
  const result = await withFakeFetch(
    // deno-lint-ignore no-explicit-any
    (() => Promise.resolve(new Response("bad request", { status: 400 }))) as any,
    () => processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com"),
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
  const result = await processClaim(supabase, CLAIM, undefined, "https://otterquote.com");
  assertEquals(result.result, "sent");
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].delivered, true);
  assertEquals(inserted[0].mailgun_id, null);
});

Deno.test("already has a home profile: no send attempted, no notifications row", async () => {
  const { supabase, inserted } = fakeSupabase({ hasHomeProfile: true });
  const result = await processClaim(supabase, CLAIM, "fake-mailgun-key", "https://otterquote.com");
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
